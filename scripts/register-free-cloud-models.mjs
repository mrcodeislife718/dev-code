#!/usr/bin/env node
/**
 * Add free cloud backup models to DevCode without replacing local Ollama.
 * This only writes model connections; provider keys remain in a private file.
 */
import { readFileSync, writeFileSync, existsSync, renameSync, copyFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PREFERRED_FREE_MODELS, OPENROUTER_ROOT } from './openrouter-free-capacity.mjs';
import { buildCloudRoutes } from './free-cloud-routes.mjs';

const target = process.argv[2] || join(homedir(), '.qwen', 'settings.json');
if (!existsSync(target)) throw new Error('DevCode settings file not found: ' + target);
const original = readFileSync(target, 'utf8');
const config = JSON.parse(original);
config.modelProviders ??= {};
const models = config.modelProviders.openai ??= [];
if (!Array.isArray(models)) throw new Error('DevCode model list invalid. Nothing changed.');

const context = {
  'thinkingmachines/inkling-small:free': 1048576,
  'recursive/flint-v1.0:free': 262144,
  'thinkingmachines/inkling:free': 1048576,
  'nvidia/nemotron-3-ultra-550b-a55b:free': 1000000,
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free': 256000,
  'openai/gpt-oss-120b': 131072,
  'gemini-3.8-flash': 1048576,
  '@cf/openai/gpt-oss-20b': 131072
};

const predefinedOpenRouter = process.env.OPENROUTER_API_KEY
  ? PREFERRED_FREE_MODELS
  : [];
// The dynamic catalog is rechecked by the runner before any OpenRouter call.
// Adding a connection here does not claim that its model is still online.
const routes = buildCloudRoutes(process.env, predefinedOpenRouter);
for (const route of routes) {
  // Never alter a configured local model or a different service's model.
  const prior = models.find((m) => m?.id === route.model && m?.baseUrl !== route.endpoint);
  if (prior) {
    throw new Error('Model ID is already in use at another server: ' + route.model +
      '. Preserved settings; review the conflict before changing anything.');
  }
  const proposed = {
    id: route.model,
    name: route.provider + ': ' + route.model,
    baseUrl: route.endpoint,
    envKey: 'OPENAI_API_KEY',
    wireApi: 'chat-completions',
    generationConfig: {
      contextWindowSize: context[route.model] || 131072,
      timeout: 120000,
      maxRetries: 0,
    }
  };
  const existing = models.find((m) => m?.id === route.model);
  if (existing) Object.assign(existing, proposed);
  else models.push(proposed);
}
// Keep the current model selection and ALL other entries.
const updated = JSON.stringify(config, null, 2) + '\n';
if (updated === original) {
  console.log('Cloud backup connections already registered. Local primary unchanged.');
  process.exit(0);
}
const backup = target + '.before-cloud-backups-' + new Date().toISOString().replaceAll(':', '-');
copyFileSync(target, backup);
const tempfile = target + '.tmp-' + process.pid;
writeFileSync(tempfile, updated, { mode: 0o600 });
renameSync(tempfile, target);
console.log('Registered ' + routes.length + ' backup models. Local primary unchanged.');
console.log('Settings backup saved to: ' + backup);
