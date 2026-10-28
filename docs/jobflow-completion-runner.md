# JobFlow Completion Runner (DevCode)

The runnable supervisor is `scripts/jobflow-completion-runner.mjs`. It is an execution loop, not a guarantee that the model will successfully complete the project. It does not change branches, push, deploy, or install anything.

## Run on the machine containing the real JobFlow work

```bash
cd /path/to/dev-code
git fetch origin jobflow-completion-runner-20261028
git switch jobflow-completion-runner-20261028
JOBFLOW_DIR=/absolute/path/to/jobflow DEVCODE_BIN=devcode node scripts/jobflow-completion-runner.mjs
```

Use the actual existing checkout paths. Confirm `devcode -p "Reply READY"` uses the self-hosted Qwen3-Coder 30B model BEFORE starting. The runner inherits your current DevCode configuration and cannot guarantee the selected provider is local; disable metered providers in that configuration.

The JobFlow checkout must be on `jobflow-completion`, unless `JOBFLOW_ALLOW_BRANCH` explicitly names its actual branch. Never reset local commits or discard uncommitted changes. Logs are stored under `.jobflow-factory/` inside the JobFlow checkout. Set `JOBFLOW_MAX_CYCLES=1` for a first supervised trial. A zero max cycles means repeat until stopped or a verification record appears. The loop currently does not automatically relaunch after OS reboot; a process manager and health checks remain necessary.

## Product acceptance requirements

JobFlow must onboard appointment-based businesses, configure employees, services, pricing, schedules, exceptions and policies; provide 24/7 voice calls, two-way SMS, website chat, email and connected social messaging; answer inquiries and perform actual atomic bookings/rescheduling/cancellations; collect authorized deposits and handle webhooks; persist tenant-isolated customer and appointment records; send confirmations and reminders; recover missed calls and abandoned leads; provide CRM, revenue reporting, operations monitoring, recovery, and secure production deployment.

A complete acceptance run requires a real after-hours incoming call and two-way SMS, both resulting in a valid booking and confirmation visible on the owner's calendar. It must test double-booking contention, payment failures, channel outages, tenant isolation, unsubscribe/consent, backups and restore, and production monitoring. Unsupported third-party channels must be explicitly identified, not falsely claimed operational.

## Completion evidence

The runner asks DevCode to maintain `.jobflow-factory/requirements.md`, `progress.md`, `evidence.md`, and `blockers.md`. It watches for `PRODUCTION_VERIFIED.json`, but **does not independently validate the claims in that file**. A release must be independently audited before it can be represented as production-complete. External provider credentials and production changes require authorization.

Do not mistake a green unit-test suite, a written plan, or a self-reported AI status for an end-to-end production acceptance test.
