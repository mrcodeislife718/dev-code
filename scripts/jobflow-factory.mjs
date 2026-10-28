#!/usr/bin/env node
/**
 * JobFlow production-completion runner for the existing DevCode fork.
 * Built on Node standard libraries; no hosted inference or billing dependency.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream, createWriteStream, existsSync, mkdirSync,
  readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const factoryRoot = resolve(dirname(self), '..');
export const requiredChecks = [
  'owner', 'booking', 'tenant', 'voice-live', 'sms-live', 'web-chat',
  'email', 'social', 'missed-call', 'followups', 'payments-live',
  'notifications-live', 'continuity', 'security', 'monitoring',
  'production-live',
];

export function isPrivateEndpoint(value) {
  try {
    const url = new URL(value);
    const h = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(h)) return true;
    if (h.endsWith('.local')) return true;
    if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
    if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
    const m = /^172\.(\d+)\.\d+\.\d+$/.exec(h);
    if (m && +m[1] >= 16 && +m[1] <= 31) return true;
    const tail = /^100\.(\d+)\.\d+\.\d+$/.exec(h);
    return !!tail && +tail[1] >= 64 && +tail[1] <= 127;
  } catch {
    return false;
  }
}

export function resolveLocalModel(settings, env = process.env) {
  const model = env.OPENAI_MODEL || settings.model?.name || '';
  const providers = Object.values(settings.modelProviders || {})
    .flatMap((value) => Array.isArray(value) ? value : []);
  const selected = providers.find((x) => x.id === model || x.name === model);
  const endpoint = env.OPENAI_BASE_URL || selected?.baseUrl || settings.model?.baseUrl || '';
  const auth = settings.security?.auth?.selectedType;
  if (auth && !['openai', 'custom', 'openai-compatible'].includes(auth)) {
    throw new Error('DevCode is set to ' + auth + ', not a local OpenAI-compatible provider. Select your existing local model in DevCode before starting.');
  }
  if (!model || !isPrivateEndpoint(endpoint)) {
    throw new Error('Local model not verified: expected a selected model and private-network/localhost OpenAI-compatible endpoint in existing ~/.qwen/settings.json or OPENAI_MODEL / OPENAI_BASE_URL. Refusing Copilot/cloud fallback.');
  }
  return { model, endpoint };
}

export function listChecks(packageJson) {
  const scripts = packageJson.scripts || {};
  return [
    { id: 'tests', script: 'test', present: typeof scripts.test === 'string' },
    { id: 'build', script: 'build', present: typeof scripts.build === 'string' },
    ...requiredChecks.map((id) => ({
      id,
      script: 'verify:' + id,
      present: typeof scripts['verify:' + id] === 'string',
    })),
  ];
}

function runGit(project, args) {
  const r = spawnSync('git', args, { cwd: project, encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0) {
    throw new Error('git ' + args.join(' ') + ': ' + (r.stderr || r.error?.message || 'failed'));
  }
  return r.stdout.trim();
}

function atomicJson(path, value) {
  const temp = path + '.new-' + process.pid;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
}

function saveState(dir, state) {
  state.updatedAt = new Date().toISOString();
  atomicJson(join(dir, 'state.json'), state);
}

function parseOptions(args) {
  const out = { project: null, once: false, verify: false, status: false, cli: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--project' || arg === '--cli') {
      if (!args[i + 1]) throw new Error('Missing value for ' + arg);
      out[arg.slice(2)] = args[++i];
    } else if (arg === '--once' || arg === '--verify' || arg === '--status') {
      out[arg.slice(2)] = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/jobflow-factory.mjs --project /path/to/jobflow [--once | --verify | --status] [--cli /path/to/DevCode/entry.js]');
      process.exit(0);
    } else {
      throw new Error('Unknown argument: ' + arg);
    }
  }
  if (!out.project) throw new Error('--project is required');
  out.project = resolve(out.project);
  return out;
}

function getState(dir) {
  const path = join(dir, 'state.json');
  if (!existsSync(path)) return {
    status: 'in-progress', cycles: 0, noProgressCycles: 0, sessionId: null,
    lastGitFingerprint: null, lastVerification: null,
  };
  return JSON.parse(readFileSync(path, 'utf8'));
}

function ensureProject(project) {
  const packagePath = join(project, 'package.json');
  if (!existsSync(packagePath)) throw new Error('No package.json in ' + project);
  const branch = runGit(project, ['branch', '--show-current']);
  if (branch !== 'jobflow-completion') {
    throw new Error('Refusing to operate on branch "' + branch + '". Use your EXISTING local jobflow-completion branch; never reset or recreate it.');
  }
  return JSON.parse(readFileSync(packagePath, 'utf8'));
}

function gitFingerprint(project) {
  const sha = runGit(project, ['rev-parse', 'HEAD']);
  const changes = runGit(project, ['status', '--porcelain=v1', '--untracked-files=all'])
    .split('\n').filter((s) => s && !s.includes('.devcode-factory/'));
  const diff = runGit(project, ['diff', '--binary']);
  return createHash('sha256').update(sha + '\n' + changes.join('\n') + '\n' + diff).digest('hex');
}

async function captureProcess(command, args, options) {
  return new Promise((done) => {
    const log = createWriteStream(options.log, { flags: 'a', mode: 0o600 });
    let sessionId = null;
    let pending = '';
    const child = spawn(command, args, {
      cwd: options.cwd, env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = (chunk) => {
      const str = chunk.toString();
      log.write(str);
      if (options.echo) process.stdout.write(str);
      pending += str;
      const parts = pending.split('\n');
      pending = parts.pop() || '';
      for (const line of parts) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'system' && obj.session_id) sessionId = obj.session_id;
        } catch { /* non-JSON CLI output */ }
      }
      if (pending.length > 2_000_000) pending = '';
    };
    child.stdout.on('data', stdout);
    child.stderr.on('data', (chunk) => {
      log.write(chunk);
      if (options.echo) process.stderr.write(chunk);
    });
    const started = Date.now();
    let finished = false;
    const finish = (code, signal, error) => {
      if (finished) return;
      finished = true;
      log.end();
      done({ code: code ?? 1, signal: signal || null, error: error?.message || null,
        sessionId, durationMs: Date.now() - started });
    };
    child.on('error', (error) => finish(1, null, error));
    child.on('close', (code, signal) => finish(code, signal));
    const cancel = () => child.kill('SIGTERM');
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    child.on('close', () => {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    });
  });
}

