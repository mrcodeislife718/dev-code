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
  async function run(extra = [], overrides = {}) {
    return new Promise((resolveResult) => {
      const child = spawn(process.execPath, [runner, '--once', ...extra], {
        cwd: root, env: { ...process.env, DEVCODE_BIN: shell,
          DEVCODE_PROJECT_DIR: root, OPENAI_BASE_URL: url,
          OPENAI_MODEL: 'test-local-model', DEVCODE_RETRY_MS: '1000',
          DEVCODE_HOME: join(root, '.devcode-home'), ...overrides },
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

test('owner-approved production deploy occurs only after real tests and build pass', async (t) => {
  const f = await setup(t);
  const first = await f.run();
  assert.equal(first.code, 0, first.output);
  const memory = join(f.root, '.devcode-factory');
  writeFileSync(join(memory, 'next-task.md'), 'STATUS: READY_FOR_PRODUCTION_CHECK\n');
  const commands = {
    DEVCODE_ALLOW_PRODUCTION_DEPLOY: '1',
    DEVCODE_TEST_COMMAND: "printf 'real-tests-pass\\n'",
    DEVCODE_BUILD_COMMAND: "printf 'real-build-pass\\n'",
    DEVCODE_DEPLOY_COMMAND: 'printf deployed >> .devcode-factory/deploy-count.txt',
    DEVCODE_VERIFY_COMMAND: 'test -f .devcode-factory/deploy-count.txt',
  };
  const finish = await f.run([], commands);
  assert.equal(finish.code, 0, finish.output);
  assert.match(finish.output, /VERIFIED its production deployment/);
  const state = JSON.parse(readFileSync(join(memory, 'state.json'), 'utf8'));
  assert.equal(state.production.status, 'verified-live');
  assert.ok(state.completed);
  assert.match(readFileSync(join(memory, 'release-proof.md'), 'utf8'), /Local checks: passed/);
  const again = await f.run([], commands);
  assert.equal(again.code, 0, again.output);
  assert.match(again.output, /already verified live/);
  assert.equal(readFileSync(join(memory, 'deploy-count.txt'), 'utf8'), 'deployed');
});

test('a failing check creates a repair task and never deploys', async (t) => {
  const f = await setup(t);
  assert.equal((await f.run()).code, 0);
  const memory = join(f.root, '.devcode-factory');
  writeFileSync(join(memory, 'next-task.md'), 'STATUS: READY_FOR_PRODUCTION_CHECK\n');
  const result = await f.run([], {
    DEVCODE_ALLOW_PRODUCTION_DEPLOY: '1',
    DEVCODE_TEST_COMMAND: 'exit 13',
    DEVCODE_BUILD_COMMAND: 'true',
    DEVCODE_DEPLOY_COMMAND: 'touch .devcode-factory/should-not-deploy',
    DEVCODE_VERIFY_COMMAND: 'true'
  });
  assert.equal(result.code, 0, result.output);
  assert.equal(existsSync(join(memory, 'should-not-deploy')), false);
  assert.match(readFileSync(join(memory, 'next-task.md'), 'utf8'), /WORK_IN_PROGRESS/);
  assert.match(readFileSync(join(memory, 'production-checks.log'), 'utf8'), /test exit 13/);
});

test('production is not deployed without explicit permission and real verification', async (t) => {
  const f = await setup(t);
  assert.equal((await f.run()).code, 0);
  const memory = join(f.root, '.devcode-factory');
  writeFileSync(join(memory, 'next-task.md'), 'STATUS: READY_FOR_PRODUCTION_CHECK\n');
  const result = await f.run([], {
    DEVCODE_TEST_COMMAND: 'true', DEVCODE_BUILD_COMMAND: 'true',
    DEVCODE_DEPLOY_COMMAND: 'touch .devcode-factory/should-not-deploy'
  });
  assert.equal(result.code, 0, result.output);
  assert.equal(existsSync(join(memory, 'should-not-deploy')), false);
  const state = JSON.parse(readFileSync(join(memory, 'state.json'), 'utf8'));
  assert.equal(state.production.status, 'ready-to-deploy');
});

test('failed live verification cannot repeatedly deploy unchanged code', async (t) => {
  const f = await setup(t);
  assert.equal((await f.run()).code, 0);
  const memory = join(f.root, '.devcode-factory');
  writeFileSync(join(memory, 'next-task.md'), 'STATUS: READY_FOR_PRODUCTION_CHECK\n');
  const commands = {
    DEVCODE_ALLOW_PRODUCTION_DEPLOY: '1',
    DEVCODE_TEST_COMMAND: 'true',
    DEVCODE_BUILD_COMMAND: 'true',
    DEVCODE_DEPLOY_COMMAND: 'echo deployed >> .devcode-factory/deploy-count.txt',
    DEVCODE_VERIFY_COMMAND: 'exit 9'
  };
  const first = await f.run([], commands);
  assert.equal(first.code, 0, first.output);
  assert.equal(readFileSync(join(memory, 'deploy-count.txt'), 'utf8').trim(), 'deployed');
  const second = await f.run([], commands);
  assert.equal(second.code, 0, second.output);
  assert.equal(readFileSync(join(memory, 'deploy-count.txt'), 'utf8').trim(), 'deployed');
  const state = JSON.parse(readFileSync(join(memory, 'state.json'), 'utf8'));
  assert.equal(state.production.status, 'verification-failed');
});
