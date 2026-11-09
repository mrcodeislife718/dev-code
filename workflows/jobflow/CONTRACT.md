# JobFlow: production completion contract for DevCode

## Mission
JobFlow is the 24/7/365 growth and operations system for appointment-based businesses. A newly onboarded business must receive real after-hours requests through connected phone, SMS, website chat, email and supported social channels; understand and qualify the customer; check real availability; reserve a valid slot atomically; persist the customer, lead, conversation and booking; place it on the owner's calendar; obtain any required deposit; send confirmation; and report the business outcome. When a booking cannot be completed, create a durable recoverable lead or staff escalation. Never fabricate revenue, appointments or provider interactions.

The product is NOT a scheduling demo. The factory is DEVCode (the user's QwenCode fork), never Codeable or a replacement platform.

## Preserve the current implementation
- The newest work is on the user's local jobflow-completion branch, potentially ahead of GitHub. Work in that checkout; do not reset, overwrite, replace, cherry-pick older work over it, or recreate completed features.
- Historical completion checkpoints: Groups 1–3 commit 09e9afa; Group 4 commit d9fa3e3; earlier report 83 tests passing. Verify locally before treating as current proof.
- Resume at Group 5: owner services, durations, prices, employees, operating hours, exceptions, and availability, unless local inspection proves already complete.
- The user's existing LOCAL 30B model service is the only authorized inference provider. Do not silently switch to GitHub Copilot or another metered provider, alter provider settings, or buy/upgrade any subscription.
- Preserve working tree changes and user branches. No force pushes, resets, destructive actions, or unapproved deployments.

## Product requirements (not optional)
1. Self-service onboarding, verified owner/staff roles, multi-business tenant isolation, business profiles, service catalog, prices, duration, deposit rules, locations, staff eligibility, working hours, exceptions, and availability.
2. Canonical customer/lead identity, business-scoped data, consent, communication preferences, provenance, and conversation history spanning all channels without unsafe record merges.
3. Real incoming voice calls with natural AI conversation, intent/qualification, policy-grounded answers, appointment booking, staff escalation, call auditing, provider webhooks and privacy controls.
4. Real bidirectional SMS with delivery receipts, keyword opt-out enforcement, consent, reply handling, follow-up and booking completion.
5. Website chat, email and each supported connected social-messaging provider, feeding the same CRM, availability, appointment and history systems. Report missing channel integrations truthfully.
6. Transaction-safe real-time booking, rescheduling, cancellation, reminders, provider/service eligibility, appointment buffers, capacity, time zones, daylight saving, collision avoidance and calendar integration.
7. Missed-call detection and recovery, abandoned booking recovery, consent-aware campaigns, waitlists, no-show response, reactivation, and durable escalation tasks.
8. Owner inbox, customer profiles, appointment calendar, service and staff management, lead funnel, communication history, revenue attribution, recovered opportunity analysis and operational reporting.
9. Real payment/deposit/invoice/refund integration with Stripe payment and entitlement webhooks, proper signature checks, idempotency and actual money-accounting state.
10. Production authentication, authorization, tenant isolation at every storage/API boundary, consent, rate limiting, audit logs, secret protection, safe AI actions and abuse controls.
11. Real persistence and migrations, durable events/queues, retries/dead-letter recovery, restart survival, backups/restore proof, production monitoring, alerts, incident response and rollback.
12. Commercial readiness: self-service signup, pricing and subscription billing, operational docs, deployment pipeline, production environment, live channel provider enrollment, and verifiable end-to-end use.

## Execute, don't narrate
- Inspect the current checkout. Produce a durable requirements-to-code-to-test matrix with missing tasks and a dependency-ordered ledger in the project's .devcode-factory directory. Missing means unfinished, not skipped.
- Implement the next unfinished vertical slice. After each change run tests, inspect failures, repair, retest, and preserve evidence. Continue onto the next incomplete task.
- An actual vertical slice must work from customer/channel input -> receptionist or intake -> authorized booking tools -> durable database -> owner's real schedule -> customer confirmation -> measurable result.
- Test collisions, retries, duplicate webhooks, interruption recovery, timezone transitions, provider outages, tenant boundaries, payment failures, and opt-outs. Do not count mocks as evidence of LIVE provider integration.
- Never claim completion based on a green build alone. If an action requires the operator's live credentials, billing authorization, DNS, or production approval, identify the precise prerequisite and continue independent work.
- Keep implementing instead of producing planning-only replies when an executable issue remains.

## Independent acceptance checks
The runner invokes npm test, npm run build, and each named package script below. Implement substantive checks, not empty scripts or always-green stubs. Missing scripts are NOT VERIFIED. Every real-channel check must assert external evidence, not a simulated API.
- verify:owner: owner onboarding, pricing, staff and configuration.
- verify:booking: persisted real appointment, schedule display, concurrent booking prevention, changes/cancellations.
- verify:tenant: multi-tenant adversarial tests.
- verify:voice-live: inbound live phone call through the provider to an actual confirmed appointment.
- verify:sms-live: real inbound/outbound SMS and delivery acknowledgement.
- verify:web-chat: website visitor to real booked appointment.
- verify:email: email request to booked appointment/confirmed response.
- verify:social: supported connected social channel flows.
- verify:missed-call: no-answer recovery and human escalation.
- verify:followups: waitlist, reminders, consent, opt-out and reactivation.
- verify:payments-live: authorized real-provider payment/deposit/refund lifecycle and signed webhook handling.
- verify:notifications-live: actual confirmations, reminders, recipient and provider delivery.
- verify:continuity: crash/restart, durable queue replay and deduplication.
- verify:security: auth, tenant, permissions, rate limits, data leaks and secret handling.
- verify:monitoring: alerts, production operational health, restore and rollback verification.
- verify:production-live: authorized deployed production URL, real onboarding-to-appointment flow, healthy integrations and monitoring.

## Completion law
A factory reply is not a shipping signal. PRODUCTION VERIFIED requires all acceptance commands to run successfully and independently verifiable real provider/deployment proof. Otherwise report IN PROGRESS or BLOCKED with exact failing check and next repair. Never invent evidence or weaken tests to pass them.
