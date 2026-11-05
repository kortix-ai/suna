---
title: Recover OpenCode-era conversations that never reached the session log
status: dev rehearsal done 2026-11-05 (Platinum and Daytona); prod run waits for the release that ships the script (PR #11788)
owner: platform
updated: 2026-11-05
---

# Recover OpenCode-era conversations that never reached the session log

## Problem

The session log (`session_logs*`) is the only transcript store. The backfill that
filled it read the API's old copy (`session_transcript_messages`). That copy missed
whole classes of sessions:

- before 2026-08-26 it did not exist;
- until 2026-09-28 it was an off-by-default flag (`session_transcript_history`), so a
  session got a copy mostly when a person opened it (#7853, #8189);
- until 2026-09-29 a session another session's agent created saved nothing at turn
  end (#8177).

Their conversation lives only in OpenCode's store (`opencode.db`) on the session's
archived box. Since #11155 nothing reads it: the page shows an empty session, or
"This session's computer was lost" with only Delete when the box is gone. Ledger
entry `2026-11-04T182718Z-before-you-drop-the-old-store-of-a-data-migration-count-what.md`.

Prod, 2026-11-04 (not deleted, a turn on record, no session log): Platinum 1,544
(1,214 from 2026-08-19 to 10-11, 330 before), Daytona 6,069. Box samples: Platinum
40/40 `archived` for Aug–Oct, 20/40 gone before Aug 19; Daytona 30/30 `archived`.
Including sessions with only abandoned turns (many are a false-abandoned bug fixed in
#7807), the Platinum count since 08-19 is 6,412.

## How the recovery works

`apps/api/src/scripts/recover-opencode-history.ts`, one session at a time:

1. Candidate: not deleted, no session log, a turn on record, an OpenCode root (not
   `ses_pi…`), a parked box (`stopped`/`error`, no wake fence, not lost), no pending
   account deletion, no recorded outcome (or `retry` under 3 attempts).
2. Boot the box at the provider, not through Kortix: the session row stays
   `stopped`, the box token stays refused (no turn, no model call, no billing), the
   sidebar does not move.
3. Copy `opencode.db` + `-wal` (never `auth.json`) and the offloaded attachments to
   a temp folder; delete it after the session.
4. Re-read the Kortix row; if still parked, stop and archive the box. A box a person
   woke meanwhile keeps running.
5. Convert with the deleted kortixd exporter's mapping (`fromV1`), validate with
   `SessionLogSchema`, store attachments, write at generation 0 through
   `writeCapturedSessionLog`, only if the session still has no log and is parked.
6. Stamp `session_sandboxes.metadata.opencodeHistoryRecovery` (outcome, attempts,
   counts). Metadata only: no `updated_at`, no change notification.

The next wake of the box restores the log into pi (generation 0 → 1).

Outcomes: `written`, `converted` (dry run), `no_store`, `empty_store`, `box_gone`,
`unsupported_store`, `invalid`, `skipped` (the session changed), `retry`, `failed`,
`refused`, `too_large` (a store over 128 MiB or the row caps: set aside, not read).
`empty_store` carries `store_messages=0`; a store with message rows of which none
parse records `unsupported_store`.

`retry` is mostly a box another writer stopped during the copy, for example
Kortix's row-VM divergence sweep, which stops a running box whose row says
`stopped`. The next run takes it again, up to 3 attempts.

## Runbook

Run it as a one-off ECS task of the environment (the worker task definition: its
env, IAM and VPC), never on a laptop for prod: the files are customer data.

```bash
ENV=dev; REGION=us-east-2; CLUSTER=kortix-dev-use2; SERVICE=kortix-dev-use2-worker   # prod: prod / eu-west-2 / kortix-prod / kortix-prod-worker
TD=$(aws ecs describe-services --profile kortix --region $REGION --cluster $CLUSTER --services $SERVICE --query 'services[0].taskDefinition' --output text)
NET=$(aws ecs describe-services --profile kortix --region $REGION --cluster $CLUSTER --services $SERVICE --query 'services[0].networkConfiguration' --output json)
run() { aws ecs run-task --profile kortix --region $REGION --cluster $CLUSTER --task-definition "$TD" \
  --capacity-provider-strategy capacityProvider=FARGATE,weight=1 --network-configuration "$NET" \
  --overrides "{\"containerOverrides\":[{\"name\":\"worker\",\"command\":$1}]}" --query 'tasks[0].taskArn' --output text; }
run '["bun","src/scripts/recover-opencode-history.ts","--env","'$ENV'","--plan"]'
run '["bun","src/scripts/recover-opencode-history.ts","--env","'$ENV'","--limit","5"]'             # dry run
run '["bun","src/scripts/recover-opencode-history.ts","--env","'$ENV'","--limit","5","--apply"]'
run '["bun","src/scripts/recover-opencode-history.ts","--env","'$ENV'","--apply"]'                 # all Platinum, in batches of 200
run '["bun","src/scripts/recover-opencode-history.ts","--env","'$ENV'","--apply","--provider","daytona","--concurrency","2"]'
```

The output goes to the worker log group (`/ecs/kortix-<env>…`, stream prefix
`worker`): one `[recover]` line per session, a `done` line with the outcome counts.
The task image must contain the script: on prod, the release after the PR merged.

Stop rules (the run exits 1 by itself): 5 failures in a row; more than 2 invalid
logs and over 5 % of the processed sessions; the provider throttling for over 5
minutes. SIGTERM finishes the boxes in flight. Re-run to resume: finished sessions
are stamped and skipped.

## Status

- 2026-11-04: dev proof. Platinum session, 163 messages, 8.9 MB store; a
  project-visible session (OpenCode 1.17.11): `GET /log` 404 → 200 with 6
  messages, the web page shows the conversation, and the next wake restored it
  (generation 0 → 1). Daytona dry run: 3 messages, 32 s.
- 2026-11-05: full dev rehearsal, Platinum, one ECS task (worker task definition,
  concurrency 3): 782 sessions in 110.6 min, exit 0. 761 `written` (5,872
  messages, 180 attachments; p50 15 s, p95 42 s per session), 10 `empty_store`,
  10 `retry`, 1 `too_large` (227 MB store). After the run: all 785 touched boxes
  `archived`/`archiving`/`stopped` (0 `running`), 0 session rows with a new
  `updated_at`. 6 of the 10 `retry` waited 600 s on a box another writer had
  stopped; the fix fails them after 30 s. Rerun of the 10 with the fix: 8
  `written`, 1 `too_large`, 1 `retry`, in 1.3 min. The last `retry` was
  `written` by the deployed image (#11834): dev Platinum has no candidate left.
- 2026-11-05: Daytona dev rehearsal, one ECS task, concurrency 2: 136 sessions in
  59.7 min, exit 0. 92 `written` (2,603 messages; p50 57 s, p95 85 s per
  session), 36 `empty_store`, 3 `no_store`, 2 `box_gone`, 3 `retry`. Sampled
  `empty_store` stores hold the session's root with 0 message rows; `fromV1`
  merges every root into the session's thread, so 0 messages means no row
  parsed. Two Daytona starts answered 502 and the boxes booted later, after the
  cycle had parked them: they ran until Daytona's auto-stop (15–60 min). The fix
  waits for the box after a failed start and starts it again (3 attempts);
  `release` waits for a settled state. Rerun with the fix: both `502` sessions
  done (1 `written`, 1 `empty_store`). After it: all 136 boxes `archived` or
  `archiving`, except 2 in Daytona `error` since July.
- Prod Daytona estimate at the dev rate: 6,069 sessions × 57 s / 2 ≈ 48 h at
  concurrency 2. Daytona's disk quota is shared by every environment, so raise the
  concurrency only while watching it.
- Open: the prod run after the release; pi sessions with no log (146 Platinum
  since 08-19, `ses_pi…` roots) need a pi reader and are not covered.
