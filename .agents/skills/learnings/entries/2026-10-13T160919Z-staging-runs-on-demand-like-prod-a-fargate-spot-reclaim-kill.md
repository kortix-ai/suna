---
recorded: 2026-10-13T16:09:19Z
incident_date: 2026-10-13
---
# Staging runs on-demand like prod: a Fargate Spot reclaim kills in-flight requests and agent turns mid-gate

**Rule:** Run staging's API and gateway on on-demand Fargate, the same capacity type as prod. Never `use_fargate_spot = true` outside dev.

**Trigger surface:** Changing `infra/terraform/environments/staging-*`, sizing staging, or triaging release-gate flakes.

**Incident:** 2026-10-13, v0.13.57 release gate 38399331524. Staging had run on FARGATE_SPOT since #4682 (2026-07-14). AWS reclaimed staging API tasks 4 times between 12:54 and 13:15 UTC (stopCode SpotInterruption). Each reclaim killed in-flight requests and running agent turns: GOLD-1 (commit-push 502), RUN-7 (turn abandoned), CFG-11/12 failed on attempt 1. The gate needed 4 attempts and still failed on unrelated edge drops.

**Enforcement:** `tests/unit/web-ecs-workflow.test.ts` (staging runs on the same capacity type and egress topology as prod) and `infra/cloudflare/workers/api-router/worker.test.mjs` (keeps staging sized for the release gate, on-demand like prod) fail on `use_fargate_spot = true` in a staging root.