export async function verifyProject(project, dir) {
  const pkg = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
  const results = [];
  const evidence = join(dir, 'evidence');
  mkdirSync(evidence, { recursive: true });
  for (const check of listChecks(pkg)) {
    if (!check.present) {
      results.push({ id: check.id, result: 'missing', script: check.script });
      continue;
    }
    const log = join(evidence, check.id + '.log');
    writeFileSync(log, '', { mode: 0o600 });
    const run = await captureProcess('npm', ['run', check.script], {
      cwd: project, log, echo: false,
    });
    results.push({
      id: check.id, result: run.code === 0 ? 'passed' : 'failed',
      exitCode: run.code, script: check.script, log,
      testedAt: new Date().toISOString(),
    });
  }
  const allPassed = results.every((item) => item.result === 'passed');
  const summary = { verifiedAt: new Date().toISOString(), allPassed, checks: results };
  atomicJson(join(dir, 'verification.json'), summary);
  return summary;
}

async function start(project, state, dir, cliPath) {
  const contract = join(dir, 'contract.md');
  const prompt = state.sessionId
    ? 'Continue implementing JobFlow from .devcode-factory/contract.md and .devcode-factory/verification.json. Repair the earliest missing/failed production requirement, starting Group 5 if unfinished. MAKE CODE CHANGES, run tests, preserve existing work, and write next tasks to .devcode-factory/tasks.md. Never just restate the plan. No cloud provider, force push or production deployment.'
    : 'You are DevCode, executing the JobFlow production completion contract. Read .devcode-factory/contract.md and inspect this checkout and git history first. Preserve Groups 1-4. Implement Group 5 owner management if incomplete, including real APIs, UI, persistence and tests. Then continue implementing remaining gaps. Save .devcode-factory/tasks.md with required acceptance evidence. Work on CODE, not commentary. Do not use cloud models, overwrite user changes, or deploy without approval.';
  const args = [
    ...(state.sessionId ? ['--resume', state.sessionId] : []),
    '-p', prompt, '--output-format', 'stream-json',
  ];
  const logPath = join(dir, 'runs', 'cycle-' + (state.cycles + 1) + '.jsonl');
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, '', { mode: 0o600 });
  const r = await captureProcess(process.execPath, [cliPath, ...args], {
    cwd: project, log: logPath, echo: true, env: process.env,
  });
  return { ...r, log: logPath };
}

