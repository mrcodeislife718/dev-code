import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const runner = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'devcode-project-continuity.mjs');

async function setup(t, { changes = true, transientOffline = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'devcode-project-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function git(...args) {
    const p = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(p.status, 0, p.stderr);
  }
  git('init', '-q');
  git('checkout', '-b', 'working');
  git('config', 'user.name', 'Factory Test');
  git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, 'app.js'), '// Project exists. Do not rebuild it.\n');
  git('add', 'app.js');
  git('commit', '-qm', 'existing product');
  const shell = join(root, 'mock-devcode.sh');
  writeFileSync(shell, [
    '#!/bin/sh',
    'printf "%s\\n" "$@" > .devcode-factory/last-args.txt',
    ...(changes ? ['printf "continued work\\n" >> app.js'] : []),
    'printf \'{"type":"system","session_id":"model-fake"}\\n\'',
    ''
  ].join('\n'));
  chmodSync(shell, 0o755);

  let healthRequests = 0;
  const server = createServer((req, res) => {
    healthRequests++;
    if (transientOffline && healthRequests === 1) {
      res.writeHead(503); res.end('offline once'); return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'test-local-model' }] }));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => server.close());
  const url = 'http://127.0.0.1:' + server.address().port + '/v1';
  async function run(extra = []) {
    return new Promise((resolveResult) => {
      const child = spawn(process.execPath, [runner, '--once', ...extra], {
        cwd: root, env: { ...process.env, DEVCODE_BIN: shell,
          DEVCODE_PROJECT_DIR: root, OPENAI_BASE_URL: url,
          OPENAI_MODEL: 'test-local-model', DEVCODE_RETRY_MS: '1000' },
      });
      let output = '';
      child.stdout.on('data', (d) => { output += d; });
      child.stderr.on('data', (d) => { output += d; });
      child.on('close', (code) => resolveResult({ code, output }));
      child.on('error', (error) => resolveResult({ code: 1, output: error.message }));
    });
  }
  return { root, run, getRequests: () => healthRequests };
}

test('existing product continues across new model conversations and process restarts', async (t) => {
  const f = await setup(t);
  for (let i = 0; i < 3; i++) {
    const r = await f.run();
    assert.equal(r.code, 0, r.output);
  }
  const memory = join(f.root, '.devcode-factory');
  const state = JSON.parse(readFileSync(join(memory, 'state.json'), 'utf8'));
  assert.equal(state.rounds, 3);
  assert.equal(state.stalls, 0);
  assert.match(readFileSync(join(f.root, 'app.js'), 'utf8'), /continued work/);
  assert.equal(readFileSync(join(f.root, 'app.js'), 'utf8').match(/continued work/g).length, 3);
  assert.match(readFileSync(join(memory, 'START-HERE.md'), 'utf8'), /DO NOT RESTART/);
  assert.match(readFileSync(join(memory, 'mission.md'), 'utf8'), /existing project/);
  assert.doesNotMatch(readFileSync(join(memory, 'last-args.txt'), 'utf8'), /--resume/);
});

test('no progress is recorded but does not impose a request quota or force a restart', async (t) => {
  const f = await setup(t, { changes: false });
  for (let i = 0; i < 5; i++) {
    const r = await f.run();
    assert.equal(r.code, 0, r.output);
  }
  const state = JSON.parse(readFileSync(join(f.root, '.devcode-factory', 'state.json'), 'utf8'));
  assert.equal(state.rounds, 5);
});

test('temporary local model outage is retried without resetting project', async (t) => {
  const f = await setup(t, { transientOffline: true });
  const r = await f.run();
  assert.equal(r.code, 0, r.output);
  assert.ok(f.getRequests() >= 2, r.output);
  assert.match(r.output, /Local AI unavailable/);
});

test('a verified dead runner can be recovered without erasing progress', async (t) => {
  const f = await setup(t);
  const memory = join(f.root, '.devcode-factory');
  mkdirSync(memory);
  writeFileSync(join(memory, 'runner.lock'), JSON.stringify({ pid: 999999991 }));
  const r = await f.run();
  assert.equal(r.code, 0, r.output);
  assert.equal(existsSync(join(memory, 'runner.lock')), false);
});
