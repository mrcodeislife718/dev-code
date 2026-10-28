---
name: jobflow-production
description: Run the existing DevCode fork as a local-only implementation factory to finish the JobFlow 24/7/365 AI receptionist, real multi-channel booking, business operations, payments and production-verification requirements.
---

# JobFlow Production Completion

This is an **execution** skill, not a brainstorming or planning response.

## Execute
1. Inspect the actual local JobFlow checkout and confirm the existing jobflow-completion branch. Do not recreate, reset or overwrite Groups 1–4.
2. Read workflows/jobflow/CONTRACT.md in the DevCode repository. The contract defines required behaviors and independent production gates. Existing implementation beats any historical status claim.
3. Run the existing local model and never route to Copilot or a paid model automatically. If the configured provider is not local, stop and report the precise configuration problem; never silently change the user's credentials.
4. From the DevCode checkout, launch:
   npm run jobflow:factory -- --project /absolute/path/to/jobflow
5. On every pass, inspect the state and evidence in the JobFlow checkout's .devcode-factory directory. Change actual source code, execute tests, repair failures, and proceed to the next incomplete requirement.
6. Run npm run jobflow:factory -- --project /absolute/path/to/jobflow --verify for an independent non-inference validation pass.
7. Never call a project production-ready unless the real telephony, messaging, calendar, consent, payments, security and deployed production user journey are independently verified with authorized live provider evidence.

## Stop behavior
A quota on Copilot is **not** an acceptable reason to stop: use the already configured self-hosted 30B model. If real external credentials, approved deployment, secrets, or account enrollments are required, mark the exact work blocked and continue work that does not depend on them. Do not invent provider results or run destructive production commands.
