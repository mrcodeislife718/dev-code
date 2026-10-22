# GitHub Copilot Provider

Status: implemented.

## Problem

Users with a GitHub Copilot subscription want to run Qwen Code's engineering engine on the models that subscription includes, without unofficial authentication or extracted tokens.

## Goals

- Add GitHub Copilot as a selectable provider (`AuthType.USE_GITHUB_COPILOT`, `github-copilot`).
- Support chat, streaming and Qwen Code tool execution.
- Keep Qwen Code's tools, permissions, sessions, memory and agents unchanged.

## Non-goals

Embeddings, forwarding reasoning effort, OpenTUI `/auth` parity.

## Design

- Transport is the official `@github/copilot-sdk`. It reuses the login from `copilot login`; Qwen Code handles no credentials.
- `CopilotContentGenerator` implements `ContentGenerator`. Each fresh request creates a Copilot session whose system message replaces Copilot's. Qwen's tools are registered as SDK custom tools and `availableTools` is restricted to exactly those names, so Copilot's built-ins are hidden.
- Qwen owns tool execution. When the model requests tools, the SDK handlers return pending promises and the stream ends with the `functionCall` parts. The follow-up Qwen request carries the `functionResponse` parts; the generator resolves the pending handlers and continues streaming from the same session. Suspended turns expire after 30 minutes and are closed on abort.
- Prior history is rendered as a text transcript in the first prompt of a fresh session; images in the latest message become attachments.
- `/auth` lists models via `listModels()` and saves them with `applyProviderInstallPlan`; no `apiKey` is required for this auth type.

## Risks

- The SDK is public preview and bundles a runtime binary; its API may change.
- Usage counts against the user's Copilot plan.

## Validation

Unit tests with a mocked SDK session (streaming, tool suspend/resume, errors) and plan-builder tests; live headless runs with a Copilot model, including multi-step tool use.
