/**
 * Zero-spend, opt-in OpenRouter redundancy for the existing DevCode runner.
 * Five independent model families, selected only when the live catalog says
 * that BOTH prompt and completion prices are zero and tool calls are supported.
 * Free capacity is shared per OpenRouter account; model rotation does not
 * multiply limits and must never be used to evade quotas.
 */
export const OPENROUTER_ROOT = 'https://openrouter.ai/api/v1';
export const PREFERRED_FREE_MODELS = Object.freeze([
  'thinkingmachines/inkling-small:free',
  'recursive/flint-v1.0:free',
  'cohere/north-mini-code:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'google/gemma-4-31b-it:free',
]);

export function isEligibleModel(entry) {
  return typeof entry?.id === 'string' &&
    PREFERRED_FREE_MODELS.includes(entry.id) &&
    entry.id.endsWith(':free') &&
    Number(entry.pricing?.prompt) === 0 &&
    Number(entry.pricing?.completion) === 0 &&
    entry.pricing?.prompt !== undefined &&
    entry.pricing?.completion !== undefined &&
    entry.architecture?.output_modalities?.includes('text') &&
    Array.isArray(entry.supported_parameters) &&
    entry.supported_parameters.includes('tools');
}

export async function readFreeCatalog(fetchFn = fetch) {
  const res = await fetchFn(OPENROUTER_ROOT + '/models', {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('OpenRouter catalog HTTP ' + res.status);
  const obj = await res.json();
  if (!Array.isArray(obj?.data)) throw new Error('Malformed OpenRouter model catalog');
  const eligible = new Set(obj.data.filter(isEligibleModel).map((m) => m.id));
  return PREFERRED_FREE_MODELS.filter((id) => eligible.has(id));
}

export function readFreeRemaining(body) {
  // API responds with {data:{free_model_daily_requests:{used,limit,remaining}}}.
  // Some accounts may omit this field, so we treat unknown as unknown.
  const meta = body?.data?.free_model_daily_requests;
  if (!meta) return null;
  const remaining = Number(meta.remaining);
  return Number.isFinite(remaining) ? Math.max(0, remaining) : null;
}

export async function freeQuotaRemaining(key, fetchFn = fetch) {
  const res = await fetchFn(OPENROUTER_ROOT + '/key', {
    headers: { Authorization: 'Bearer ' + key },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401 || res.status === 403) throw new Error('Invalid OpenRouter API key');
  if (!res.ok) throw new Error('OpenRouter quota HTTP ' + res.status);
  return readFreeRemaining(await res.json());
}

export function chooseFreeModel(eligible, previous = '') {
  if (!eligible.length) return null;
  const previousIndex = eligible.indexOf(previous);
  return eligible[(previousIndex + 1) % eligible.length];
}

export function cloudFailureType(output, exitCode) {
  if (exitCode === 0) return null;
  const s = String(output).toLowerCase();
  if (/\b429\b|rate.?limit|too many requests|daily limit|quota exceeded/.test(s)) return 'quota';
  if (/\b401\b|\b403\b|invalid api key|unauthorized/.test(s)) return 'auth';
  if (/\b402\b|insufficient credits|payment required/.test(s)) return 'billing';
  return 'temporary';
}
