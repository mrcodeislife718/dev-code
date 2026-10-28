#!/usr/bin/env node
/**
 * JobFlow production-completion supervisor for DevCode.
 * Run from the existing local JobFlow checkout. Never resets branches.
 * The DevCode CLI must already be configured for the user's LOCAL model server.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(process.env.JOBFLOW_DIR || process.cwd());
const dir = join(root, '.jobflow-factory');
const statePath = join(dir, 'state.json');
const logPath = join(dir, 'runs.jsonl');
const cli = process.env.DEVCODE_BIN || 'devcode';
const interval = Number(process.env.JOBFLOW_RETRY_DELAY_MS || 10000);
const maxCycles = Number(process.env.JOBFLOW_MAX_CYCLES || 0);
if (!existsSync(join(root, '.git'))) throw new Error('JOBFLOW_DIR must be an existing Git checkout');
if (!Number.isSafeInteger(interval) || interval < 1000 || !Number.isSafeInteger(maxCycles) || maxCycles < 0) throw new Error('Invalid retry delay or max cycles');
mkdirSync(dir, { recursive: true });
const run = (command, args, timeout = 0) => spawnSync(command, args, {
  cwd: root, encoding: 'utf8', timeout, maxBuffer: 10 * 1024 * 1024,
  env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
});
const git = (args) => run('git', args);
const branch = git(['branch', '--show-current']);
if (branch.status !== 0) throw new Error(branch.stderr);
const activeBranch = branch.stdout.trim();
if (activeBranch !== 'jobflow-completion' && process.env.JOBFLOW_ALLOW_BRANCH !== activeBranch) {
  throw new Error('Expected jobflow-completion; found ' + activeBranch + '. Refusing to switch/reset automatically.');
}
const objective = [
  'You are DevCode, implementing JobFlow, not explaining it. Continue work in this existing checkout.',
  'Mission: a 24/7/365 AI receptionist and appointment-based business operations platform.',
  'Voice calls, two-way SMS, website chat, email, connected social channels and missed-call recovery must capture opportunities, answer, qualify, book, reschedule, cancel, take authorized deposits and send confirmations.',
  'All channels share tenant-isolated customer history, real availability, atomic no-double-booking reservations, staff schedules, business rules and durable records.',
  'Business onboarding, owner management, CRM, follow-up, reporting, payments, webhooks, monitoring, security, backup/recovery and production deployment must be functional.',
  'First inspect Git status, prior checkpoints and actual implementation. Preserve Groups 1-4 and uncommitted work. Implement Group 5 owner services/prices/staff/hours/availability first, then all missing requirements.',
  'Maintain .jobflow-factory/requirements.md, progress.md, evidence.md and blockers.md; mark requirements complete ONLY after real test evidence. Never fabricate success.',
  'Each cycle: implement the next highest-priority incomplete work, test, fix, rerun, and update durable records. Do not stop at planning or mock-only implementations.',
  'Do not weaken tests, delete existing work, change branches, push, publish, spend on metered AI, or deploy to production without authorization.',
  'External credentials, phone numbers, payment accounts, live services and deployment approvals may be genuine blockers; document them and continue independent work.',
  'If everything is verified, write .jobflow-factory/PRODUCTION_VERIFIED.json with verified=true, timestamp, URL, test commands/results, and evidence links. Never write it without live production verification.',
].join(' ');
let cycle = 0;
let stopped = false;
process.on('SIGINT', () => { stopped = true; });
process.on('SIGTERM', () => { stopped = true; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
while (!stopped && (maxCycles === 0 || cycle < maxCycles)) {
  cycle++;
  const started = new Date().toISOString();
  const before = git(['status', '--porcelain']).stdout;
  const result = run(cli, ['-p', cycle === 1 ? objective : 'Continue implementing JobFlow from the on-disk requirements/progress/evidence. Execute the next incomplete requirement, run tests and record results. Do not merely summarize.'], 0);
  const after = git(['status', '--porcelain']).stdout;
  const entry = { cycle, started, ended: new Date().toISOString(), exitCode: result.status, signal: result.signal, error: result.error?.message, changed: before !== after, stdoutTail: result.stdout?.slice(-4000), stderrTail: result.stderr?.slice(-2000) };
  appendFileSync(logPath, JSON.stringify(entry) + '\n');
  writeFileSync(statePath, JSON.stringify({ cycle, branch: activeBranch, last: entry }, null, 2) + '\n');
  console.log('Cycle', cycle, 'exit', result.status, 'changes', entry.changed, 'logs:', logPath);
  const proof = join(dir, 'PRODUCTION_VERIFIED.json');
  if (existsSync(proof)) {
    try {
      const data = JSON.parse(readFileSync(proof, 'utf8'));
      if (data.verified === true && typeof data.url === 'string' && data.url.startsWith('https://') && Array.isArray(data.testResults) && data.testResults.length) {
        console.log('Production verification record found. Human review still required:', proof);
        break;
      }
    } catch { /* invalid record is not completion */ }
  }
  if (stopped) break;
  await sleep(interval);
}
