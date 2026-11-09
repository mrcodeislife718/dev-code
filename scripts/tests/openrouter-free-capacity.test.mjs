import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PREFERRED_FREE_MODELS, readFreeCatalog, isEligibleModel,
  chooseFreeModel, cloudFailureType, readFreeRemaining,
} from '../openrouter-free-capacity.mjs';

const eligible = (id) => ({
  id,
  pricing: { prompt: '0', completion: '0' },
  architecture: { output_modalities: ['text'] },
  supported_parameters: ['tools', 'max_tokens'],
});

test('five tool-capable free models are allowlisted', async () => {
  const free = PREFERRED_FREE_MODELS.map(eligible);
  const pretendPaid = { ...eligible('paid/model:free'), pricing: { prompt: '0.5', completion: '0' } };
  const fake = async () => ({ ok: true, json: async () => ({ data: [pretendPaid, ...free] }) });
  assert.deepEqual(await readFreeCatalog(fake), PREFERRED_FREE_MODELS);
});

test('no accidental paid, non-free or no-tools model slips through', () => {
  assert.equal(isEligibleModel({ ...eligible(PREFERRED_FREE_MODELS[0]), pricing: { prompt: '0.0000001', completion: '0' } }), false);
  assert.equal(isEligibleModel({ ...eligible(PREFERRED_FREE_MODELS[0]), supported_parameters: ['temperature'] }), false);
  assert.equal(isEligibleModel(eligible('not-allowed/model:free')), false);
});

test('rotation works without making any external calls', () => {
  const list = PREFERRED_FREE_MODELS;
  assert.equal(chooseFreeModel(list, list[0]), list[1]);
  assert.equal(chooseFreeModel(list, list[list.length - 1]), list[0]);
  assert.equal(chooseFreeModel([]), null);
});

test('classifies cloud limit and payment errors', () => {
  assert.equal(cloudFailureType('429 too many requests', 1), 'quota');
  assert.equal(cloudFailureType('402 payment required', 1), 'billing');
  assert.equal(cloudFailureType('401 unauthorized', 1), 'auth');
  assert.equal(cloudFailureType('timeout', 1), 'temporary');
});

test('never invents unknown free allowance', () => {
  assert.equal(readFreeRemaining({ data: {} }), null);
  assert.equal(readFreeRemaining({ data: { free_model_daily_requests: { remaining: 6 } } }), 6);
});
