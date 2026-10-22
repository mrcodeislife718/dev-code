/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../../config/config.js';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../contentGenerator.js';
import { CopilotContentGenerator } from './copilot-content-generator.js';

export { CopilotContentGenerator } from './copilot-content-generator.js';
export { listCopilotModels, COPILOT_SIGN_IN_HINT } from './copilot-client.js';

export function createCopilotContentGenerator(
  contentGeneratorConfig: ContentGeneratorConfig,
  cliConfig: Config,
): ContentGenerator {
  return new CopilotContentGenerator(contentGeneratorConfig, cliConfig);
}
