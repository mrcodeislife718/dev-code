import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPrivateEndpoint, resolveLocalModel, listChecks, requiredChecks,
} from './jobflow-factory.mjs';

test('accepts loopback and private self-hosted inference endpoints', () => {
  for (const url of [
    'http://127.0.0.1:1234/v1',
    'http://localhost:8000/v1',
    'http://192.168.1.50:1234/v1',
    'http://10.0.0.12:8000/v1',
    'http://172.16.0.5:8000/v1',
    'http://100.80.3.2:4000/v1',
  ]) {
    assert.equal(isPrivateEndpoint(url), true, url);
  }
});

test('refuses cloud endpoints, unsafe protocols and malformed URLs', () => {
  for (const url of [
    'https://api.openai.com/v1',
    'https://api.githubcopilot.com',
    'https://openrouter.ai/api/v1',
    'file:///tmp/fake-v1',
    'http://example.com/v1',
    'not-a-url',
  ]) {
    assert.equal(isPrivateEndpoint(url), false, url);
  }
});

test('selects the existing private model without replacing configuration', () => {
  const settings = {
    security: { auth: { selectedType: 'openai' } },
    model: { name: 'devcode-coder:8k' },
    modelProviders: {
      openai: [{ id: 'devcode-coder:8k', baseUrl: 'http://127.0.0.1:1234/v1' }],
    },
  };
  assert.deepEqual(resolveLocalModel(settings, {}), {
    model: 'devcode-coder:8k',
    endpoint: 'http://127.0.0.1:1234/v1',
  });
  assert.equal(settings.model.name, 'devcode-coder:8k');
});

test('refuses Copilot authentication and metered remote fallbacks', () => {
  assert.throws(() => resolveLocalModel({
    security: { auth: { selectedType: 'github-copilot' } },
    model: { name: 'devcode-coder:8k' },
    modelProviders: { openai: [{ id: 'devcode-coder:8k', baseUrl: 'http://127.0.0.1:1234/v1' }] },
  }, {}), /not a local/);
  assert.throws(() => resolveLocalModel({
    security: { auth: { selectedType: 'openai' } },
    model: { name: 'paid-coder' },
    modelProviders: { openai: [{ id: 'paid-coder', baseUrl: 'https://example.com/v1' }] },
  }, {}), /not verified/);
});

test('requires each channel and production evidence gate rather than declaring completion from unit tests', () => {
  const onlyUnitTests = listChecks({ scripts: { test: 'node --test' } });
  assert.equal(onlyUnitTests.find((c) => c.id === 'tests').present, true);
  assert.equal(onlyUnitTests.find((c) => c.id === 'build').present, false);
  assert.equal(onlyUnitTests.find((c) => c.id === 'voice-live').present, false);
  assert.equal(onlyUnitTests.find((c) => c.id === 'production-live').present, false);
  assert.equal(onlyUnitTests.length, requiredChecks.length + 2);
});

test('requires every named acceptance command to be explicitly configured', () => {
  const scripts = { test: 'node --test', build: 'node scripts/build.mjs' };
  for (const name of requiredChecks) scripts['verify:' + name] = 'node scripts/verify-' + name + '.mjs';
  assert.equal(listChecks({ scripts }).every((c) => c.present), true);
});
