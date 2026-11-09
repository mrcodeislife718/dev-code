import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendHostEvent, readVerifiedContext, verificationGate, assessLoop,
  evaluateAdaptiveStrategy, safeCheckCommand, searchToolCatalog } from './factory-guard.mjs';

const time = '2026-11-09T12:00:00Z';
const check = { name: 'test', command: 'npm test', observed: true, exitCode: 0, signal: '',
  revision: 'revision-a', afterRevision: 'revision-a', startedAt: time, finishedAt: time };

test('host checks must pass against the final revision', () => {
  assert.equal(verificationGate({ revision: 'revision-a', finalRevision: 'revision-a', checks: [check] }).ok, true);
  assert.equal(verificationGate({ revision: 'revision-a', finalRevision: 'revision-b', checks: [check] }).ok, false);
  assert.equal(verificationGate({ revision: 'revision-a', finalRevision: 'revision-a', checks:
    [{ ...check, afterRevision: 'revision-b' }] }).reason, 'stale-check');
  assert.equal(verificationGate({ revision: 'revision-a', finalRevision: 'revision-a', checks:
    [{ ...check, exitCode: 1 }] }).ok, false);
  assert.equal(verificationGate({ revision: 'revision-a', finalRevision: 'revision-a', checks: [] }).ok, false);
});

test('masked shell exits are not verification evidence', () => {
  assert.equal(safeCheckCommand('npm test || true'), false);
  assert.equal(safeCheckCommand('npm test | tee out.log'), true); // bash pipefail must be used by the host
  assert.equal(safeCheckCommand('npm test; true'), false);
});

test('durable host events persist and are scoped to a project', () => {
  const a = mkdtempSync(join(tmpdir(), 'guard-a-'));
  const b = mkdtempSync(join(tmpdir(), 'guard-b-'));
  try {
    appendHostEvent(a, { type: 'verified-checks', revision: 'abc', passed: true });
    appendHostEvent(b, { type: 'check', revision: 'abc', passed: false });
    assert.match(readVerifiedContext(a, 'abc'), /current/);
    assert.equal(readVerifiedContext(b, 'abc'), '');
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test('bounded loop monitor intervenes then stops', () => {
  let h = [], r;
  for (let i = 0; i < 5; i++) { r = assessLoop(h, { changed: false, exitCode: 1, error: 'bad' }); h = r.history; }
  assert.equal(r.stop, true);
  r = assessLoop(h, { changed: true, exitCode: 0, error: '' });
  assert.equal(r.stop, false);
});

test('strategy comparison requires host proof and rejects regressions', () => {
  const b = { hostVerified: true, revision: 'base', passed: 10, failed: 0, durationMs: 1000 };
  assert.equal(evaluateAdaptiveStrategy(b, { ...b, revision: 'candidate', durationMs: 900 }).accepted, true);
  assert.equal(evaluateAdaptiveStrategy(b, { ...b, revision: 'candidate', failed: 1 }).accepted, false);
  assert.equal(evaluateAdaptiveStrategy(b, { ...b, revision: 'candidate', hostVerified: false }).accepted, false);
});

test('tool discovery exposes metadata only and caps output', () => {
  const tools = [{ name: 'grep', description: 'search code', tier: 'core' },
    { name: 'web', description: 'search web', tier: 'deferred' }];
  assert.deepEqual(searchToolCatalog(tools, 'search code').map(x => x.name), ['grep']);
});

test('host evidence survives abrupt SIGKILL before a new supervisor process', () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-kill-'));
  try {
    const url = new URL('./factory-guard.mjs', import.meta.url).href;
    const script = "import {appendHostEvent} from " + JSON.stringify(url) +
      "; appendHostEvent(" + JSON.stringify(root) +
      ", {type:'verified-checks',revision:'restart-rev',passed:true}); process.kill(process.pid,'SIGKILL');";
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    assert.match(readVerifiedContext(root, 'restart-rev'), /current/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
