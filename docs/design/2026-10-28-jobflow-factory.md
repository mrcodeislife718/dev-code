# JobFlow local-only production factory (2026-10-28)

## Problem
A Copilot subscription credit ceiling interrupted coding. JobFlow development also needs to continue from local Groups 1–4, preserve the user's local branch, and close every product and production gap rather than halt after generating code. Existing DevCode offers a headless CLI and session resume, but those alone are not an independently verified production-completion process.

## Implementation
- workflows/jobflow/CONTRACT.md captures the complete 24/7/365 appointment-business contract, channel coverage, and live release gates.
- scripts/jobflow-factory.mjs operates on an explicitly supplied *local* JobFlow working directory. It requires branch jobflow-completion; avoids resets, rebases and automatic pushes.
- The runner locates the existing DevCode model in the operator's QWEN_HOME/settings.json, validates a private-network/loopback OpenAI-compatible inference endpoint, and refuses metered Copilot/cloud fallback. It does not change credentials or provision models.
- It executes the DevCode launcher in that project, using structured headless output, captures the session ID, and resumes it on the next coding pass.
- It writes atomic state, run transcripts and evidence under JobFlow/.devcode-factory, preserving that directory if it already exists.
- After each coding pass, it invokes real npm test/build and a set of named production-acceptance scripts. Missing scripts are failed requirements, not passes. The acceptance matrix includes live voice, SMS, payments, confirmations and production deployment.
- A repeated no-progress condition stops with explicit BLOCKED status instead of consuming unlimited computation while doing nothing. Finite hardware and operational provider requirements are not vendor token quotas.
- The runner never pushes, deploys, purchases, changes DNS or releases real outbound communications. These require operator authorization.

## Entry points
- npm run jobflow:factory -- --project /absolute/path/to/jobflow
- npm run jobflow:factory -- --project /absolute/path/to/jobflow --once
- npm run jobflow:factory -- --project /absolute/path/to/jobflow --verify
- npm run jobflow:factory -- --project /absolute/path/to/jobflow --status
- npm run test:jobflow-factory

## Boundaries
The JobFlow checkout containing the latest local work is not accessible through the GitHub connector. This patch deliberately does not create a parallel implementation of its Group 5; it equips DevCode to run against the actual local checkout. Success of these factory tests does not prove JobFlow is released. Provider-live and production checks must actually run with approved credentials and a deployed service.

## Verification
Run Node's built-in focused tests. Then run the runner on the user's working checkout and inspect .devcode-factory/verification.json and evidence logs. Do not accept artificial always-green verify scripts. Review the complete changed diff before merging.
