#!/usr/bin/env node
/**
 * Optional LIVE check. Uses one harmless AI request PER PROVIDER, which
 * consumes that provider's free allowance. It never submits project source.
 * Run only after confirming all configured accounts are actually on free plans.
 */
import { readFreeCatalog } from './openrouter-free-capacity.mjs';
import { buildCloudRoutes } from './free-cloud-routes.mjs';

if (process.env.DEVCODE_CLOUD_FALLBACK !== '1') {
  console.log('Cloud backups are disabled. Local DevCode is unaffected.');
  process.exit(0);
}
let openrouterModels = [];
if (process.env.OPENROUTER_API_KEY) {
  try { openrouterModels = await readFreeCatalog(); }
  catch (e) { console.error('OpenRouter model list unavailable: ' + e.message); }
}
const allRoutes = buildCloudRoutes(process.env, openrouterModels);
const seen = new Set();
let passed = 0, failed = 0;
for (const route of allRoutes) {
  // Probe only one model from each account, not all five OpenRouter models.
  if (seen.has(route.provider)) continue;
  seen.add(route.provider);
  const url = route.endpoint.replace(/\/$/, '') + '/chat/completions';
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + route.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: route.model, stream: false, max_tokens: 128,
        messages: [{ role: 'user',
          content: 'Call factory_marker with note OK. Do not answer with plain text.' }],
        tools: [{
          type: 'function',
          function: {
            name: 'factory_marker',
            description: 'Harmless test of the model calling a coding tool',
            parameters: { type: 'object', properties: { note: { type: 'string' } },
              required: ['note'] }
          }
        }]
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error('server rejected test: HTTP ' + response.status);
    const body = await response.json();
    const tools = body?.choices?.[0]?.message?.tool_calls ?? [];
    if (!tools.some((c) => c.function?.name === 'factory_marker')) {
      throw new Error('model answered but did not call the test tool');
    }
    console.log('PASS ' + route.provider + ' / ' + route.model);
    passed++;
  } catch (error) {
    console.error('NOT READY ' + route.provider + ': ' + error.message);
    failed++;
  }
}
console.log('Verified providers: ' + passed + '; not ready: ' + failed);
if (failed > 0 || passed === 0) process.exitCode = 1;
