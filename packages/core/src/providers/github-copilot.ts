/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../utils/auth-type.js';
import type { ReasoningEffort } from '../core/reasoning-effort.js';
import type { ProviderInstallPlan, ProviderModelConfig } from './types.js';

export const GITHUB_COPILOT_PROVIDER_ID = 'github-copilot';

/** Subset of the Copilot SDK `ModelInfo` that the install plan needs. */
export interface CopilotModelSummary {
  id: string;
  name?: string;
  capabilities?: {
    supports?: { vision?: boolean };
    limits?: { max_context_window_tokens?: number };
  };
  supportedReasoningEfforts?: readonly ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
}

export function copilotModelsToConfigs(
  models: readonly CopilotModelSummary[],
): ProviderModelConfig[] {
  return models.map((model) => {
    const config: ProviderModelConfig = {
      id: model.id,
      name: `Copilot: ${model.name ?? model.id}`,
    };
    if (model.capabilities?.supports?.vision) {
      config.capabilities = { vision: true };
    }
    const efforts = model.supportedReasoningEfforts;
    if (efforts && efforts.length > 0) {
      config.capabilities = {
        ...config.capabilities,
        reasoning: {
          thinking: true,
          efforts,
          ...(model.defaultReasoningEffort
            ? { defaultEffort: model.defaultReasoningEffort }
            : {}),
          disableField: 'reasoning_effort',
        },
      };
    }
    const contextWindowSize =
      model.capabilities?.limits?.max_context_window_tokens;
    if (contextWindowSize) {
      config.generationConfig = { contextWindowSize };
    }
    return config;
  });
}

/**
 * Builds the install plan that saves the account's Copilot models and
 * selects one. No credentials are involved: sign-in is owned by the Copilot SDK.
 */
export function buildGithubCopilotInstallPlan(
  models: readonly CopilotModelSummary[],
  preferredModelId?: string,
): ProviderInstallPlan {
  const configs = copilotModelsToConfigs(models);
  if (configs.length === 0) {
    throw new Error('Your GitHub Copilot account has no available models.');
  }
  const selected =
    configs.find((m) => m.id === preferredModelId) ??
    configs.find((m) => m.id === 'claude-sonnet-5.5') ??
    configs[0]!;
  return {
    providerId: GITHUB_COPILOT_PROVIDER_ID,
    authType: AuthType.USE_GITHUB_COPILOT,
    modelSelection: { modelId: selected.id },
    modelProviders: [
      {
        authType: AuthType.USE_GITHUB_COPILOT,
        models: configs,
        mergeStrategy: 'replace-owned',
        ownsModel: () => true,
      },
    ],
  };
}
