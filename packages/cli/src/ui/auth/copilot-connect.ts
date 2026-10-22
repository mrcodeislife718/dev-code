/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import { listCopilotModels } from '@qwen-code/qwen-code-core/core/copilot-content-generator/copilot-client.js';
import { buildGithubCopilotInstallPlan } from '@qwen-code/qwen-code-core/providers/github-copilot.js';
import { applyProviderInstallPlan } from '@qwen-code/qwen-code-core/providers/install.js';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { createLoadedSettingsAdapter } from '../../config/loadedSettingsAdapter.js';

/**
 * Signs in through the official Copilot SDK, saves the account's models under
 * `modelProviders["github-copilot"]` and selects one. The model that is already
 * selected is kept when Copilot was the active provider.
 */
export async function connectGithubCopilot(
  settings: LoadedSettings,
  config: Config,
): Promise<void> {
  const plan = buildGithubCopilotInstallPlan(
    await listCopilotModels(),
    settings.merged.security?.auth?.selectedType === AuthType.USE_GITHUB_COPILOT
      ? settings.merged.model?.name
      : undefined,
  );
  await applyProviderInstallPlan(plan, {
    settings: createLoadedSettingsAdapter(settings),
    reloadModelProviders: (mp) => config.reloadModelProvidersConfig(mp),
    syncAuthState: (authType, modelId, baseUrl) =>
      config.syncModelSelection(authType, modelId, baseUrl),
    refreshAuth: (authType) => config.refreshAuth(authType),
  });
}
