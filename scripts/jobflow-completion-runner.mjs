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
import { readFreeCatalog, freeQuotaRemaining, cloudFailureType } from './openrouter-free-capacity.mjs';
import { buildCloudRoutes, chooseCloudRoute, cloudCooldownMs } from './free-cloud-routes.mjs';

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
const maxBackoff = Number(process.env.JOBFLOW_MAX_BACKOFF_MS ?? '300000');
const sessionCycles = Number(process.env.JOBFLOW_SESSION_CYCLES ?? '1');
const sessionWallTime = process.env.JOBFLOW_SESSION_WALL_TIME ?? '45m';
const cloudEnabled = process.env.DEVCODE_CLOUD_FALLBACK === '1';
const cloudCheck = process.argv.includes('--cloud-check');
// Deliberately NO invented limit on cloud rounds or coding actions.
// Providers enforce their real free-account limits; local coding remains unlimited by quota.
const cloudKeys = [
  process.env.OPENROUTER_API_KEY, process.env.GROQ_API_KEY,
  process.env.GEMINI_API_KEY, process.env.CLOUDFLARE_API_TOKEN
].filter((v) => typeof v === 'string' && v.length > 0);
const bootId = (() => { try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return ''; } })();

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
  writeFileSync(path + '.tmp', data, { mode: 0o600 });
  renameSync(path + '.tmp', path);
}
function tail(value, n = 2500) { return String(value ?? '').slice(-n); }
function writeContinuity(state) {
  const changed = tail(exec('git', ['status', '--short', '--untracked-files=normal']), 10000);
  saveAtomic(join(workspace, 'continuity.md'), [
    '# DevCode continuity index (not test evidence)',
    'A model conversation is temporary. The actual repository and durable ledgers are the truth.',
    'Branch: ' + state.branch,
    'Model: ' + state.model,
    'Cycle: ' + state.cycle,
    'Last exit code: ' + (state.lastResult?.exitCode ?? 'none'),
    'Consecutive no-progress cycles: ' + state.noProgress,
    '',
    '## READ THESE DURABLE FILES',
    'contract.md: project acceptance contract and safety requirements',
    'progress.md: current implementation task, exact next action and last verified checkpoint',
    'requirements.md: scope and feature status; evidence.md: test evidence; blockers.md: external blockers',
    'runs.jsonl: full execution chronology; state.json: session/cycle metadata',
    'Inspect actual code, git history and tests before claiming a capability exists.',
    'If nearing context limits, write an actionable checkpoint to progress.md and end the current round.',
    'Always update progress.md and evidence.md with real results before ending a round.',
    '',
    '## Worktree status',
    changed || '(clean)',
    '',
    '## Previous model output tail (unverified)',
    tail(state.lastOutputTail),
    '',
    '## Previous model error tail',
    tail(state.lastErrorTail, 1200),
    ''
  ].join('\n'));
}
function lockAvailable() {
  if (!existsSync(lockFile)) return;
  let owner;
  try {
    const record = JSON.parse(readFileSync(lockFile, 'utf8'));
    // Previous versions used a plain numeric PID, not JSON metadata.
    owner = typeof record === 'number' ? { pid: record } : record;
  }
  catch { throw new Error('Unrecognized runner lock. Inspect manually before changing it.'); }
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1)
    throw new Error('Runner lock owner is invalid.');
  if (owner.bootId && bootId && owner.bootId !== bootId) { unlinkSync(lockFile); return; }
  try { process.kill(owner.pid, 0); }
  catch (error) {
    if (error.code === 'ESRCH') { unlinkSync(lockFile); return; }
    throw error;
  }
  throw new Error('Runner already active or PID held: ' + owner.pid);
}
async function localModelHealthy(endpoint, model) {
  try {
    const url = new URL(endpoint.replace(/\/$/, '') + '/models');
    const response = await fetch(url, { signal: AbortSignal.timeout(7000) });
    if (!response.ok) return false;
    const data = await response.json();
    return Array.isArray(data.data) && data.data.some((x) => x.id === model);
  } catch { return false; }
}
function backoff(streak) {
  return Math.min(maxBackoff, delay * 2 ** Math.min(7, Math.max(0, streak - 1)));
}
function sanitizeLog(value) {
  let result = tail(value);
  for (const key of cloudKeys) result = result.split(key).join('[REDACTED_CLOUD_KEY]');
  return result;
}
async function cloudCandidates(state, openrouterModels) {
  const configured = buildCloudRoutes(process.env, openrouterModels);
  if (!configured.length) return [];
  const selected = [];
  // OpenRouter shares its free account allowance across every model.
  // We check its account allowance once, not once for every model.
  if (configured.some((route) => route.provider === 'openrouter')) {
    try {
      const remaining = await freeQuotaRemaining(process.env.OPENROUTER_API_KEY);
      if (remaining !== null && remaining <= 0) {
        state.cloudCooldowns ??= {};
        state.cloudCooldowns.openrouter = Date.now() + 90000;
        console.error('OpenRouter free allowance exhausted for now; other cloud routes remain eligible.');
      }
    } catch (error) {
      state.cloudCooldowns ??= {};
      state.cloudCooldowns.openrouter = Date.now() + 90000;
      console.error('OpenRouter allowance unknown; other services can still work: ' + error.message);
    }
  }
  for (const route of configured) selected.push(route);
  return selected;
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
  '5. Use only local inference, verified $0 OpenRouter models, or explicitly confirmed free-tier Groq/Google/Cloudflare accounts. No paid model use, pushes, leaks, erasures, spending or deployment without authorization.',
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
  const endpoint = modelAddress(process.env.OPENAI_BASE_URL || (process.env.OLLAMA_HOST ? new URL('/v1', process.env.OLLAMA_HOST).href : undefined));
  const model = process.env.OPENAI_MODEL;
  if (!model) throw new Error('Set OPENAI_MODEL to the name of your existing local 30B model');
  if (!Number.isSafeInteger(delay) || delay < 1000 || !Number.isSafeInteger(maxCycles) || maxCycles < 0 || !Number.isSafeInteger(stallLimit) || stallLimit < 1 || !Number.isSafeInteger(maxBackoff) || maxBackoff < delay || !Number.isSafeInteger(sessionCycles) || sessionCycles < 1) {
    throw new Error('Invalid cycle, delay or stall setting');
  }
  const binary = process.env.DEVCODE_BIN;
  const executable = binary || process.execPath;
  const argsPrefix = binary ? [] : [join(devcodeRoot, 'scripts', 'dev.js')];
  if (!binary && !existsSync(argsPrefix[0])) throw new Error('DevCode checkout not found. Set DEVCODE_BIN to your existing DevCode command.');
  console.log('JobFlow: ' + jobflow + '\nBranch: ' + branch + '\nDevCode: ' + (binary || 'this DevCode checkout') + '\nAI: ' + model + ' at ' + endpoint);
  if (cloudCheck) {
    if (!cloudEnabled) {
      console.log('Cloud backups disabled. Local Ollama is still the primary engine.');
      return;
    }
    let models = [];
    if (process.env.OPENROUTER_API_KEY) {
      try { models = await readFreeCatalog(); }
      catch (error) { console.error('OpenRouter catalog unavailable: ' + error.message); }
    }
    const routes = buildCloudRoutes(process.env, models);
    console.log('Eligible cloud backups (' + routes.length + '):');
    for (const route of routes) console.log('  ' + route.provider + ' / ' + route.model);
    console.log('All provider account plans must be free. No inference calls were made.');
    return;
  }
  if (check) {
    try {
      const response = await fetch(new URL(endpoint.replace(/\/$/, '') + '/models'), { signal: AbortSignal.timeout(7000) });
      if (!response.ok) throw new Error('The local model server returned HTTP ' + response.status);
      const found = await response.json();
      const models = Array.isArray(found.data) ? found.data.map((x) => x.id) : [];
      if (models.length && !models.includes(model)) throw new Error('The local model server does not list ' + model + '. Available: ' + models.join(', '));
      // The model-list endpoint does NOT prove coding tool support.
      const probe = await fetch(new URL('chat/completions', endpoint.endsWith('/') ? endpoint : endpoint + '/'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer local-only' },
        body: JSON.stringify({
          model, stream: false,
          messages: [{ role: 'user', content: 'Call the marker_check function with value factory-ready. Do not answer in text.' }],
          tools: [{ type: 'function', function: {
            name: 'marker_check', description: 'Harmless local tool-call capability check',
            parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }
          } }],
          max_tokens: 192
        }),
        signal: AbortSignal.timeout(120000),
      });
      if (!probe.ok) throw new Error('Tool-call probe returned HTTP ' + probe.status);
      const completion = await probe.json();
      const calls = completion?.choices?.[0]?.message?.tool_calls;
      if (!Array.isArray(calls) || !calls.some((call) => call.function?.name === 'marker_check'))
        throw new Error('Local model responded without calling tools. Fix Qwen3/DevCode tool calling before running the factory.');
    } catch (error) {
      throw new Error('Local model connection check failed: ' + error.message);
    }
    console.log('Local model connection and project safety checks passed. No files changed.');
    return;
  }

  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  lockAvailable();
  let lock;
  try { lock = openSync(lockFile, 'wx', 0o600);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, bootId, started: new Date().toISOString() })); }
  catch { throw new Error('Runner lock contested: ' + lockFile); }
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
    let offlineStreak = 0;
    let cloudCatalog = [];
    let cloudCatalogAt = 0;
    while (!stopped && (maxCycles === 0 || rounds < maxCycles)) {
      const localReady = await localModelHealthy(endpoint, model);
      if (cloudEnabled && process.env.OPENROUTER_API_KEY &&
        (cloudCatalogAt === 0 || Date.now() - cloudCatalogAt >= 1200000)) {
        cloudCatalogAt = Date.now();
        try { cloudCatalog = await readFreeCatalog(); }
        catch (error) { cloudCatalog = []; console.error('Free catalog cannot be verified: ' + error.message); }
      }
      let route = { id: 'local', provider: 'local', model, endpoint, apiKey: 'local-only' };
      if (!localReady || (state.localFailureStreak || 0) >= 2) {
        const routes = await cloudCandidates(state, cloudCatalog);
        const backup = chooseCloudRoute(routes, state);
        if (backup) {
          route = backup;
          state.cloudPreviousRoute = backup.id;
        }
      }
      if (!localReady && route.provider === 'local') {
        offlineStreak++;
        const pause = backoff(offlineStreak);
        console.error('Ollama offline and cloud unavailable; preserving checkpoints and retrying in ' + pause / 1000 + 's.');
        await sleep(pause);
        continue;
      }
      offlineStreak = 0;
      const started = new Date().toISOString();
      const before = snapshot();
      const resume = route.provider === 'local' && sessionCycles > 1 && state.sessionId &&
        state.cycle % sessionCycles !== 0 && state.lastResult?.exitCode === 0 && state.noProgress === 0;
      writeContinuity({ ...state, branch, model: route.model });
      const prompt = [
        'Implement the NEXT unfinished JobFlow requirement in real code now.',
        'Read .jobflow-factory/continuity.md and .jobflow-factory/contract.md first.',
        'Use progress.md, requirements.md, evidence.md and blockers.md as durable memory.',
        'Inspect real code and tests. Preserve Groups 1–4; complete Group 5 and remaining requirements.',
        'Make actual source changes, test them, repair failures, and update the evidence ledgers.',
        'Write the precise next action in progress.md before ending. Sessions are intentionally rotated.',
        'Only local Ollama, verified $0 OpenRouter models, or user-confirmed FREE provider accounts may be used.',
        'Never read or send .env, secrets, API keys, credentials, or private customer data to cloud models.',
        'No paid actions, destructive git commands, pushes or live deployments.',
        ...(state.noProgress >= stallLimit ? [
          'RECOVERY: previous rounds made no worktree or ledger progress.',
          'Diagnose previous output in continuity.md/runs.jsonl, select a smaller meaningful task',
          'and implement it instead of repeating an empty response.'
        ] : [])
      ].join(' ');
      const args = [
        ...argsPrefix,
        ...(resume ? ['--resume', state.sessionId] : []),
        '--auth-type', 'openai', '--model', route.model, '--fallback-model', route.model,
        '--approval-mode', 'auto', '--max-wall-time', sessionWallTime,
        '-p', prompt, '--output-format', 'stream-json',
      ];
      const result = await launch(executable, args, {
        ...process.env, OPENAI_BASE_URL: route.endpoint, OPENAI_MODEL: route.model,
        OPENAI_API_KEY: route.apiKey
      });
      const sessionId = sessionFrom(result.stdout) || (resume ? state.sessionId : null);
      const changed = snapshot() !== before;
      const diagnostic = result.stderr + '\n' + result.stdout;
      const failure = route.provider !== 'local'
        ? cloudFailureType(diagnostic, result.exitCode) : null;
      state.cloudCooldowns ??= {};
      if (failure) {
        const until = cloudCooldownMs(failure, diagnostic);
        // Each account has its own quota. OpenRouter's models share one account.
        const previous = Number(state.cloudCooldowns[route.provider] || 0);
        state.cloudCooldowns[route.provider] = Math.max(previous, until);
      }
      rounds++;
      state = {
        ...state,
        cycle: state.cycle + 1, branch, model, endpoint,
        sessionId: route.provider === 'local' ? sessionId : null,
        localFailureStreak: route.provider === 'local'
          ? (result.exitCode !== 0 || !changed ? (state.localFailureStreak || 0) + 1 : 0) : 0,
        noProgress: changed ? 0 : state.noProgress + 1,
        lastOutputTail: sanitizeLog(result.stdout), lastErrorTail: sanitizeLog(result.stderr),
        lastResult: { started, ended: new Date().toISOString(),
          exitCode: result.exitCode, changed, route: route.provider,
          cloudModel: route.provider !== 'local' ? route.model : null, failure }
      };
      appendFileSync(logFile, JSON.stringify({
        ...state.lastResult, cycle: state.cycle, sessionId,
        outputTail: state.lastOutputTail, errorTail: state.lastErrorTail
      }) + '\n', { mode: 0o600 });
      saveAtomic(stateFile, JSON.stringify(state, null, 2) + '\n');
      writeContinuity(state);
      console.log('Round ' + state.cycle + ': ' + (changed ? 'changes found' : 'no changes') +
        ', exit ' + result.exitCode + ', route ' + route.provider + ', model ' + route.model);
      if (state.noProgress >= stallLimit)
        console.error('Recovery mode: rotating context, diagnosing failures, backing off without discarding progress.');
      if (stopped) break;
      if (maxCycles === 0 || rounds < maxCycles)
        await sleep(changed ? delay : backoff(state.noProgress));
    }
    console.log('Saved progress in ' + workspace + '. Production completion is NOT assumed.');
  } finally { try { unlinkSync(lockFile); } catch { /* lock already removed */ } }
}

main().catch((error) => fail(error.message));
