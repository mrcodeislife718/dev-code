#!/usr/bin/env node
/**
 * Register five $0 OpenRouter candidates with DevCode/Qwen Code while preserving
 * the existing local primary model, all other settings, and any credentials.
 * This installs model definitions only; no cloud inference happens here.
 */
import { readFileSync, writeFileSync, existsSync, renameSync, copyFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PREFERRED_FREE_MODELS, OPENROUTER_ROOT } from './openrouter-free-capacity.mjs';

const target = process.argv[2] || join(homedir(), '.qwen', 'settings.json');
if (!existsSync(target)) throw new Error('DevCode settings missing: ' + target);
const before = readFileSync(target, 'utf8');
const config = JSON.parse(before);
const catalog = config.modelProviders ?? (config.modelProviders = {});
const models = catalog.openai ?? (catalog.openai = []);
if (!Array.isArray(models)) throw new Error('Expected modelProviders.openai to be an array. Nothing changed.');
const sizes = {
  'thinkingmachines/inkling-small:free': 131072,
  'recursive/flint-v1.0:free': 131072,
  'cohere/north-mini-code:free': 131072,
  'nvidia/nemotron-3-ultra-550b-a55b:free': 131072,
  'google/gemma-4-31b-it:free': 65536
};
for (const id of PREFERRED_FREE_MODELS) {
  const existing = models.find((m) => m && m.id === id);
  const entry = {
    id,
    name: id.replace(':free', '') + ' [OpenRouter FREE]',
    baseUrl: OPENROUTER_ROOT,
    envKey: 'OPENAI_API_KEY',
    wireApi: 'chat-completions',
    generationConfig: {
      contextWindowSize: sizes[id] ?? 32768,
      maxRetries: 0,
      timeout: 120000
    }
  };
  if (existing) Object.assign(existing, entry);
  else models.push(entry);
}
// Do NOT change model.name or security.auth.selectedType: keep local primary.
const output = JSON.stringify(config, null, 2) + '\n';
if (output === before) { console.log('Five free model definitions already installed.'); process.exit(0); }
const backup = target + '.before-openrouter-free-' + new Date().toISOString().replaceAll(':', '-');
copyFileSync(target, backup);
const temp = target + '.tmp-' + process.pid;
writeFileSync(temp, output, { mode: 0o600 });
renameSync(temp, target);
console.log('Registered ' + PREFERRED_FREE_MODELS.length + ' cloud backups without changing the default local model.');
console.log('Backup: ' + backup);
