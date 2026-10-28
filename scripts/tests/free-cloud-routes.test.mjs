import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCloudRoutes, chooseCloudRoute, cloudCooldownMs, isCloudAllowedForWork } from '../free-cloud-routes.mjs';

const env = Object.freeze({
  DEVCODE_CLOUD_FALLBACK: '1',
  OPENROUTER_API_KEY: 'sk-or-test-1234567890',
  GROQ_API_KEY: 'gsk-test-1234567890',
  DEVCODE_GROQ_FREE_CONFIRMED: '1',
  GEMINI_API_KEY: 'gemini-test-1234567890',
  DEVCODE_GEMINI_FREE_CONFIRMED: '1',
  CLOUDFLARE_API_TOKEN: 'cloudflare-test-1234567890',
  CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  DEVCODE_CLOUDFLARE_FREE_CONFIRMED: '1',
});

test('all three additional free provider accounts have an actual route', () => {
  const list = buildCloudRoutes(env, ['recursive/flint-v1.0:free']);
  assert.equal(list.length, 4);
  for (const p of ['groq', 'google-ai-studio', 'cloudflare-workers-ai', 'openrouter']) {
    assert.equal(list.filter((r) => r.provider === p).length, 1);
    assert.ok(isCloudAllowedForWork(env, list.find((r) => r.provider === p)));
  }
});

test('no cloud route is enabled without opt-in and free-account confirmation', () => {
  assert.deepEqual(buildCloudRoutes({ ...env, DEVCODE_CLOUD_FALLBACK: '0' }, ['recursive/flint-v1.0:free']), []);
  const withoutConfirmation = {
    ...env, DEVCODE_GROQ_FREE_CONFIRMED: '0',
    DEVCODE_GEMINI_FREE_CONFIRMED: '0',
    DEVCODE_CLOUDFLARE_FREE_CONFIRMED: '0'
  };
  const list = buildCloudRoutes(withoutConfirmation, []);
  assert.equal(list.length, 0);
});

test('the provider pools rotate and one provider quota does not block others', () => {
  const list = buildCloudRoutes(env, ['recursive/flint-v1.0:free']);
  const now = Date.now();
  const first = chooseCloudRoute(list, { cloudCooldowns: {} }, now);
  const next = chooseCloudRoute(list, { cloudPreviousRoute: first.id }, now);
  assert.notEqual(first.id, next.id);
  const filtered = chooseCloudRoute(list, {
    cloudCooldowns: { openrouter: now + 600000 },
  }, now);
  assert.notEqual(filtered.provider, 'openrouter');
});

test('provider rate limits back off without installing artificial daily caps', () => {
  const now = Date.UTC(2026, 9, 28, 20);
  const oneMinute = cloudCooldownMs('quota', '429 rate limit', now);
  const daily = cloudCooldownMs('quota', 'daily limit reached', now);
  assert.equal(oneMinute, now + 90000);
  assert.ok(daily > now);
  assert.ok(cloudCooldownMs(null, '', now) === 0);
});
