# API latency baseline

Every API performance change (refactor plan R1) reports a measured before/after
with this runbook. The baseline below is the "before" for R1.

## What the bench measures

`apps/api/scripts/prompt-latency-bench.ts` runs N sessions. Per session it
calls `POST /sessions`, polls `POST /start` until `stage: ready`, polls the
daemon's `/kortix/health` until `runtimeReady`, opens one `GET /events` stream,
and sends 3 prompts through `POST /prompts` (the web client's path):
T1 "pong", T2 one bash tool call, T3 "ping". It records:

| Row | Source |
| --- | --- |
| `POST /sessions`, `POST /prompts` wall | client clock |
| `server total`, `db dur`, `db n`, `git dur`, `git n` | the response's `Server-Timing` (`db;dur=…;desc="n=…"`, `apps/api/src/lib/server-timing.ts`) |
| `delivery: log deliver/proxy total` and the stage rows | `[provision-timeline] deliver|proxy` lines in the API log (`BENCH_API_LOG`) |
| `delivery: created→forwarded (DB)` | `kortix.session_lifecycle_commands` `created_at` → `result.forwarded_at` (`BENCH_DB_URL`) |
| `POST→busy`, `POST→idle` | `session.status` frames on `/events` |

It writes one JSON line per session (real ids: keep it in the gitignored
`output/`) and prints a p50/p90 table. `report <file.jsonl>…` prints the table
again; with `BENCH_API_LOG` set it re-reads the delivery lines first.
The header of the script lists every `BENCH_*` variable.

`apps/api/scripts/latency-proxy.ts` is a TCP relay that delays each chunk by a
fixed one-way time. At 25 ms one-way it gives the local API the 50 ms RTT to its
database that the dev API had on 2026-09-19. postgres.js pays 2 round trips per
parameterized statement, so the statement count becomes wall time, as on dev.

## Local run

Use a worktree stack with the cloudflared tunnel (cloud sandboxes call back to
the API). Slot ports below are `<web>`, `<api>`, `<sb-api>`, `<sb-db>`.

1. Start the stack, API stdout into a log file:
   `pnpm worktree start <name> > output/stack-direct.log 2>&1` (in the background).
2. Create a synthetic user and project. `POST <sb-api>/auth/v1/admin/users`
   `{email, password, email_confirm: true}` with the service-role key, then
   `POST <sb-api>/auth/v1/token?grant_type=password` with the anon key, then
   `GET /v1/accounts` and `POST /v1/projects/provision {name}`. Keys:
   `supabase --workdir ~/.kortix/worktrees/<name>/sb status -o env`. For a new
   token later, use `admin/generate_link {type:'magiclink'}` then
   `auth/v1/verify {type:'magiclink', token_hash}`.
3. Run arm 0 ms from a directory OUTSIDE the worktree. `pnpm worktree stop`
   kills every dev process whose cwd is inside the worktree, including a bench.
   ```bash
   cd /tmp && BENCH_API=http://localhost:<api>/v1 BENCH_TOKEN=<jwt> BENCH_PROJECT=<project_id> \
     BENCH_LABEL=local-0ms BENCH_SESSIONS=6 BENCH_MODEL=deepseek-v4.1-flash BENCH_PROVIDER=platinum \
     BENCH_API_LOG=<repo>/output/stack-direct.log \
     BENCH_DB_URL=postgresql://postgres:postgres@127.0.0.1:<sb-db>/postgres \
     bun <repo>/apps/api/scripts/prompt-latency-bench.ts
   ```
4. Arm 50 ms RTT. Stop the stack, start two relays from outside the worktree,
   and restart the stack with the API pointed at them
   (`scripts/worktree/lib/launch-env.ts` reads the two overrides):
   ```bash
   pnpm worktree stop <name>
   cd /tmp && bun <repo>/apps/api/scripts/latency-proxy.ts 14391 127.0.0.1 <sb-db> 25 &
   cd /tmp && bun <repo>/apps/api/scripts/latency-proxy.ts 14392 127.0.0.1 <sb-api> 25 &
   KORTIX_WT_API_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:14391/postgres \
   KORTIX_WT_API_SUPABASE_URL=http://127.0.0.1:14392 \
     pnpm worktree start <name> > output/stack-50ms.log 2>&1
   ```
   Check the relay before the run: a `select 1` through `14391` takes ~54 ms,
   direct ~0.3 ms. Check that the API's Postgres sockets go to `14391`
   (`lsof -iTCP:<sb-db> -sTCP:ESTABLISHED` shows only the relay and Docker).
   Run step 3 with `BENCH_LABEL=local-50ms` and the new log.
5. Restore: `pnpm worktree stop <name>`, kill both relays, start the stack
   without the two variables.

## Dev run

`https://dev-api.kortix.com/v1`. Synthetic user only. From `apps/api`, under
`dotenvx run -f .env.dev --` (key in `apps/api/.env.keys`): create the user with
`admin/users` (as above; `mailer_autoconfirm` is off on dev), mint a JWT with
`admin/generate_link` + `verify {token_hash}`, provision a project. Run the
bench with `BENCH_API=https://dev-api.kortix.com/v1`,
`BENCH_DB_URL=$(dotenvx get DATABASE_URL -f .env.dev)` and no `BENCH_API_LOG`.
`Server-Timing` passes the Cloudflare edge. The delivery log lines are in
CloudWatch only; without AWS access for dev, `created→forwarded (DB)` is the
dev delivery number. Stop every session you start (`DELETE
/v1/projects/<project_id>/sessions/<session_id>`, the bench does it unless
`BENCH_KEEP=1`).

## Session-open request count

Use agent-browser with one named session, and count requests to the API host
in a HAR.

1. Run the bench with `BENCH_SESSIONS=1 BENCH_KEEP=1` to get a ready session.
2. Sign in. Local: `/auth` → email → Continue → open the sign-in link from
   Mailpit (`127.0.0.1:<sb-inbucket>/api/v1/messages`) in the same browser
   session, then finish the onboarding once.
   Dev: do NOT use `agent-browser set credentials`. It sends `Authorization:
   Basic` on every request, which replaces the Bearer token: GoTrue and the API
   answer 401 and the app signs out. Instead, `curl -u kortix:<pw>
   https://dev.kortix.com/auth` (`<pw>` = `WEB_PROTECTION_PASSWORD` from
   `apps/web/.env.dev`) and copy its `__Secure-kortix_test_access` Set-Cookie
   into the browser. Then set `sb-kortix-auth-token` on
   `https://dev.kortix.com`: `base64-` + base64url of the `verify` session JSON,
   split into `.0`, `.1`, … above 3,180 characters. Use
   `agent-browser cookies set <name> <value> --url https://dev.kortix.com`.
3. Hard load: `agent-browser network har start`, `open
   <web>/projects/<project_id>/sessions/<session_id>`, `wait 20000`,
   `network har stop <file>.har`. In-app open: from the project page, start
   the HAR, click the session in the sidebar, wait 20 s, stop.
4. Count entries whose host is the API host, by method and path with ids
   replaced. The first load in a fresh browser adds CORS preflights
   (53 `OPTIONS` in the first local load, which also ran the onboarding); the
   counts below exclude them (preflight cache warm).
5. Stop the kept session and the warm session the page started (`POST …/sessions/warm`).

## Baseline, 2026-09-29

Code: branch `api-guard-rails` at `91199954d4` (base `ffb860c816` + origin/main
merged, no performance change). Dev ran `527b4a4f36` (main; its `apps/api/src`
diff against the branch's merged main touches 6 files, none on the prompt path).
Machine: Apple M4 Max, 36 GB, macOS 15.3, Bun 1.4.0, laptop in Europe
(Cloudflare edge 8 ms, dev-api `/health` TTFB ~215 ms). Provider Platinum,
harness OpenCode, model `deepseek-v4.1-flash` (the platform default on local
and dev). All 72 turns answered correctly. Values in ms, p50 / p90. n = 6
sessions and 18 turns per local arm, 12 sessions and 36 turns on dev (2 batches
of 6, 17:08–17:31 UTC).

| Metric | Local, DB direct | Local, 50 ms RTT | Dev |
| --- | --- | --- | --- |
| POST /sessions wall | 640 / 760 | 1,797 / 2,198 | 2,477 / 3,343 |
| POST /sessions server total | 639 / 759 | 1,792 / 2,192 | 2,266 / 3,142 |
| POST /sessions db dur | 16 / 26 | 997 / 1,212 | 1,477 / 2,495 |
| POST /sessions db n | 9 / 9 | 9 / 18 | 12 / 22 |
| POST /sessions git dur (n = 5) | 590 / 676 | 659 / 1,013 | 605 / 852 |
| session ready (create→`runtimeReady`) | 9,057 / 10,698 | 13,769 / 14,726 | 36,540 / 104,863 |
| POST /prompts wall | 16 / 27 | 861 / 1,330 | 1,568 / 3,234 |
| POST /prompts server total | 14 / 25 | 860 / 1,329 | 1,345 / 3,010 |
| POST /prompts db dur | 12 / 19 | 854 / 1,314 | 1,321 / 2,943 |
| POST /prompts db n | 8 / 14 | 8 / 16 | 16 / 19 |
| delivery: `deliver` total | 994 / 2,069 | 3,796 / 5,071 | not measured |
| delivery: `proxy` total | 867 / 1,898 | 2,673 / 4,050 | not measured |
| delivery: created→forwarded (DB) | 1,206 / 2,298 | 4,365 / 5,426 | 5,977 / 12,139 |
| POST→busy | 1,162 / 2,221 | 4,648 / 5,574 | 6,687 / 13,681 |
| POST→idle | 2,967 / 3,748 | 7,160 / 8,634 | 13,358 / 20,607 |

Delivery stages, p50 (the rows an R1 change moves; each is the delta from the
previous mark of its line):

| Stage | Local, DB direct | Local, 50 ms RTT |
| --- | --- | --- |
| `deliver` admission | 3 | 216 |
| `deliver` staged-revert | 1 | 105 |
| `deliver` session-read | 1 | 109 |
| `deliver` delivered (contains the whole `proxy` line) | 987 | 3,153 |
| `deliver` marked | 4 | 112 |
| `proxy` load-sandbox | 1 | 107 |
| `proxy` env-sync | 624 | 1,767 |
| `proxy` turn-begin | 6 | 215 |
| `proxy` upstream (API→sandbox `prompt_async`) | 204 | 202 |
| `proxy` turn-accept | 7 | 323 |

Notes on the numbers:

- Each statement costs ~2 round trips: at 50 ms RTT, POST /prompts spends
  854 ms on 8 statements (~107 ms each). Dev spends 1,321 ms on 16 (~83 ms each).
- Dev runs twice the statements of local on POST /prompts (16 vs 8) and 3 more
  on POST /sessions. The local stack runs without `--billing`; the extra dev
  statements are not attributed yet.
- `git` (5 operations, ~600 ms) is most of POST /sessions on every arm.
- Dev tails are wide: session ready 21.8–222.8 s, 9 of 36 turns waited more
  than 10 s for `busy` (max 39.2 s). Compare dev p50, not p90, across runs.
- Dev `deliver`/`proxy` lines are in CloudWatch. This run had no AWS access
  for dev, so dev delivery is the DB number only.

Session open, API requests excluding CORS preflights:

| Open | Local total | Local platform / sandbox proxy | Dev total | Dev platform / sandbox proxy |
| --- | --- | --- | --- | --- |
| hard load of the session URL | 63, 63 | 48 / 15 | 60, 62 | 45–47 / 15 |
| in-app click from the project page | 33 | 19 / 14 | 29 | 15 / 14 |

Both hard loads hit 49 distinct routes. Repeated reads in the hard load:
`GET /projects/:id/sessions` ×7 (3 filter variants each sent twice, plus 1
unfiltered), `GET …/sessions/:id/transcript` ×4 locally and ×3 on dev (the same
2 query shapes), and ×2 each for `GET /projects/:id`, `GET …/sessions/:id`,
`GET …/change-requests`, `GET …/turn` and `GET …/prompts` (`…/turn` and
`…/prompts` once in 1 of the 2 dev loads). The in-app open repeats
`…/transcript` (×3–4), `…/sessions` (×3) and `…/sessions/:id` (×2); locally also
`…/turn` and `…/prompts` (×2). A session page also calls `POST …/sessions/warm`, which starts
a new warm session with a sandbox: stop it after a capture.

Comparison with 2026-09-19 (same method and 50 ms RTT, before / after PR #7430,
which is merged): POST /prompts 1,057 / 562 ms, delivery 5,516 / 3,617 ms,
POST→busy 5.6–7.4 / 3.9–5.1 s. Today's 50 ms arm: 861 ms, 3,796 ms, 4.6 s p50.

## After R1 (hot path), 2026-10-02

Same machine, provider, harness and model as the baseline above. The baseline
was measured again on the day, at `39df4d0379` (`main`), because the prompt
path changed after 2026-09-29. "R1" is branch `api-hot-path` with `main`
`ee857c9aca` merged. All 45 turns answered correctly. Values in ms, p50 / p90.
50 ms arms: 4 sessions and 12 turns each. Direct arm: 3 sessions and 9 turns
(baseline direct: 1 session, 3 turns, p50 only).

Restart the stack before every arm (`pnpm worktree stop`, then `start`): the
bench fails a run that crosses a hot reload, and a stack that reloaded before
the run is slow for another reason (learnings, 2026-10-02).

| Metric | Baseline, 50 ms | R1, 50 ms | R1 + prepared, 50 ms | Baseline, direct | R1, direct |
| --- | --- | --- | --- | --- | --- |
| POST /sessions wall | 1,833 / 2,444 | 818 / 1,645 | 593 / 1,140 | 911 | 66 / 93 |
| POST /sessions db dur | 956 / 1,396 | 647 / 935 | 488 / 957 | 14 | 7 / 13 |
| POST /sessions git runs | 4 of 4 creates | 1 of 4 | 0 of 4 | 1 of 1 | 0 of 3 |
| POST /prompts wall | 825 / 1,041 | 748 / 861 | 369 / 494 | 26 | 52 / 56 |
| POST /prompts db dur | 746 / 953 | 652 / 761 | 276 / 396 | 5 | 6 / 9 |
| delivery: `deliver` total | 3,670 / 4,548 | 1,919 / 3,300 | 1,262 / 2,090 | 931 | 240 / 1,705 |
| delivery: `proxy` total | 2,654 / 3,314 | 1,203 / 2,618 | 768 / 1,642 | 868 | 232 / 1,686 |
| delivery: created→forwarded (DB) | 4,305 / 5,151 | 2,188 / 3,498 | 1,406 / 2,237 | 1,192 | 242 / 1,706 |
| POST→busy | 4,484 / 5,096 | 2,667 / 3,776 | 1,655 / 2,457 | 1,173 | 576 / 3,488 |
| POST→idle | 6,940 / 8,718 | 5,576 / 6,586 | 3,381 / 5,048 | 3,740 | 2,258 / 5,269 |

Delivery stages at 50 ms RTT, p50:

| Stage | Baseline | R1 | R1 + prepared | What moved it |
| --- | --- | --- | --- | --- |
| `deliver` admission | 217 | 219 | 162 | not changed by R1 |
| `deliver` delivered | 3,124 | 1,331 | 876 | the `proxy` line below |
| `proxy` load-sandbox | 106 | 0 | 0 | R1.6: the delivery hands its row over |
| `proxy` env-sync | 1,732 | 536 | 336 | R1.1 tip proof, R1.8 shared reads |
| `proxy` turn-begin | 216 | 113 | 59 | R1.5: one statement |
| `proxy` upstream (API→sandbox) | 210 | 229 | 221 | not the API |
| `proxy` turn-accept | 323 | 223 | 121 | R1.5: one statement, then the inbox confirm |

Notes:

- The 250 ms burst wait and the landing read-back are not stage rows. They sat
  between `created` and `deliver` and inside `delivered`: the gap between
  created→forwarded and `deliver` total is 635 ms on the baseline and 269 ms
  after R1.
- One prompt, statement trace at 50 ms RTT. The request ran 14 statements in 8
  sequential waves and runs 15 in 6 (project row, IAM in 2, the visibility
  reads with the inbox state, agent grants, insert). The delivery ran 49
  statements in 27 waves with 2 git calls (a fetch and an `ls-remote`). With
  the tip proof warm it runs 32 statements in 15 waves and no git call. A
  prompt sent 70 s after the last one finds the proof expired: 42 statements in
  19 waves and 1 `ls-remote`, created→forwarded 3,800 ms against 5,646 ms.
- `session ready` p50 read 33.6 s on the baseline and 13.1 s after R1. Do not
  attribute it: the merged `main` changed the default image and the Platinum
  control-plane routing on the same day. The first session after a stack
  restart took 155.9 s (image build).
- "R1 + prepared" is `DB_PREPARE_STATEMENTS=true` in `apps/api/.env.local`:
  2,280 of 3,080 traced statements took one round trip (50 ms) instead of two.
  It is off by default. See `packages/db/src/client.ts` before turning it on in
  a deployed environment.
- The bench sends `client_sent_at_ms`, as the web composer does. Without it the
  prompt route keeps the 250 ms burst wait.
