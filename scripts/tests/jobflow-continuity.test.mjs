import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PREFERRED_FREE_MODELS, isEligibleModel, chooseFreeModel,
  cloudFailureType, readFreeRemaining, readFreeCatalog,
} from '../openrouter-free-capacity.mjs';

const runner = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'jobflow-completion-runner.mjs');
const model = 'local-30b:test';

async function fixture(t, { changes = true, unavailableOnce = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jobflow-continuity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q');
  git('config', 'user.name', 'Factory Test');
  git('config', 'user.email', 'factory@example.invalid');
  git('checkout', '-b', 'jobflow-completion');
  writeFileSync(join(root, 'README.md'), 'Existing product, preserve work.\n');
  git('add', '.');
  git('commit', '-qm', 'Initial existing work');
  const bin = join(root, 'fake-devcode.sh');
  const script = '#!/bin/sh\n' +
    'printf "%s\\n" "$@" > .jobflow-factory/last-args.txt\n' +
    (changes ? 'printf "tested change\\n" >> .jobflow-factory/progress.md\n' : '') +
    'printf \'{"type":"system","session_id":"mock-session"}\\n\'\n';
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    if (unavailableOnce && calls === 1) {
      res.writeHead(503); res.end('temporary outage'); return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: model }] }));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => server.close());
  const port = server.address().port;
  async function run(extra = []) {
    return await new Promise((done) => {
      const child = spawn(process.execPath, [runner, '--once', ...extra], {
        cwd: root,
        env: {
          ...process.env,
          JOBFLOW_DIR: root, DEVCODE_BIN: bin, OPENAI_MODEL: model,
          OPENAI_BASE_URL: 'http://127.0.0.1:' + port + '/v1',
          JOBFLOW_RETRY_DELAY_MS: '1000', JOBFLOW_MAX_BACKOFF_MS: '1000',
        }
      });
      let output = '';
      child.stdout.on('data', (b) => { output += b; });
      child.stderr.on('data', (b) => { output += b; });
      child.on('error', (err) => done({ code: -1, output: String(err) }));
      child.on('close', (code) => done({ code, output }));
    });
  }
  return { root, run, getRequests: () => calls };
}

test('context rotates each cycle and project memory survives restart', async (t) => {
  const f = await fixture(t);
  const a = await f.run();
  assert.equal(a.code, 0, a.output);
  const b = await f.run();
  assert.equal(b.code, 0, b.output);
  const workspace = join(f.root, '.jobflow-factory');
  const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'));
  const args = readFileSync(join(workspace, 'last-args.txt'), 'utf8');
  const context = readFileSync(join(workspace, 'continuity.md'), 'utf8');
  const progress = readFileSync(join(workspace, 'progress.md'), 'utf8');
  assert.equal(state.cycle, 2);
  assert.equal(state.noProgress, 0);
  assert.ok(!args.includes('--resume'), 'fresh context was requested');
  assert.match(context, /DevCode continuity index/);
  assert.match(context, /progress\.md/);
  assert.match(progress, /tested change/);
});

test('no-progress rounds trigger recovery, not an artificial stop', async (t) => {
  const f = await fixture(t, { changes: false });
  for (let i = 0; i < 4; i++) {
    const outcome = await f.run();
    assert.equal(outcome.code, 0, outcome.output);
  }
  const state = JSON.parse(readFileSync(join(f.root, '.jobflow-factory', 'state.json'), 'utf8'));
  assert.equal(state.cycle, 4);
  assert.equal(state.noProgress, 4);
});

test('a temporary local model outage is retried', async (t) => {
  const f = await fixture(t, { unavailableOnce: true });
  const result = await f.run();
  assert.equal(result.code, 0, result.output);
  assert.ok(f.getRequests() >= 2, result.output);
  assert.match(result.output, /temporarily unavailable/);
});

test('cloud catalog only accepts zero-priced text models that support tools', async () => {
  const candidate = (id) => ({
    id, pricing: { prompt: '0', completion: '0' },
    architecture: { output_modalities: ['text'] },
    supported_parameters: ['tools']
  });
  const entries = PREFERRED_FREE_MODELS.map(candidate);
  const paid = { ...candidate(PREFERRED_FREE_MODELS[0]), pricing: { prompt: '0.001', completion: '0' } };
  const missingTools = { ...candidate(PREFERRED_FREE_MODELS[1]), supported_parameters: [] };
  assert.equal(isEligibleModel(paid), false);
  assert.equal(isEligibleModel(missingTools), false);
  const fakeFetch = async () => ({ ok: true, json: async () => ({ data: [...entries, paid, missingTools] }) });
  const actual = await readFreeCatalog(fakeFetch);
  assert.deepEqual(actual, PREFERRED_FREE_MODELS);
  assert.equal(chooseFreeModel(actual, actual[0]), actual[1]);
});

test('shared quota parser and 429 handling return safely to local', () => {
  assert.equal(readFreeRemaining({ data: { free_model_daily_requests: { remaining: 9 } } }), 9);
  assert.equal(readFreeRemaining({ data: {} }), null);
  assert.equal(cloudFailureType('HTTP 429: rate limit exceeded', 1), 'quota');
  assert.equal(cloudFailureType('HTTP 402: payment required', 1), 'billing');
});
