#!/usr/bin/env node
/**
 * Resumable JobFlow completion supervisor for the user's DevCode fork.
 * Does not merge, push, deploy, or claim production completion.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, appendFileSync, statSync, unlinkSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const devcodeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const jobflow = resolve(process.env.JOBFLOW_DIR || process.cwd());
const workspace = join(jobflow, '.jobflow-factory');
const stateFile = join(workspace, 'state.json');
const logFile = join(workspace, 'runs.jsonl');
const lockFile = join(workspace, '.runner.lock');
const once = process.argv.includes('--once');
const check = process.argv.includes('--check');
const maxCycles = once ? 1 : Number(process.env.JOBFLOW_MAX_CYCLES ?? '0');
const delay = Number(process.env.JOBFLOW_RETRY_DELAY_MS ?? '10000');
const stallLimit = Number(process.env.JOBFLOW_STALL_LIMIT ?? '3');

function fail(message) { console.error('JobFlow runner: ' + message); process.exitCode = 1; }
function exec(command, args) {
  const result = spawnSync(command, args, { cwd: jobflow, encoding: 'utf8', timeout: 15000 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr?.trim() || command + ' failed');
  return result.stdout.trim();
}
function modelAddress(urlText) {
  if (!urlText) throw new Error('Set OPENAI_BASE_URL to your existing local 30B model server address. No paid provider will be selected for you.');
  const url = new URL(urlText);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = host === 'localhost' || host === '::1' || host.startsWith('127.') ||
    host.startsWith('10.') || host.startsWith('192.168.') ||
    (host.startsWith('172.') && Number(host.split('.')[1]) >= 16 && Number(host.split('.')[1]) <= 31) ||
    (host.startsWith('100.') && Number(host.split('.')[1]) >= 64 && Number(host.split('.')[1]) <= 127);
  if (!['http:', 'https:'].includes(url.protocol) || !local || url.username || url.password) {
    throw new Error('The AI address must point to your own machine or private network. Cloud/Copilot use is blocked.');
  }
  return url.href;
}
function snapshot() {
  const diff = exec('git', ['diff', '--no-ext-diff', '--binary', 'HEAD']);
  const untracked = exec('git', ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
  const summaries = untracked.map((file) => {
    try { const s = statSync(join(jobflow, file)); return file + ':' + s.size + ':' + s.mtimeMs; }
    catch { return file + ':missing'; }
  });
  const ledger = ['requirements.md', 'progress.md', 'evidence.md', 'blockers.md']
    .map((f) => { try { return readFileSync(join(workspace, f), 'utf8'); } catch { return ''; } });
  return createHash('sha256').update(JSON.stringify({ diff, summaries, ledger })).digest('hex');
}
function saveAtomic(path, data) {
  writeFileSync(path + '.tmp', data);
  renameSync(path + '.tmp', path);
}
const CONTRACT = [
  '# JobFlow: the exact product DevCode must finish',
  'JobFlow lets appointment-based businesses operate with a 24/7/365 AI receptionist and operations system. A customer contacting a closed business must get an answer, a real available appointment, a saved booking, a confirmation and a business calendar update without waiting for staff. This is the product promise, not an optional example.',
  '',
  '## Preserve what is built',
  '- Inspect the active branch and actual files first. Preserve Groups 1–4 and existing uncommitted work. Never reset, replace, delete or repeat accepted work.',
  '- Finish Group 5 owner screens and working business controls (services, pricing, duration, staff, business hours, exceptions, real availability), then audit and complete every missing product requirement.',
  '',
  '## Required end-to-end capabilities',
  '- Business signup, setup, locations, services, employees, capacity, prices, policies, hours and owner management.',
  '- Real incoming voice conversations, two-way SMS, website messaging, email and approved social channels; unified customer identity and complete interaction history.',
  '- AI receptionist answers questions, qualifies leads, checks current availability, safely books, reschedules and cancels, takes authorized deposits, and confirms results using real services, not promises or mock-only behavior.',
  '- Never double-book: simultaneous customer requests, employee leave, time zones, buffers, exceptions, failures and rebooking must be handled correctly.',
  '- Capture every recoverable missed call, abandoned contact and unavailable-slot lead; obtain communication consent, follow up lawfully, retry delivery safely and escalate unresolved issues.',
  '- Customer records, lead tracking, reminders, waitlists, staff handoff, payments, invoices, refunds, billing events, reviews, referral and retention workflows and reliable revenue reports.',
  '- Secure business separation, account access rules, secrets protection, audit history, data durability, retries, outage recovery, backups, monitoring and accessibility.',
  '- Working production setup, real service connections, deployment and real-world acceptance evidence.',
  '',
  '## Required acceptance demonstration',
  'A new business completes signup, adds staff/services/hours, connects its phone and messaging services, closes for the night, receives a real call and text, and JobFlow independently responds, books open appointments, records them on the correct calendar and sends confirmations. Also verify cancellation, rescheduling, competing bookings, failed payments, service outages, business separation, backups and recovery.',
  '',
  '## How to work',
  '1. Inspect actual requirements, existing code, tests and recorded checkpoints. Do not rebuild what already works.',
  '2. Keep requirements.md, progress.md, evidence.md and blockers.md current. Every requirement must say not started, working, verified or blocked, with specific proof for verified.',
  '3. Implement the next unfinished requirement. Run its tests, repair failures, and rerun checks. Do actual work every round; do not only produce plans.',
  '4. Save progress before ending each work session. Do not invent test results or claim a live service was tested without using it.',
  '5. Do not use Copilot or any metered AI provider, do not change branches, push, publish, erase work, spend money or deploy to production without authorization.',
  '6. If an external account, credential, phone number or permission is missing, write the exact blocker and complete other independent work.',
  '7. Only describe the entire JobFlow product as production-ready after independent real-world acceptance. Code generation alone never qualifies.',
].join('\n') + '\n';

async function launch(command, args, env) {
  return new Promise((done) => {
    let stdout = '', stderr = '';
    const child = spawn(command, args, { cwd: jobflow, env, stdio: ['ignore', 'pipe', 'pipe'] });
    activeChild = child;
    child.stdout.on('data', (c) => { stdout = (stdout + c.toString()).slice(-250000); });
    child.stderr.on('data', (c) => { stderr = (stderr + c.toString()).slice(-50000); });
    child.on('error', (err) => done({ exitCode: 1, stdout, stderr: stderr + '\n' + err.message }));
    child.on('close', (code, signal) => { activeChild = null; done({ exitCode: code ?? 1, signal, stdout, stderr }); });
  });
}
function sessionFrom(output) {
  for (const line of output.split('\n')) {
    try { const data = JSON.parse(line); if (data.type === 'system' && data.session_id) return data.session_id; }
    catch { /* non-JSON output */ }
  }
  return undefined;
}
let activeChild;
let stopped = false;
function shutdown() { stopped = true; if (activeChild) activeChild.kill('SIGTERM'); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!existsSync(join(jobflow, '.git'))) throw new Error('JOBFLOW_DIR must point to your existing JobFlow folder');
  const branch = exec('git', ['branch', '--show-current']);
  const actualRoot = resolve(exec('git', ['rev-parse', '--show-toplevel']));
  if (actualRoot !== jobflow) throw new Error('Select the top-level JobFlow folder, not a nested folder');
  if (branch !== 'jobflow-completion' && process.env.JOBFLOW_ALLOW_BRANCH !== branch) {
    throw new Error('On branch ' + branch + '. Refusing to change branches or overwrite earlier work.');
  }
  const endpoint = modelAddress(process.env.OPENAI_BASE_URL);
  const model = process.env.OPENAI_MODEL;
  if (!model) throw new Error('Set OPENAI_MODEL to the name of your existing local 30B model');
  if (!Number.isSafeInteger(delay) || delay < 1000 || !Number.isSafeInteger(maxCycles) || maxCycles < 0 || !Number.isSafeInteger(stallLimit) || stallLimit < 1) {
    throw new Error('Invalid cycle, delay or stall setting');
  }
  const binary = process.env.DEVCODE_BIN;
  const executable = binary || process.execPath;
  const argsPrefix = binary ? [] : [join(devcodeRoot, 'scripts', 'dev.js')];
  if (!binary && !existsSync(argsPrefix[0])) throw new Error('DevCode checkout not found. Set DEVCODE_BIN to your existing DevCode command.');
  console.log('JobFlow: ' + jobflow + '\nBranch: ' + branch + '\nDevCode: ' + (binary || 'this DevCode checkout') + '\nAI: ' + model + ' at ' + endpoint);
  if (check) { console.log('Safety checks passed. No work started.'); return; }

  mkdirSync(workspace, { recursive: true });
  let lock;
  try { lock = openSync(lockFile, 'wx'); writeFileSync(lock, String(process.pid)); }
  catch { throw new Error('Another run may be active. Check ' + lockFile + ' before removing a stale lock.'); }
  closeSync(lock);
  try {
    const files = {
      '.gitignore': '*\n!.gitignore\n',
      'contract.md': CONTRACT,
      'requirements.md': '# JobFlow requirements and verified status\n\nSee contract.md. Inspect actual implementation; verify each requirement before marking complete.\n',
      'progress.md': '# JobFlow implementation progress\n\nGroups 1–4: inspect actual local work and verify before continuing. Next: Group 5.\n',
      'evidence.md': '# Test and production evidence\n\nNo test results have been independently verified by this supervisor.\n',
      'blockers.md': '# Genuine external blockers\n\nList only blockers that prevent specific work; continue independent tasks.\n',
    };
    for (const [name, data] of Object.entries(files)) {
      const path = join(workspace, name);
      if (!existsSync(path)) writeFileSync(path, data, { flag: 'wx' });
    }
    let state = { cycle: 0, noProgress: 0, sessionId: null };
    if (existsSync(stateFile)) {
      try { const saved = JSON.parse(readFileSync(stateFile, 'utf8')); if (saved.branch === branch && saved.model === model && saved.endpoint === endpoint) state = { ...state, ...saved }; }
      catch { throw new Error('Saved JobFlow progress is unreadable. No files were deleted.'); }
    }
    let rounds = 0;
    while (!stopped && (maxCycles === 0 || rounds < maxCycles)) {
      rounds++;
      const started = new Date().toISOString();
      const before = snapshot();
      const initial = !state.sessionId;
      const prompt = initial
        ? 'Implement JobFlow now. Read .jobflow-factory/contract.md and its progress records. Preserve Groups 1–4, complete Group 5, then all remaining requirements. Write real code and tests in this run, not merely a plan. Do not claim a live production launch.'
        : 'Continue implementing the next unfinished JobFlow requirement. Read .jobflow-factory/contract.md and progress records, make real changes, run tests and record evidence. Do not only summarize.';
      // Explicitly select the user's local OpenAI-compatible model, overriding saved Copilot settings.
      // Do not permit the saved cloud fallback model to be chosen.
      const args = [
        ...argsPrefix,
        ...(initial ? [] : ['--resume', state.sessionId]),
        '--auth-type', 'openai', '--model', model, '--fallback-model', model,
        '-p', prompt, '--output-format', 'stream-json',
      ];
      const result = await launch(executable, args, { ...process.env, OPENAI_BASE_URL: endpoint, OPENAI_MODEL: model, OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'local-only' });
      const sessionId = sessionFrom(result.stdout) || state.sessionId;
      const changed = snapshot() !== before;
      state = { cycle: state.cycle + 1, branch, model, endpoint, sessionId, noProgress: changed ? 0 : state.noProgress + 1, lastResult: { started, ended: new Date().toISOString(), exitCode: result.exitCode, changed } };
      appendFileSync(logFile, JSON.stringify({ ...state.lastResult, cycle: state.cycle, sessionId, outputTail: result.stdout.slice(-3000), errorTail: result.stderr.slice(-2000) }) + '\n');
      saveAtomic(stateFile, JSON.stringify(state, null, 2) + '\n');
      console.log('Round ' + state.cycle + ': ' + (changed ? 'changes saved' : 'no changes') + '; DevCode result ' + result.exitCode + '.');
      if (result.exitCode !== 0 && !changed) { fail('DevCode could not continue. Read .jobflow-factory/runs.jsonl for the exact error.'); break; }
      if (state.noProgress >= stallLimit) { fail('DevCode has made no changes for several rounds. Inspect its records instead of endlessly repeating work.'); break; }
      if (stopped) break;
      if (maxCycles === 0 || rounds < maxCycles) await sleep(delay);
    }
    console.log('Saved progress in ' + workspace + '. Production completion is NOT assumed.');
  } finally { try { unlinkSync(lockFile); } catch { /* lock already removed */ } }
}

main().catch((error) => fail(error.message));
