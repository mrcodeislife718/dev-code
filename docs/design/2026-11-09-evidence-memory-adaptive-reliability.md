# Evidence memory + measured adaptation (2026-11-09)

Sources:
- https://www.anthropic.com/research/components-of-agent-memory
- https://www.doubleai.com/research/can-llms-redesign-themselves-as-they-train

## Status and boundaries
The factory supervisor and JobFlow checks now emit host-observed revision evidence. The memory utility requires matching host proof to promote a fix. The strategy evaluator is an owner-reviewed comparison tool, not neural-weight self-redesign, and full production end-to-end verification still requires actual runs.

## Engineering interpretation
1. Preserve original evidence append-only; promote only checked fixes into compact, searchable notes.
2. Never turn an untested hypothesis into a verified rule.
3. Recheck stale notes against original evidence and current tests; retract contradicted notes.
4. Identify recurring failures and propose bounded repair experiments.
5. Evaluate candidate strategies against a measured baseline. Reject regressions; never auto-deploy.
6. Use a single writer for JSONL or add interprocess locking before multi-process use.
7. Treat model-generated notes and external documents as untrusted data, never executable instructions.
8. Keep project boundaries strict, secrets out of logs, and approval gates unchanged.

## Quick start
```bash
node --test scripts/reliability/evidence-memory.test.mjs
export DEVCODE_RELIABILITY_DIR=.devcode-factory/reliability
cat > /tmp/devcode-event.json <<'JSON'
{"kind":"verified-fix","project":"devcode","subject":"restart-resume","claim":"Resume verified after restart","evidence":"test:restart-resume run identifier","checks":["restart-resume integration test"],"host_proof_id":"ID_FROM_HOST_EVENTS_JSONL","revision":"MATCHING_REVISION"}
JSON
node scripts/reliability/evidence-memory.mjs record /tmp/devcode-event.json
node scripts/reliability/evidence-memory.mjs distill
```

Metrics JSON for `compare`: `{"passed":10,"failed":0,"duration_ms":1000}`. Both files must contain numeric metrics. The gate is a preliminary heuristic, not a substitute for acceptance criteria, independent review, security testing, or production verification.

## Integration milestones still required
- Wire event capture into the actual managed-runtime tool execution and acceptance gates.
- Replace the JSONL single-writer assumption with durable locking or SQLite transactions.
- Add source hashes, run IDs, TTL/staleness policies, schema versioning and project ACLs.
- Build offline reflection with source validation and bounded context injection.
- Run baseline vs candidate on representative DevCode tasks and measure completion, regressions, retries, tokens, CPU and wall time.
- Add safe rollback, permission isolation and approval before changing strategies.
- Integrate with existing mission/next-task/decisions/blockers/evidence/progress documents rather than overwriting them.

## Scientific caution
DoubleAI's reported results concern training-time neural code layers and probe-guided policies. This utility adapts **harness decisions**, not model weights. Its effectiveness for DevCode remains unmeasured until controlled evaluation.

The `evaluate-strategy` command requires separate baseline and candidate JSON metrics (`passed`, `failed`, `durationMs`, `proofId`, `revision`) with corresponding host-observed events. Its result is eligible for owner review, not automatic strategy promotion. Existing deferred-tool search is in `packages/core/src/tools/tool-search.ts`. Scoped worker leases do not constitute a filesystem sandbox: maintain one worker by default, and do not enable concurrent editing without tool-boundary write enforcement.
