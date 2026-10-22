/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';

const mocks = vi.hoisted(() => ({
  listCopilotModels: vi.fn(),
  applyProviderInstallPlan: vi.fn(),
}));

vi.mock(
  '@qwen-code/qwen-code-core/core/copilot-content-generator/copilot-client.js',
  () => ({ listCopilotModels: mocks.listCopilotModels }),
);
vi.mock('@qwen-code/qwen-code-core/providers/install.js', () => ({
  applyProviderInstallPlan: mocks.applyProviderInstallPlan,
}));
vi.mock('../../config/loadedSettingsAdapter.js', () => ({
  createLoadedSettingsAdapter: () => ({}),
}));

import { connectGithubCopilot } from './copilot-connect.js';

const MODELS = [
  { id: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5', capabilities: {} },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', capabilities: {} },
];

const makeSettings = (merged: Record<string, unknown> = {}) =>
  ({ merged }) as unknown as LoadedSettings;

const makeConfig = () =>
  ({
    reloadModelProvidersConfig: vi.fn(),
    syncModelSelection: vi.fn(),
    refreshAuth: vi.fn(),
  }) as unknown as Config;

describe('connectGithubCopilot', () => {
  beforeEach(() => {
    mocks.listCopilotModels.mockReset().mockResolvedValue(MODELS);
    mocks.applyProviderInstallPlan.mockReset().mockResolvedValue(undefined);
  });

  it('saves every account model under github-copilot and selects the default', async () => {
    await connectGithubCopilot(makeSettings(), makeConfig());

    const [plan] = mocks.applyProviderInstallPlan.mock.calls[0]!;
    expect(plan.authType).toBe('github-copilot');
    expect(plan.modelSelection).toEqual({ modelId: 'claude-sonnet-5.5' });
    expect(
      plan.modelProviders[0].models.map((m: { id: string }) => m.id),
    ).toEqual(['claude-sonnet-5.5', 'gpt-6-luna']);
  });

  it('keeps the selected model when Copilot is already the active provider', async () => {
    await connectGithubCopilot(
      makeSettings({
        security: { auth: { selectedType: 'github-copilot' } },
        model: { name: 'gpt-6-luna' },
      }),
      makeConfig(),
    );

    const [plan] = mocks.applyProviderInstallPlan.mock.calls[0]!;
    expect(plan.modelSelection).toEqual({ modelId: 'gpt-6-luna' });
  });

  it('ignores the selected model of another provider', async () => {
    await connectGithubCopilot(
      makeSettings({
        security: { auth: { selectedType: 'openai' } },
        model: { name: 'gpt-6-luna' },
      }),
      makeConfig(),
    );

    const [plan] = mocks.applyProviderInstallPlan.mock.calls[0]!;
    expect(plan.modelSelection).toEqual({ modelId: 'claude-sonnet-5.5' });
  });

  it('wires the install callbacks to the running config', async () => {
    const config = makeConfig();
    await connectGithubCopilot(makeSettings(), config);

    const [, deps] = mocks.applyProviderInstallPlan.mock.calls[0]!;
    deps.reloadModelProviders({});
    deps.syncAuthState('github-copilot', 'gpt-6-luna', undefined);
    deps.refreshAuth('github-copilot');
    expect(config.reloadModelProvidersConfig).toHaveBeenCalledWith({});
    expect(config.syncModelSelection).toHaveBeenCalledWith(
      'github-copilot',
      'gpt-6-luna',
      undefined,
    );
    expect(config.refreshAuth).toHaveBeenCalledWith('github-copilot');
  });

  it('propagates a sign-in failure without writing any settings', async () => {
    mocks.listCopilotModels.mockRejectedValue(new Error('not signed in'));

    await expect(
      connectGithubCopilot(makeSettings(), makeConfig()),
    ).rejects.toThrow('not signed in');
    expect(mocks.applyProviderInstallPlan).not.toHaveBeenCalled();
  });

  it('rejects an account with no models', async () => {
    mocks.listCopilotModels.mockResolvedValue([]);

    await expect(
      connectGithubCopilot(makeSettings(), makeConfig()),
    ).rejects.toThrow(/no available models/);
    expect(mocks.applyProviderInstallPlan).not.toHaveBeenCalled();
  });
});