async function main() {
  const opts = parseOptions(process.argv.slice(2));
  const project = opts.project;
  const dir = join(project, '.devcode-factory');
  if (opts.status) {
    if (!existsSync(dir)) throw new Error('No factory state yet; start the runner.');
    console.log(JSON.stringify(getState(dir), null, 2));
    return;
  }
  ensureProject(project);
  mkdirSync(dir, { recursive: true });
  const contractPath = join(dir, 'contract.md');
  if (!existsSync(contractPath)) {
    const source = join(factoryRoot, 'workflows', 'jobflow', 'CONTRACT.md');
    writeFileSync(contractPath, readFileSync(source, 'utf8'), { mode: 0o600 });
  }
  if (opts.verify) {
    const results = await verifyProject(project, dir);
    console.log(JSON.stringify(results, null, 2));
    if (!results.allPassed) process.exitCode = 2;
    return;
  }
  const qwenHome = process.env.QWEN_HOME || join(homedir(), '.qwen');
  const settingsFile = join(qwenHome, 'settings.json');
  const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
  const local = resolveLocalModel(settings);
  console.log('Local-only inference: ' + local.model + ' @ ' + local.endpoint);
  const cliPath = resolve(opts.cli || join(factoryRoot, 'scripts', 'start.js'));
  if (!existsSync(cliPath)) throw new Error('DevCode launcher missing: ' + cliPath);
  const state = getState(dir);
  while (true) {
    ensureProject(project);
    state.cycles++;
    state.status = 'running';
    const before = gitFingerprint(project);
    saveState(dir, state);
    const run = await start(project, { ...state, cycles: state.cycles - 1 }, dir, cliPath);
    if (run.sessionId) state.sessionId = run.sessionId;
    const after = gitFingerprint(project);
    const verification = await verifyProject(project, dir);
    state.lastVerification = verification.verifiedAt;
    state.lastExitCode = run.code;
    state.lastRunLog = run.log;
    state.lastGitFingerprint = after;
    state.noProgressCycles = before === after ? state.noProgressCycles + 1 : 0;
    if (verification.allPassed) {
      state.status = 'production-verified-by-checks';
      saveState(dir, state);
      console.log('All configured production gates passed. Inspect live evidence before shipping.');
      break;
    }
    if (run.signal || state.noProgressCycles >= 5) {
      state.status = 'blocked';
      state.blocker = run.signal
        ? 'DevCode process interrupted by ' + run.signal
        : 'Five consecutive cycles without source progress; investigate logs/model/tool permissions.';
      saveState(dir, state);
      console.error(state.blocker);
      process.exitCode = 2;
      break;
    }
    state.status = 'in-progress';
    saveState(dir, state);
    const failed = verification.checks.filter((c) => c.result !== 'passed');
    console.log('Cycle ' + state.cycles + ' completed; ' + failed.length + ' gates not verified.');
    if (opts.once) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, run.code === 0 ? 1500 : 10000));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === self) {
  main().catch((error) => {
    console.error('DevCode JobFlow factory stopped: ' + error.message);
    process.exitCode = 1;
  });
}
