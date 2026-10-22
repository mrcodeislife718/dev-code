/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '../utils/auth-type.js';
import { buildGithubCopilotInstallPlan } from './github-copilot.js';

describe('buildGithubCopilotInstallPlan', () => {
  const models = [
    { id: 'gpt-5.3-codex', name: 'GPT 5.3 Codex' },
    {
      id: 'claude-sonnet-5.5',
      name: 'Claude Sonnet 5.5',
      capabilities: {
        supports: { vision: true },
        limits: { max_context_window_tokens: 200000 },
      },
    },
  ];

  it('saves every account model under the Copilot auth type without credentials', () => {
    const plan = buildGithubCopilotInstallPlan(models, 'gpt-5.3-codex');
    expect(plan.authType).toBe(AuthType.USE_GITHUB_COPILOT);
    expect(plan.env).toBeUndefined();
    expect(plan.legacyCredentials).toBeUndefined();
    expect(plan.modelSelection).toEqual({ modelId: 'gpt-5.3-codex' });
    const patch = plan.modelProviders![0]!;
    expect(patch.models.map((m) => m.id)).toEqual([
      'gpt-5.3-codex',
      'claude-sonnet-5.5',
    ]);
    expect(patch.models[1]).toMatchObject({
      capabilities: { vision: true },
      generationConfig: { contextWindowSize: 200000 },
    });
  });

  it('defaults to Claude Sonnet when present, else the first model', () => {
    expect(buildGithubCopilotInstallPlan(models).modelSelection?.modelId).toBe(
      'claude-sonnet-5.5',
    );
    expect(
      buildGithubCopilotInstallPlan([{ id: 'x' }]).modelSelection?.modelId,
    ).toBe('x');
  });

  it('rejects an account with no models', () => {
    expect(() => buildGithubCopilotInstallPlan([])).toThrow(/no available/);
  });

  it('declares reasoning efforts only for models that support them', () => {
    const plan = buildGithubCopilotInstallPlan([
      {
        id: 'thinker',
        supportedReasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'low',
      },
      { id: 'plain' },
    ]);
    const [thinker, plain] = plan.modelProviders![0]!.models;
    expect(thinker!.capabilities?.reasoning).toEqual({
      thinking: true,
      efforts: ['low', 'high'],
      defaultEffort: 'low',
      disableField: 'reasoning_effort',
    });
    expect(plain!.capabilities).toBeUndefined();
  });
});
