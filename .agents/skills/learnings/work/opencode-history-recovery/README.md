---
title: Recover OpenCode-era conversations that never reached the session log
status: building (branch `recover-opencode-history`); dev proof done 2026-11-04; prod run waits for the release that ships the script
owner: platform
updated: 2026-11-04
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
`refused`.

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
- Open: the full dev run as a rehearsal; the prod run after the release; pi
  sessions with no log (146 Platinum since 08-19, `ses_pi…` roots) need a pi reader
  and are not covered.
