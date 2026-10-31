#!/usr/bin/env node
/**
 * DevCode local-model end-to-end proof.
 * Makes a disposable Git project, asks the actual DevCode CLI + actual Ollama
 * model to repair a real source file, and independently verifies the result.
 * No network downloads, cloud providers, existing project edits or deploys.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWriteStream } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const model = process.env.DEVCODE_MODEL || process.env.OPENAI_MODEL || 'devcode-coder:8k';
const base = process.env.OPENAI_BASE_URL || 'http://127.0.0.1:11434/v1';
const timeoutMs = Number(process.env.DEVCODE_PROOF_TIMEOUT_MS || 720000);
const workspace = mkdtempSync(join(tmpdir(), 'devcode-local-proof-'));
const logs = join(homedir(), '.config', 'devcode');
mkdirSync(logs, { recursive: true, mode: 0o700 });
const logFile = join(logs, 'local-proof-last.log');
const log = createWriteStream(logFile, { flags: 'w', mode: 0o600 });
let child = null;
let terminated = false;
function stop(signal = 'SIGTERM') {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch {} }
}
function localUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.pathname.replace(/\/$/, '').endsWith('/v1') ||
      url.username || url.password) {
    throw Error('Only a local Ollama endpoint ending in /v1 is allowed.');
  }
  return url.origin + '/v1';
}
function git(...args) {
  const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) throw Error('Git fixture setup: ' + (result.stderr || result.error?.message));
}
async function main() {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 60000 || timeoutMs > 1800000)
    throw Error('Invalid proof timeout (60000-1800000 milliseconds).');
  const url = localUrl(base);
  console.log('DevCode E2E proof: local model ' + model);
  console.log('Working only in a disposable test folder; no production projects are touched.');
  const response = await fetch(url + '/models', { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw Error('Local Ollama model endpoint returned HTTP ' + response.status);
  const models = await response.json();
  if (!models.data?.some((item) => item.id === model))
    throw Error('The selected model is not registered in Ollama: ' + model + '. Use ollama list.');
  writeFileSync(join(workspace, 'package.json'), '{"type":"module","scripts":{"test":"node --test add.test.mjs"}}\n');
  const originalSource = 'export function add(a, b) {\n  return a - b; // BUG: change to addition\n}\n';
  writeFileSync(join(workspace, 'add.js'), originalSource);
  writeFileSync(join(workspace, 'add.test.mjs'),
    "import { test } from 'node:test';\nimport { strict as assert } from 'node:assert';\nimport { add } from './add.js';\ntest('addition', () => assert.equal(add(2, 3), 5));\n");
  git('init', '-q');
  git('config', 'user.name', 'DevCode Local Proof');
  git('config', 'user.email', 'devcode-proof@example.invalid');
  git('add', 'package.json', 'add.js', 'add.test.mjs');
  git('commit', '-qm', 'Temporary test fixture');
  const prompt = [
    'You are proving that the LOCAL DevCode coding agent can use its file editing tools.',
    'Read add.js and add.test.mjs in the CURRENT directory.',
    'Fix the existing bug in add.js: add(2,3) must equal 5, not -1.',
    'USE your actual edit/write tool to change add.js. Do not merely describe a fix.',
    'Do not use a shell tool; the independent checker will run the test after your edit.',
    'Do not touch files outside this disposable directory. Do not install packages,',
    'download anything, change Git branches, or edit user settings.',
    'Keep the response short.'
  ].join(' ');
  const args = [
    join(root, 'scripts', 'dev.js'),
    '--auth-type', 'openai', '--model', model,
    '--approval-mode', 'auto-edit',
    '--max-wall-time', '10m',
    '--max-tool-calls', '25',
    '--max-session-turns', '12',
    '-p', prompt, '--output-format', 'stream-json'
  ];
  const env = { ...process.env, OPENAI_BASE_URL: url, OPENAI_API_KEY: 'local-only', OPENAI_MODEL: model };
  // Never give a test worker inherited deployment credentials.
  for (const key of Object.keys(env)) {
    if (/(TOKEN|PASSWORD|SECRET|PRIVATE_KEY|CREDENTIAL|ACCESS_KEY|DEPLOY_KEY|AUTHORIZATION)/i.test(key) ||
        /^(DATABASE_URL|POSTGRES_URL|REDIS_URL|MYSQL_URL|MONGODB_URI)$/i.test(key)) delete env[key];
  }
  console.log('Starting real CLI file-edit run; a separate checker will verify the test.');
  const began = Date.now();
  let stdoutBytes = 0, stderrBytes = 0, events = 0, details = '';
  let pending = '';
  const exitCode = await new Promise((done) => {
    child = spawn(process.execPath, args, { cwd: workspace, env, detached: true, stdio: ['ignore','pipe','pipe'] });
    const capture = (buffer, stderr) => {
      const chunk = buffer.toString();
      log.write(chunk);
      details = (details + chunk).slice(-3500);
      if (stderr) stderrBytes += buffer.length;
      else {
        stdoutBytes += buffer.length;
        pending = (pending + chunk).slice(-32768);
        const last = pending.lastIndexOf('\n');
        if (last >= 0) {
          for (const line of pending.slice(0,last).split('\n').slice(-50)) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.type === 'tool_use' || parsed.type === 'tool_result' ||
                  parsed.type === 'tool_call' || parsed.type === 'tool') events++;
            } catch {}
          }
          pending = pending.slice(last+1);
        }
      }
    };
    child.stdout.on('data', (d) => capture(d, false));
    child.stderr.on('data', (d) => capture(d, true));
    const timer = setTimeout(() => {
      terminated = true;
      console.error('Proof timed out: stopping the disposable CLI session.');
      stop();
      setTimeout(() => stop('SIGKILL'), 10000).unref();
    }, timeoutMs);
    const heartbeat = setInterval(() => {
      console.log('Proof activity: ' + Math.floor((Date.now()-began)/1000) +
        's, stdout=' + stdoutBytes + 'B, stderr=' + stderrBytes + 'B, tool events=' + events);
    }, 60000);
    heartbeat.unref();
    let complete = false;
    const finish = (code) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      child = null;
      done(code);
    };
    child.on('error', (error) => { details += '\n' + error.message; finish(1); });
    child.on('close', (code) => finish(code ?? 1));
  });
  const changed = readFileSync(join(workspace, 'add.js'), 'utf8');
  const test = spawnSync(process.execPath, ['--test','add.test.mjs'], {
    cwd: workspace, encoding: 'utf8', timeout: 15000
  });
  log.write('\n=== INDEPENDENT TEST ===\n' + (test.stdout || '') + (test.stderr || ''));
  const edited = changed !== originalSource;
  const passed = exitCode === 0 && !terminated && edited && test.status === 0;
  console.log('CLI exit=' + exitCode + '; tool events=' + events + '; code edited=' +
    String(edited) + '; independent test=' + (test.status === 0 ? 'PASS' : 'FAIL'));
  if (passed) {
    console.log('PASS: real ' + model + ' → DevCode edit tool → file modification → passing Node test.');
  } else {
    console.error('FAIL: end-to-end coding is NOT proven. Do not restart the autonomous factory.');
    console.error('Recent model output (isolated test only):\n' + details.slice(-2000));
    console.error('Full local log: ' + logFile);
    process.exitCode = 1;
  }
}
try { await main(); }
catch (error) { console.error('DevCode local proof failed: ' + error.message); process.exitCode = 1; }
finally {
  if (child) stop();
  await new Promise((ok) => log.end(ok));
  rmSync(workspace, { force: true, recursive: true });
}
