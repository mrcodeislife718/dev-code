import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkerPlan } from './worker-coordinator.mjs';

test('independent worker scopes can be planned on one branch', () => {
  const plan = validateWorkerPlan({ tasks: [
    { id: 'api', paths: ['src/api'], goal: 'Implement API' },
    { id: 'docs', paths: ['docs'], goal: 'Update docs' }
  ] });
  assert.equal(plan.maxWorkers, 2);
  assert.equal(plan.gitBranchesCreated, 0);
});
test('reject overlapping scopes including parent/child paths', () => {
  assert.throws(() => validateWorkerPlan({ tasks: [
    { id: 'a', paths: ['src'], goal: 'A' },
    { id: 'b', paths: ['src/api'], goal: 'B' }
  ] }), /overlap/);
});
test('reject path escape and more than two workers', () => {
  assert.throws(() => validateWorkerPlan({ tasks: [{ id: 'x', paths: ['../secret'], goal: 'x' }] }), /path/);
  assert.throws(() => validateWorkerPlan({ tasks: [1,2,3].map(x => ({id:String(x),paths:[String(x)],goal:'x'})) }), /count/);
});
