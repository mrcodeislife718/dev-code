/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CopilotClient, ModelInfo } from '@github/copilot-sdk';

export const COPILOT_SIGN_IN_HINT =
  'GitHub Copilot is not signed in. Run `copilot login` (GitHub Copilot CLI) and try again.';

/**
 * Starts the Copilot runtime that ships with the official `@github/copilot-sdk`.
 * It reuses the login created by `copilot login`; Qwen Code never reads or
 * stores GitHub tokens.
 */
export async function startCopilotClient(): Promise<CopilotClient> {
  const { CopilotClient: Client } = await import('@github/copilot-sdk');
  const client = new Client();
  await client.start();
  try {
    const status = await client.getAuthStatus();
    if (!status.isAuthenticated) {
      throw new Error(COPILOT_SIGN_IN_HINT);
    }
  } catch (error) {
    await client.stop().catch(() => undefined);
    throw error;
  }
  return client;
}

/** Lists the models the signed-in Copilot account may use. */
export async function listCopilotModels(): Promise<ModelInfo[]> {
  const client = await startCopilotClient();
  try {
    return await client.listModels();
  } finally {
    await client.stop().catch(() => undefined);
  }
}
