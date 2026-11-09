/**
 * Local, opt-in coordination for independent tasks without creating Git branches.
 * This is a lease/ownership gate, not permission to push or deploy.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const checkPath = (name) => {
  if (typeof name !== 'string' || !name.trim() || name.startsWith('/') ||
    name.split(/[\\/]/).some(x => x === '..' || x === '.') ||
    /[\n\r\0:*?"<>|]/.test(name)) throw Error('Invalid worker-owned path');
  return name.replace(/\\/g, '/').replace(/\/+$/, '');
};
const intersects = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
const activeAt = (item, now) => item && item.expires > now && item.status === 'active';

export function validateWorkerPlan(plan, { maxWorkers = 2 } = {}) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.tasks) ||
    plan.tasks.length < 1 || plan.tasks.length > Math.min(2, maxWorkers)) throw Error('Unsafe worker count');
  const allocations = [];
  for (const task of plan.tasks) {
    if (typeof task.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(task.id) ||
      !Array.isArray(task.paths) || !task.paths.length || task.paths.length > 25 ||
      typeof task.goal !== 'string' || task.goal.length > 1000) throw Error('Invalid task');
    const paths = task.paths.map(checkPath);
    for (const old of allocations)
      for (const p of paths) for (const q of old.paths)
        if (intersects(p, q)) throw Error('Worker write scopes overlap: ' + p + ' / ' + q);
    allocations.push({ id: task.id, goal: task.goal, paths });
  }
  return { tasks: allocations, maxWorkers: allocations.length, mode: 'isolated-scopes',
    network: 'no-cloud-required', gitBranchesCreated: 0, integration: 'owner-controlled' };
}

function verifyMain(project) {
  const r = spawnSync('git', ['branch', '--show-current'], { cwd: project, encoding: 'utf8', timeout: 10000 });
  if (r.status !== 0 || r.stdout.trim() !== 'main') throw Error('Worker coordination requires main');
}
function acquireRegistryLock(path) {
  // Fail closed on a contested or crashed registry, rather than risk overlapping writes.
  mkdirSync(path, { mode: 0o700 });
  return () => rmSync(path, { recursive: true, force: true });
}
function readLeases(dir) {
  return readdirSync(dir).filter(x => x.endsWith('.json')).map(x => {
    try { return JSON.parse(readFileSync(join(dir, x), 'utf8')); }
    catch { throw Error('Corrupt worker registry; repair manually before starting workers'); }
  });
}
export function reserveScopedWorker(project, task, { maxWorkers = 1, ttlMs = 3600000 } = {}) {
  project = resolve(project); verifyMain(project);
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 2)
    throw Error('Worker capacity must be 1 or 2 for a local machine');
  if (!Number.isFinite(ttlMs) || ttlMs < 30000 || ttlMs > 3600000)
    throw Error('Worker lease lifetime out of range');
  const checked = validateWorkerPlan({ tasks: [task] }).tasks[0];
  const dir = join(project, '.devcode-factory', 'workers');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const unlock = acquireRegistryLock(join(dir, '.registry-lock'));
  try {
    const active = readLeases(dir).filter(x => activeAt(x, Date.now()));
    if (active.length >= maxWorkers) throw Error('Local worker budget exhausted');
    for (const other of active)
      for (const p of checked.paths) for (const q of other.paths)
        if (intersects(p, q)) throw Error('Worker scope already owned');
    const id = randomUUID(), token = randomUUID();
    const item = { id, token, task: checked, status: 'active',
      issued: Date.now(), expires: Date.now() + ttlMs, pid: process.pid };
    const tmp = join(dir, id + '.tmp');
    writeFileSync(tmp, JSON.stringify(item) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(tmp, join(dir, id + '.json'));
    return { id, token, paths: checked.paths, expires: item.expires };
  } finally { unlock(); }
}
export function releaseScopedWorker(project, id, token) {
  const dir = join(resolve(project), '.devcode-factory', 'workers');
  const unlock = acquireRegistryLock(join(dir, '.registry-lock'));
  try {
    const p = join(dir, String(id) + '.json');
    const item = JSON.parse(readFileSync(p, 'utf8'));
    if (item.token !== token) throw Error('Worker release token mismatch');
    rmSync(p);
    return true;
  } finally { unlock(); }
}
