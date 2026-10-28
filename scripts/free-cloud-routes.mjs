/**
 * Free-tier-only cloud backup routes for the existing DevCode supervisor.
 *
 * No model is treated as "unlimited" or guaranteed free on a paid account.
 * The owner must explicitly confirm free-tier account status for services
 * whose APIs cannot tell us whether charges would apply.
 */
import { OPENROUTER_ROOT } from './openrouter-free-capacity.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

export function buildCloudRoutes(env, openrouterModels = []) {
  if (env.DEVCODE_CLOUD_FALLBACK !== '1') return [];

  const routes = [];
  const key = env.OPENROUTER_API_KEY;
  if (typeof key === 'string' && key.length > 15) {
    for (const model of openrouterModels) {
      if (!model.endsWith(':free')) continue;
      routes.push({
        id: 'openrouter/' + model,
        provider: 'openrouter',
        model,
        endpoint: OPENROUTER_ROOT,
        apiKey: key,
      });
    }
  }

  // These providers have their OWN allowances, independent of OpenRouter.
  // Never enable a chargeable service without confirmation it is a free account.
  if (env.GROQ_API_KEY && env.DEVCODE_GROQ_FREE_CONFIRMED === '1') {
    routes.push({
      id: 'groq/gpt-oss-120b',
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      endpoint: 'https://api.groq.com/openai/v1',
      apiKey: env.GROQ_API_KEY,
    });
  }
  if (env.GEMINI_API_KEY && env.DEVCODE_GEMINI_FREE_CONFIRMED === '1') {
    routes.push({
      id: 'gemini/3.8-flash',
      provider: 'google-ai-studio',
      model: 'gemini-3.8-flash',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: env.GEMINI_API_KEY,
    });
  }
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  if (env.CLOUDFLARE_API_TOKEN &&
      env.DEVCODE_CLOUDFLARE_FREE_CONFIRMED === '1' &&
      typeof account === 'string' &&
      /^[0-9a-f]{32}$/i.test(account)) {
    routes.push({
      id: 'cloudflare/gpt-oss-20b',
      provider: 'cloudflare-workers-ai',
      model: '@cf/openai/gpt-oss-20b',
      endpoint: 'https://api.cloudflare.com/client/v4/accounts/' + account + '/ai/v1',
      apiKey: env.CLOUDFLARE_API_TOKEN,
    });
  }
  return routes;
}

export function chooseCloudRoute(routes, state, now = Date.now()) {
  if (!routes.length) return null;
  const allowed = routes.filter((r) =>
    Number(state.cloudCooldowns?.[r.provider] || 0) <= now &&
    Number(state.cloudCooldowns?.[r.id] || 0) <= now);
  if (!allowed.length) return null;
  const previous = allowed.findIndex((r) => r.id === state.cloudPreviousRoute);
  return allowed[(previous + 1) % allowed.length];
}

export function tomorrowUTC(now = Date.now()) {
  const day = new Date(now);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1, 0, 5);
}

export function cloudCooldownMs(kind, details = '', now = Date.now()) {
  if (!kind) return 0;
  const s = String(details).toLowerCase();
  if (kind === 'quota' && /daily|per.day|day.limit|limit_exceeded/.test(s))
    return tomorrowUTC(now);
  // Back off on requests-per-minute / temporary failures.
  if (kind === 'quota') return now + 90 * 1000;
  if (kind === 'temporary') return now + 60 * 1000;
  // Don't retry invalid credentials or insufficient balance endlessly.
  if (kind === 'auth' || kind === 'billing') return now + DAY_MS;
  return now + 60 * 1000;
}

export function isCloudAllowedForWork(env, route) {
  if (!route) return false;
  if (env.DEVCODE_CLOUD_FALLBACK !== '1') return false;
  if (route.provider === 'openrouter') return route.model.endsWith(':free');
  if (route.provider === 'groq') return env.DEVCODE_GROQ_FREE_CONFIRMED === '1';
  if (route.provider === 'google-ai-studio') return env.DEVCODE_GEMINI_FREE_CONFIRMED === '1';
  if (route.provider === 'cloudflare-workers-ai')
    return env.DEVCODE_CLOUDFLARE_FREE_CONFIRMED === '1';
  return false;
}
