#!/usr/bin/env node
/**
 * DevCode project continuity: a reusable supervisor for ANY existing Git project.
 *
 * Keeps the project itself, permanent instructions, progress and evidence on disk.
 * Every coding round gets a fresh model conversation and resumes the EXISTING
 * project from its checkpoint instead of recreating it. No request/round cap.
 *
 * Usage:
 *   DEVCODE_PROJECT_DIR=/path/to/existing-project \
 *   OPENAI_MODEL=your-local-model \
 *   OPENAI_BASE_URL=http://127.0.0.1:11434/v1 \
 *     node scripts/devcode-project-continuity.mjs --check
 *   ... same environment ... node scripts/devcode-project-continuity.mjs
 *
 * Optional DEVCODE_BIN points to a preinstalled DevCode executable;
 * otherwise uses this checkout's scripts/dev.js.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, statSync, appendFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { homedir } from 'node:os';

const devcode = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = resolve(process.env.DEVCODE_PROJECT_DIR || process.cwd());
const memory = join(project, '.devcode-factory');
const lockPath = join(memory, 'runner.lock');
const statePath = join(memory, 'state.json');
const historyPath = join(memory, 'history.jsonl');
const sharedHome = resolve(process.env.DEVCODE_HOME || join(homedir(), '.devcode'));
const workerLockPath = join(sharedHome, 'engineering-worker.lock');
const check = process.argv.includes('--check');
const once = process.argv.includes('--once');
const model = process.env.OPENAI_MODEL || '';
const base = process.env.OPENAI_BASE_URL || 'http://127.0.0.1:11434/v1';
const delay = Number(process.env.DEVCODE_RETRY_MS || 10000);
const maxDelay = 300000;
const sessionWallTime = process.env.DEVCODE_SESSION_WALL_TIME || '45m';
const bootId = (() => { try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return ''; } })();
let running = true;
let active = null;

function atomic(file, data) {
  const tmp = file + '.tmp-' + process.pid;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}
function exec(command, args) {
  const r = spawnSync(command, args, { cwd: project, encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0 || r.error) throw Error(r.error?.message || r.stderr?.trim() || command + ' failed');
  return r.stdout.trim();
}
function localAddress(value) {
  const u = new URL(value);
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const privateNetwork = h === 'localhost' || h === '::1' ||
    (isIP(h) === 4 && (h.startsWith('127.') || h.startsWith('10.') ||
      h.startsWith('192.168.') || (/^172\.(1[6-9]|2\d|3[01])\./.test(h))));
  if (!privateNetwork || !['http:', 'https:'].includes(u.protocol) || u.username || u.password)
    throw Error('This always-on runner requires a private local model address, not a paid provider.');
  if (!u.pathname.endsWith('/v1') && !u.pathname.endsWith('/v1/'))
    throw Error('Use the local model server address ending in /v1');
  return u.href.replace(/\/$/, '');
}
function pause(ms) { return new Promise((ok) => setTimeout(ok, ms)); }
function backoff(streak) { return Math.min(maxDelay, delay * 2 ** Math.min(7, Math.max(0, streak - 1))); }
function gitStatus() { return exec('git', ['status', '--porcelain', '--untracked-files=normal']); }
function hashWork() {
  const commit = exec('git', ['rev-parse', 'HEAD']);
  const tracked = exec('git', ['diff', '--no-ext-diff', '--binary', 'HEAD']);
  const extras = exec('git', ['ls-files', '--others', '--exclude-standard'])
    .split('\n').filter(Boolean)
    .filter((f) => !f.startsWith('.devcode-factory/'))
    .map((f) => {
      try { const st = statSync(join(project, f)); return [f, st.size, st.mtimeMs]; }
      catch { return [f, 'missing']; }
    });
  return createHash('sha256').update(JSON.stringify([commit, tracked, extras])).digest('hex');
}
function file(name) { return join(memory, name); }
function read(name) { return readFileSync(file(name), 'utf8'); }
function initialFiles() {
  mkdirSync(memory, { recursive: true, mode: 0o700 });
  const records = {
    '.gitignore': '*\n!.gitignore\n',
    'mission.md': '# Your existing project\n\nDescribe the finished product you want here. Do not start again: inspect the existing repository first.\n',
    'progress.md': '# Work in progress\n\nNo completed work has been independently verified by this runner. Inspect the existing code and history.\n',
    'next-task.md': '# Exact next step\n\nInspect the actual repository and choose the next unfinished requirement.\n',
    'decisions.md': '# Important decisions\n\nPreserve architectural choices and reasons here.\n',
    'evidence.md': '# Verified tests and acceptance\n\nRecord commands, dates, results and remaining failures. Never invent proof.\n',
    'blockers.md': '# Missing permissions and external obstacles\n\nContinue other useful tasks when one task is blocked.\n',
  };
  for (const [name, content] of Object.entries(records)) {
    if (!existsSync(file(name))) writeFileSync(file(name), content, { flag: 'wx', mode: 0o600 });
  }
}
function writeIndex(state) {
  // A short, navigational page for each fresh model conversation.
  // The underlying code, ledgers and full history remain untruncated.
  const index = [
    '# CONTINUE THIS EXISTING PROJECT — DO NOT RESTART IT',
    'Project: ' + project,
    'Git branch: ' + state.branch,
    'Completed coding rounds: ' + state.rounds,
    'Last outcome: ' + (state.last?.exit ?? 'not started'),
    ...(state.active ? [
      'RECOVERY: previous work was interrupted before the last checkpoint.',
      'Inspect actual project changes and tests before repeating the unfinished task.'
    ] : []),
    '',
    'Read in this order:',
    '1. .devcode-factory/mission.md (what the project must achieve)',
    '2. .devcode-factory/next-task.md (the exact unfinished task)',
    '3. .devcode-factory/progress.md (implemented parts and current progress)',
    '4. .devcode-factory/decisions.md, evidence.md, blockers.md (as needed)',
    '5. Real project files and git history (the source of truth)',
    '',
    'Inspect code and tests before making changes. Preserve existing work.',
    'Before the conversation ends, UPDATE next-task.md and progress.md',
    'with precise paths, failing tests, decisions and the next action.',
    'Never claim production readiness without real verification.',
    'When all required features are implemented, tested, and documented,',
    'write STATUS: READY_FOR_PRODUCTION_CHECK in next-task.md.',
    'The DevCode supervisor then runs independent production checks,',
    'deploys only through the owner-configured command, and verifies the live result.',
    'Do not run deployment commands yourself, push, erase work, pay providers, or leak secrets.',
    '',
    'Current Git status:',
    gitStatus().slice(0, 10000) || '(clean)',
    ''
  ].join('\n');
  atomic(file('START-HERE.md'), index);
}
function acquire() {
  let owner = null;
  if (existsSync(lockPath)) {
    try { owner = JSON.parse(readFileSync(lockPath, 'utf8')); }
    catch { throw Error('Runner lock is unreadable; review it before attempting recovery.'); }
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw Error('Runner lock is invalid.');
    if (owner.bootId && bootId && owner.bootId !== bootId) {
      unlinkSync(lockPath);
    } else try { process.kill(owner.pid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') unlinkSync(lockPath);
      else throw error;
    }
    if (existsSync(lockPath)) throw Error('Another factory is already running in this project.');
  }
  const fd = openSync(lockPath, 'wx', 0o600);
  writeFileSync(fd, JSON.stringify({ pid: process.pid, project, bootId, started: new Date().toISOString() }));
  closeSync(fd);
}
// Only one local 30B coding session at once across all projects. The other
// projects wait, keeping their place. This prevents accidental RAM overload.
async function reserveWorker() {
  mkdirSync(sharedHome, { recursive: true, mode: 0o700 });
  while (running) {
    try {
      const fd = openSync(workerLockPath, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, bootId, project }));
      closeSync(fd);
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    try {
      const owner = JSON.parse(readFileSync(workerLockPath, 'utf8'));
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) {
        throw Error('Shared DevCode worker lock is invalid; do not overwrite it.');
      }
      if (owner.bootId && bootId && owner.bootId !== bootId) {
        unlinkSync(workerLockPath);
        continue;
      }
      try { process.kill(owner.pid, 0); }
      catch (error) {
        if (error.code !== 'ESRCH') throw error;
        unlinkSync(workerLockPath);
        continue;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        if (!(error instanceof SyntaxError)) throw error;
        throw Error('Shared DevCode worker lock is unreadable; inspect before recovery.');
      }
    }
    await pause(2000);
  }
  return false;
}
function freeWorker() {
  try {
    const owner = JSON.parse(readFileSync(workerLockPath, 'utf8'));
    if (owner.pid === process.pid && owner.project === project) unlinkSync(workerLockPath);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Worker lock release needs review: ' + error.message);
  }
}

function stop() { running = false; if (active) active.kill('SIGTERM'); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
async function healthy(url) {
  try {
    const r = await fetch(url + '/models', { signal: AbortSignal.timeout(7000) });
    if (!r.ok) return false;
    const json = await r.json();
    return json.data?.some((m) => m.id === model) === true;
  } catch { return false; }
}
function spawnRound(binary, args, url) {
  return new Promise((done) => {
    let out = '', err = '', resolved = false;
    const child = spawn(binary, args, {
      cwd: project, env: {
        ...process.env, OPENAI_BASE_URL: url,
        OPENAI_MODEL: model, OPENAI_API_KEY: 'local-only'
      }, stdio: ['ignore', 'pipe', 'pipe']
    });
    active = child;
    child.stdout.on('data', (part) => { out = (out + part.toString()).slice(-120000); });
    child.stderr.on('data', (part) => { err = (err + part.toString()).slice(-120000); });
    const finish = (exit) => {
      if (resolved) return;
      resolved = true; active = null;
      done({ exit, out, err });
    };
    child.on('error', (error) => finish(1));
    child.on('close', (code) => finish(code ?? 1));
  });
}
// DevCode cannot call a project finished merely because a model says so.
// Project-specific commands are supplied by the OWNER, never invented by AI.
function readyForProduction() {
  return /^STATUS:\s*READY_FOR_PRODUCTION_CHECK\s*$/im.test(read('next-task.md'));
}
function ownerCommands() {
  let scripts = {};
  try {
    const pack = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
    scripts = pack.scripts && typeof pack.scripts === 'object' ? pack.scripts : {};
  } catch { /* Other languages can use explicitly configured commands. */ }
  const pick = (owner, script) => process.env[owner] ||
    (Object.prototype.hasOwnProperty.call(scripts, script) ? 'npm run ' + script : '');
  return {
    checks: [
      ['typecheck', pick('DEVCODE_TYPECHECK_COMMAND', 'typecheck'), false],
      ['lint', pick('DEVCODE_LINT_COMMAND', 'lint'), false],
      ['test', pick('DEVCODE_TEST_COMMAND', 'test'), true],
      ['build', pick('DEVCODE_BUILD_COMMAND', 'build'), true],
    ],
    deploy: process.env.DEVCODE_DEPLOY_COMMAND || '',
    verify: process.env.DEVCODE_VERIFY_COMMAND || '',
    permitted: process.env.DEVCODE_ALLOW_PRODUCTION_DEPLOY === '1'
  };
}
function recordRelease(state, update) {
  state.production = { ...(state.production || {}), ...update, at: new Date().toISOString() };
  atomic(statePath, JSON.stringify(state, null, 2) + '\n');
}
function releaseLog(message) {
  let safe = String(message);
  for (const [name, value] of Object.entries(process.env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(name) &&
        typeof value === 'string' && value.length >= 8)
      safe = safe.split(value).join('[PRIVATE]');
  }
  appendFileSync(file('production-checks.log'),
    new Date().toISOString() + ' ' + safe.slice(-4000) + '\n',
    { mode: 0o600 });
}
function changeBackToRepair(message) {
  const original = read('next-task.md').replace(
    /^STATUS:\s*READY_FOR_PRODUCTION_CHECK\s*$/im, 'STATUS: WORK_IN_PROGRESS');
  atomic(file('next-task.md'), original + '\n\nFix before production: ' + message + '\n');
  releaseLog('Repair required: ' + message);
}
function shellStep(title, command, minutes = 20) {
  return new Promise((finish) => {
    let output = '', settled = false;
    const child = spawn('/bin/sh', ['-lc', command], {
      cwd: project, detached: true, env: { ...process.env, CI: 'true' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    active = child;
    const capture = (buf) => { output = (output + buf.toString()).slice(-8000); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already closed */ }
    }, minutes * 60000);
    const done = (code, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      active = null;
      finish({ ok: code === 0, code, output, reason });
    };
    child.on('error', (error) => done(1, error.message));
    child.on('close', (code, signal) => done(code ?? 1, signal || ''));
  });
}
async function verifyLive(state, fingerprint, commands) {
  recordRelease(state, { fingerprint, status: 'verifying' });
  const result = await shellStep('live verification', commands.verify);
  releaseLog('Production verification exit ' + result.code + ': ' + result.output);
  if (!result.ok) {
    recordRelease(state, { fingerprint, status: 'verification-failed' });
    console.error('Deployment exists, but the live checks failed. Will re-check, NOT blindly redeploy.');
    return 'blocked';
  }
  // Even a successful HTTP response alone is not enough. The owner-supplied
  // verification command must test the behavior that matters for this project.
  const proof = [
    '# Verified DevCode production release',
    'Time: ' + new Date().toISOString(),
    'Project: ' + project,
    'Branch: ' + state.branch,
    'Code fingerprint: ' + fingerprint,
    'Local checks: passed',
    'Deployment command: completed (or inspected after an interrupted attempt)',
    'Live verification command: passed',
    'Verification output:',
    result.output.slice(-3500),
    ''
  ].join('\n');
  atomic(file('release-proof.md'), proof);
  state.completed = { at: new Date().toISOString(), fingerprint };
  recordRelease(state, { fingerprint, status: 'verified-live' });
  console.log('DevCode finished this project and VERIFIED its production deployment.');
  return 'done';
}
async function productionGate(state) {
  const fingerprint = hashWork();
  const commands = ownerCommands();
  const missing = commands.checks.filter((entry) => entry[2] && !entry[1]).map((entry) => entry[0]);
  if (missing.length) {
    changeBackToRepair('No real ' + missing.join(' and ') + ' command exists. ' +
      'Add an existing project script or configure its DEVCODE_*_COMMAND.');
    return 'repair';
  }
  const previous = state.production || {};
  if (previous.fingerprint === fingerprint &&
      ['deployment-failed', 'ambiguous-deployment'].includes(previous.status)) {
    console.error('Previous deployment needs review; no blind second deployment of identical code.');
    return 'blocked';
  }
  if (previous.fingerprint === fingerprint && previous.status === 'started-deploy') {
    // A power loss may have occurred AFTER the production service accepted
    // the deployment. Verify first; NEVER issue an automatic duplicate deploy.
    if (!commands.verify) return 'blocked';
    const check = await shellStep('recover deployment', commands.verify);
    releaseLog('Recovery verification exit ' + check.code + ': ' + check.output);
    if (!check.ok) {
      recordRelease(state, { status: 'ambiguous-deployment', fingerprint });
      console.error('Interrupted deploy status is unknown. Review production before retrying.');
      return 'blocked';
    }
    return verifyLive(state, fingerprint, commands);
  }
  if (previous.fingerprint === fingerprint &&
      ['deployed', 'verification-failed', 'verifying'].includes(previous.status)) {
    if (!commands.verify) return 'blocked';
    return verifyLive(state, fingerprint, commands);
  }
  recordRelease(state, { fingerprint, status: 'checking' });
  for (const [name, command] of commands.checks) {
    if (!command) continue;
    console.log('DevCode production check: ' + name);
    const result = await shellStep(name, command);
    releaseLog(name + ' exit ' + result.code + ': ' + result.output);
    if (!result.ok || !running) {
      recordRelease(state, { fingerprint, status: 'checks-failed', failedStep: name });
      changeBackToRepair(name + ' failed. See .devcode-factory/production-checks.log.');
      return 'repair';
    }
  }
  recordRelease(state, { fingerprint, status: 'checks-passed' });
  // The code must still match what was tested.
  if (fingerprint !== hashWork()) {
    changeBackToRepair('Source changed during production checks; check the latest work and retry.');
    return 'repair';
  }
  if (!commands.permitted || !commands.deploy || !commands.verify) {
    recordRelease(state, { fingerprint, status: 'ready-to-deploy' });
    console.error('Production tests passed. Deployment requires an approved deploy command and live verification command.');
    return 'blocked';
  }
  // Explicit approval means owner configured a real target AND its existing
  // deployment + live test commands. No cloud model may invent that permission.
  recordRelease(state, { fingerprint, status: 'started-deploy' });
  releaseLog('Starting owner-approved deployment (command text withheld from log).');
  const deployed = await shellStep('production deployment', commands.deploy, 30);
  releaseLog('Deploy exit ' + deployed.code + ': ' + deployed.output);
  if (!deployed.ok || !running) {
    recordRelease(state, { fingerprint, status: 'deployment-failed' });
    console.error('Deployment failed. Saved exact failure; no blind automatic redeploy.');
    return 'blocked';
  }
  recordRelease(state, { fingerprint, status: 'deployed' });
  return verifyLive(state, fingerprint, commands);
}

async function main() {
  if (!model) throw Error('Set OPENAI_MODEL to your existing local model name.');
  const url = localAddress(base);
  if (!Number.isSafeInteger(delay) || delay < 1000) throw Error('Invalid retry interval.');
  if (!existsSync(join(project, '.git'))) throw Error('Choose the root of an existing Git project: ' + project);
  if (resolve(exec('git', ['rev-parse', '--show-toplevel'])) !== project) throw Error('Use the root of your existing project.');
  const branch = exec('git', ['branch', '--show-current']);
  if (!branch) throw Error('Detached Git branch: use a normal working branch for continuity.');
  const bin = process.env.DEVCODE_BIN || process.execPath;
  const prefix = process.env.DEVCODE_BIN ? [] : [join(devcode, 'scripts', 'dev.js')];
  if (!process.env.DEVCODE_BIN && !existsSync(prefix[0])) throw Error('The DevCode entry file is missing.');
  if (check) {
    console.log('Project: ' + project + '\nBranch: ' + branch + '\nLocal model: ' + model);
    if (!await healthy(url)) throw Error('Your model is not currently responding on ' + url);
    console.log('Model online; existing project preserved.');
    return;
  }
  initialFiles();
  acquire();
  try {
    let state = { rounds: 0, stalls: 0, branch, started: new Date().toISOString() };
    if (existsSync(statePath)) {
      const old = JSON.parse(readFileSync(statePath, 'utf8'));
      if (old.branch !== branch) throw Error('Project branch changed since the last checkpoint. Review saved state first.');
      state = { ...state, ...old };
    }
    if (state.completed) {
      console.log('This project was already verified live. DevCode will not restart or redeploy it.');
      return;
    }
    let errors = 0;
    while (running) {
      if (!await healthy(url)) {
        errors++;
        console.error('Local AI unavailable, preserving project. Retry after ' + backoff(errors) / 1000 + 's.');
        await pause(backoff(errors));
        continue;
      }
      errors = 0;
      const gotWorker = await reserveWorker();
      if (!gotWorker) break;
      if (readyForProduction()) {
        let outcome;
        try { outcome = await productionGate(state); }
        finally { freeWorker(); }
        if (outcome === 'done') break;
        if (once || !running) break;
        if (outcome === 'blocked') { await pause(60000); continue; }
        // Failed checks become the NEXT repair task. The same project resumes.
        await pause(delay);
        continue;
      }
      const interrupted = Boolean(state.active);
      const before = hashWork();
      state.active = { started: new Date().toISOString(), before, branch };
      atomic(statePath, JSON.stringify(state, null, 2) + '\n');
      // Show recovery only when the PREVIOUS process left work unfinished.
      writeIndex({ ...state, active: interrupted ? state.active : null });
      const prompt = [
        'CONTINUE the EXISTING software project. Do not start over.',
        ...(interrupted ? [
          'RECOVERY: previous work was interrupted; inspect existing unfinished changes first.'
        ] : []),
        'FIRST read .devcode-factory/START-HERE.md and mission.md.',
        'Read next-task.md and progress.md and inspect actual code.',
        'Implement exactly the next unfinished meaningful task.',
        'Your goal is end-to-end completion: complete features, fix defects,',
        'add missing tests, verify production security and configuration,',
        'and prepare existing scripts for a real production release.',
        'Run the related tests, repair failures, and record evidence.',
        'Before finishing UPDATE next-task.md and progress.md with',
        'the exact next action, code changes, errors and test results.',
        'You may get a fresh conversation after this round; the saved',
        'project records are the continuing memory.',
        'Never claim a product is ready based on a summary or a changed file.',
        'When all requirements and related tests are complete, write',
        'STATUS: READY_FOR_PRODUCTION_CHECK on its own line in next-task.md.',
        'DevCode will independently test, deploy and verify the finished project.',
        'Do not run deployment commands yourself, push, destroy work, spend money, or leak secrets.'
      ].join(' ');
      let result;
      try {
        result = await spawnRound(bin, [
          ...prefix,
          '--auth-type', 'openai',
          '--model', model, '--fallback-model', model,
          '--approval-mode', 'auto', '--max-wall-time', sessionWallTime,
          '-p', prompt, '--output-format', 'stream-json'
        ], url);
      } finally {
        freeWorker();
      }
      const workChanged = before !== hashWork();
      state = {
        ...state, rounds: state.rounds + 1, branch, active: null,
        stalls: workChanged ? 0 : state.stalls + 1,
        last: {
          at: new Date().toISOString(), exit: result.exit,
          workChanged, details: (result.err || result.out).slice(-1200)
        }
      };
      appendFileSync(historyPath, JSON.stringify(state.last) + '\n', { mode: 0o600 });
      atomic(statePath, JSON.stringify(state, null, 2) + '\n');
      writeIndex(state);
      console.log('Round ' + state.rounds + ': ' + (workChanged ? 'existing project updated' : 'no source changes') + '. Continue from saved task.');
      if (once || !running) break;
      await pause(workChanged ? delay : backoff(state.stalls));
    }
  } finally { try { unlinkSync(lockPath); } catch {} }
}
main().catch((error) => { console.error('DevCode continuity: ' + error.message); process.exitCode = 1; });
