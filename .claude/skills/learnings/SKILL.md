---
name: learnings
description: "The project's hard-won incident learnings — durable rules extracted from real outages and near-misses, each with the incident that taught it. Load WHENEVER you write or review a DB migration or schema change, touch deploy/release workflows (.github/workflows/deploy-*, promote.yml, vercel config), plan a promote/release, respond to a prod incident, or when another skill references a learning. ALSO load after resolving any incident: this file is append-only and every new incident MUST deposit its rule here."
---

# Project learnings

Rules paid for with real downtime. Each entry: the rule first, the incident that
taught it second. This register is **append-only** — when an incident or
near-miss resolves, add its rule here in the same session, newest first. Keep
entries under ~8 lines; deep detail goes in the incident's memory/RCA and is
linked, not inlined.

## How to add a learning

1. Write the RULE as an imperative a developer can obey while coding.
2. Name the trigger surface (what someone is doing when it applies).
3. One-line incident citation (date, version, blast radius).
4. Reference any enforcing automation (lint, CI gate, workflow) — a learning
   with an enforcer is a fact; one without is a TODO to build the enforcer.

## Register

### A reused speculative resource needs a consumption signal every holder can see (2026-08-17)

**When:** caching a server-side find-or-create resource client-side (the warm
session ready-store; any pre-provisioned handle). `POST /sessions/warm` reuses
ONE still-unused session per user+project, so every tab, browser and device of
that user holds the SAME id — and a per-tab in-memory store then trusts its
held copy for its whole dwell. The moment ANY holder uses the resource, every
other copy silently points at a session with a conversation in it; the next
project-home send navigates there and auto-sends into it. Holding is not
owning: consult a synchronous cross-holder registry at take time (localStorage
is the only sync cross-tab channel), record every take AND every navigation
into a session, and revalidate a held copy on visibility regain (scopes
localStorage cannot cross). Corollary that let it ship: every session e2e flow
`requires: ['daytona']`, so NO warm contract runs in local CI — green local
gates proved nothing about this feature.
*Incident:* 2026-08-17, dev, night before a customer release — home prompts
delivered into previous sessions; newest session missing from the list (list
seed wiped by refetches racing the `/start` marker drop; adoption stamped no
activity or `updated_at`).
*Enforcer:* `warm-session-taken-registry.test.ts` +
`use-warm-project-session.test.ts` (cross-tab takes, navigation consumption,
revalidation); SESS-18 pins `/start` adoption, list order and
`exclude_session_id` — but only at staging gates (daytona-gated locally:
still a gap).

### Active-turn renewal cadence must stay below the shortest provider backstop (2026-08-17)

**When:** changing sandbox maintenance cadence, provider lifecycle timers, or active-turn renewal. Run exact-turn renewal in a separate leader-owned loop capped at 30 seconds. Do not couple it to the five-minute project-maintenance sweep. Scope the fast lane to durable `activeTurn` or `activeTurns` authority only.
*Incident:* Dev Daytona renewed once, then stopped an exact active OpenCode turn 68 seconds later because the next project-maintenance pass was scheduled five minutes later than the one-minute deterministic provider timeout.
*Enforcer:* `active-turn-renewal.test.ts` caps the loop at 30 seconds and requires `activeTurnsOnly`; `sandbox-reaper.test.ts` excludes idle rows from the fast lane; the live provider harness uses a one-minute native timer.

### Every sandbox stop must revoke all persisted turn authority (2026-08-17)

**When:** changing provider webhooks, idle reaping, manual stop, or the shared stopped-state writer. Remove `activeTurn`, `activeTurns`, and `lifecycleStopClaim` in the same transaction that sets `status='stopped'`. Do not rely on the reaper to clear tokens first; a provider-native timer or webhook can win that race.
*Incident:* the one-minute Dev Platinum proof stopped after `deadline_at`, but the provider webhook committed `status='stopped'` with a synthetic unknown `activeTurns` token still present.
*Enforcer:* `sandbox-state-sync.test.ts` requires `applyStoppedState()` to remove every turn-authority key atomically for all stop paths. The live provider harness verifies the stopped row has zero active turns.

### Presigned uploads must suppress runtime-inferred content types (2026-08-17)

**When:** sending a body to a provider-generated signed upload URL. Send the exact signed headers. Set an explicit empty `Content-Type` when the signature omits it. Do not let Bun infer a MIME type from `Bun.file()`.
*Incident:* E2B template uploads returned GCS `403 SignatureDoesNotMatch` because Bun added `application/gzip` to a URL signed with an empty content type. Template creation succeeded, but every new immutable image remained unbuildable.
*Enforcer:* `unit-e2b-bun-upload-patch.test.ts` requires the E2B dependency patch to use `Bun.file()` and an explicit empty `Content-Type` in both bundles. A real E2B template build verifies the signed upload.

### Provider lifecycle renewal must use the provider activity primitive (2026-08-17)

**When:** implementing provider-neutral lifecycle renewal. Use the provider's native activity or deadline API. Do not assume a guest command updates the provider lifecycle clock. Reject renewal unless the provider reports the sandbox as running.
*Incident:* Daytona accepted repeated `true` guest commands while its one-minute native autostop clock continued unchanged. The sandbox stopped 21 seconds before Kortix `deadline_at` during deterministic lifecycle testing.
*Enforcer:* `daytona.test.ts` requires `refreshActivity()`, rejects stopped sandboxes, propagates failures, and bounds a hung refresh. The live provider harness forces a one-minute native timer.

### A persisted user message is not proof that its OpenCode turn is active (2026-08-17)

**When:** changing exact-turn lifecycle probes. Treat a user-only or incomplete assistant message as active only when `/session/status` reports that exact session as `busy` or `retry`. Treat an idle session as terminal. Treat an unreadable or unknown status as unknown and non-renewing.
*Incident:* a native OpenCode prompt persisted its user message but created no assistant message; the exact-message probe returned active for 198 seconds and would have renewed an idle Platinum sandbox indefinitely.
*Enforcer:* `orphaned-turn-finalize.test.ts` covers busy, retry, idle, and unreadable session status.

### A sandbox lifecycle grant requires exact active-turn evidence (2026-08-17)

**When:** changing session prompt delivery, sandbox reaping, or any sandbox provider lifecycle adapter. Persist token-bound `delivering` authority before upstream delivery. Promote only after OpenCode exposes the exact user `messageID`. Renew both `deadline_at` and the provider-native timer only from a fresh exact-turn probe. Treat unknown evidence as non-renewing. Linearize idle stop against prompt delivery with one database claim, and never let renewal wake a stopped sandbox.
*Incident:* long OpenCode image analyses outlived E2B's absolute timeout and provider idle timers; Kortix displayed “Your session will be restored” while the agent still worked.
*Enforcer:* `sandbox-turn-lifecycle.test.ts`, `integration-sandbox-turn-lifecycle.test.ts`, `sandbox-reaper.test.ts`, `initial-turn-lifecycle.test.ts`, and all three provider lifecycle suites.

### A platform-injected principal must never have its authority re-derived from user config (2026-08-13)

**When:** touching code that RE-resolves an already-minted credential —
`remintGrantForAgentSwitch` / `reconcileStoredSessionAgentGrant`
(`apps/api/src/projects/lib/session-token-grant.ts`), which run on EVERY prompt
and every connector call. The `meta` coordinator is injected by
`addPlatformMetaAgent` and appears in no `kortix.yaml`, so resolving it through
the manifest returns "unlisted agent": deny-all on a governed project,
UNRESTRICTED on an ungoverned one. Both are destructive — the deny-all was
WRITTEN over the coordinator's real grant on its first turn, and the null made
the re-mint refuse the turn outright. Branch for the platform-owned principal in
the ONE pure resolver every path shares (`grantFromLoadedAgents`); a special case
at the mint alone is exactly what the re-mint then erases.
Two traps cost hours here. A comment asserting a fast path is not evidence the
fast path exists — `preview.ts:1144` says an ordinary turn "skips the manifest
read entirely" while the callee has no early return at all; read the callee. And
`authorizeV2` returns `super_admin` BEFORE the agent-grant fold, while a personal
account's primary owner has `is_super_admin = true` — so this entire bug class is
invisible on a laptop until you clear that flag.
*Incident:* the meta coordinator could not list or spawn sessions for the account
owner running it; `kortix sessions ls` / `new` 403'd from turn one onward, and
the 403 blamed their role (that misdiagnosis fixed separately in #6443).
*Enforcer:* `apps/api/src/__tests__/unit-meta-agent-grant-resolution.test.ts`
pins resolution for governed / ungoverned / unreadable manifests, the `skip`
re-mint decision, and the old destructive `write` as a regression guard. Nothing
enforces the comment-vs-callee or super-admin traps — those are prose only.

### Anything created per-deploy needs a reaper, and the reaper needs a namespace (2026-08-12)

**When:** adding or reviewing code that creates a named provider-side artifact
— a snapshot, image, template, volume. Ask two questions: *what deletes the
previous one*, and *whose is it*. `ensureMetaSandboxImage` answered neither: it
deleted a snapshot only when its OWN build failed, never when a newer one
superseded it, and its name carried no environment. The meta fingerprint hashes
the agent/CLI/SDK/shared/starter source trees, so it moves on nearly every
commit — one permanent snapshot per deploy, forever.
Namespace the name by `INTERNAL_KORTIX_ENV`: dev, staging and prod share ONE
Daytona organisation (same API key in all four env profiles), so an
un-namespaced reap on dev deletes the image prod boots from. And make the
"is it still in use" lookup fail **closed** — `recentlyBuiltSnapshotNames`
returns an empty set on a DB error, which a reaper reads as "nothing is
protected, delete everything".
Before writing any reaper, find who still reads the thing: the sibling
`kortix-app-*` snapshots look equally abandoned but are the targets of
`POST /apps/{appId}/rollback`, so reaping them on supersession would have
broken rollback. Unbounded-but-needed means bounded retention, not deletion.
*Incident:* the Daytona organisation hit its 200-snapshot quota (226, of which
118 meta at ~8/day). `POST /snapshots` then 400s, which fails every CI run and
every NEW-project build. Existing projects survived only because
`canServeLastKnownGoodRuntime` lets a session-start boot the previous image —
so the visible symptom was "CI is broken", while the quieter one was that
runtime updates silently stopped reaching sandboxes.

### A deployed API is not a deployed daemon (2026-08-12)

**When:** shipping any change to `apps/kortix-sandbox-agent-server`, or turning
on something that depends on one. `/health` reporting your commit proves the API
rolled; it says nothing about the sandbox. The daemon is gzipped into the
snapshot build context (`apps/api/src/snapshots/build-context.ts:185`) and
reaches a session only after that snapshot is rebuilt or agent-swapped
(`snapshots/templates.ts:613`) AND the warm pool has cycled off the old one.
Prove it in the guest, not from the API:
`grep -aoE "<expected literal>" /usr/local/bin/kortix-agent` in a session
created after the deploy — the Bun-compiled binary embeds its source strings.
Sequence any dependent flag flip AFTER that probe passes.
*Incident:* near-miss, same day as the MCP-argv fix below. Deploy Dev went green
and `dev-api` reported `66b6148d`, but two sandboxes created ~15 min later both
still had the pre-fix `"connector"` spelling. Merging the flag that enables the
MCP face on that evidence would have given every session a server whose command
exits 2 — a broken MCP entry where there had been none.

### A cross-process command string needs a test that RUNS it (2026-08-12)

**When:** one component spawns another by a hardcoded argv — the daemon's
OpenCode MCP entry (`apps/kortix-sandbox-agent-server/src/opencode.ts`), an
entrypoint script, a CronJob command. Asserting the literal proves only that
the string is what you just typed. Spawn it and require a real response.
Pinning both sides to the same literal is worse than no test: it makes the
typo look deliberate and survives review. Where the two packages cannot share
a constant (the daemon is standalone by design — hono + zod, no workspace
deps), read the argv from the producer and execute it in the consumer's test
(`apps/cli/src/__tests__/connectors-mcp-handshake.test.ts`).
*Incident:* e868be1d6c renamed the CLI command `executor` → `connectors` but
pointed the daemon at `connector`, singular. Every sandbox got `unknown
command` + exit 2, so the `kortix-connectors` MCP server never started for six
days. Both daemon unit tests were updated to assert the typo and stayed green;
the e2e tests that really spawn the server used the plural and also stayed
green, testing a path production never took. Blast radius was zero only because
`KORTIX_CONNECTORS_MCP_ENABLED` is off everywhere — the flag, not the tests, is
what contained it.

### A per-turn hot path must not contain an unbounded third-party round-trip (2026-08-11)

**When:** adding an `await` to the prompt path — `syncSandboxEnvForPrompt`
(`apps/api/src/projects/lib/sandbox-env-sync.ts`) and everything it calls. The
network-boundary sync ran a FULL provider re-arm before every turn: manifest
resolve, GET/PUT sandbox secrets, `ensureSecret` per binding, then
`waitUntilArmed` at 40 × 250 ms — up to ~10 s, past the proxy budget. One egress
secret therefore broke every agent turn in the project. Arm once at session
start or in the background, bound the wait, and fail soft ONLY where a skipped
call cannot widen access (a boundary value never enters the guest, so the worst
case is a 401 upstream, not a leak). It also ran before `postEnvToDaemon`, so its
failure skipped the ordinary runtime-secret push too.
*Incident:* 2026-08-11 — same session, same sandbox: egress secret active →
`prompt_async` 502 in 5.2 s, disabled → 200 in 1.2 s. Found only when the product
owner said "I cannot test this on dev"; the symptom was a spinner stuck on
"Considering next steps…", naming neither secrets nor the provider.
*Enforcer:* none — build it.

### A deploy workflow must not cancel a build it cannot outrun (2026-08-10)

**When:** setting `concurrency.cancel-in-progress` on any
`.github/workflows/deploy-*`. A workflow-wide group with `true` starves the
SLOWEST surface, because every surface shares the group: a frontend-only push
kills an in-flight multi-arch API build (~23 min) whenever `main` lands faster
than that build takes (~10–20 min by day). Queue instead — GitHub holds one
pending run and cancels the previous pending one, so a burst still collapses to a
single deploy and the newest commit still wins. `true` also lets an unrelated
push kill `migrate-db` mid-migration.
*Incident:* 2026-08-10 — 19 of 30 Deploy Dev runs cancelled, `dev-api` pinned to
`d1ed3589` for 3.5 h with 5 API commits stranded; it landed only once the trunk
went quiet that evening.
*Enforcer:* none — and `deploy-staging` is still `true`, where a cancelled
`migrate-db` would hit `STAGING_DATABASE_URL`. Build the guard.

### One CREATE INDEX CONCURRENTLY per table at a time (2026-08-10)

**When:** building indexes on a live table (runbooks, .concurrent.ts migrations).
Two concurrent CIC builds on the same table starve each other's
lock-acquisition points — every acquisition 55P03s until one finishes. Build
strictly serially. If a builder's client process dies, its CIC keeps running
SERVER-side, holds ShareUpdateExclusive, and its final commit is unreliable —
find it in `pg_stat_progress_create_index`, `pg_terminate_backend` it, and
`DROP INDEX CONCURRENTLY` the INVALID shell before rebuilding (`IF NOT EXISTS`
silently keeps invalid shells).
*Incident:* v0.12.7 audit-v2 index pass — parallel lanes 55P03-thrashed, a
killed lane left an orphaned build that starved the retry run.

### The Vercel prod build must be handed the release version (2026-08-10)

**When:** touching deploy-prod's Vercel deploy or apps/web/next.config version
resolution. The Vercel build (rootDirectory apps/web) cannot reliably read the
repo-root VERSION file, so runtime-config reports "dev" and
frontend-auth-proof's `VERSION === X.Y.Z` check fails. Pass
`--build-env NEXT_PUBLIC_KORTIX_VERSION=<version>` on every prod deploy (the
`deploy-web-vercel` job does); the project env `NEXT_PUBLIC_KORTIX_VERSION` is
a static fallback that goes stale — the build-env override wins.
*Incident:* v0.12.7 frontend served VERSION "dev"; gate exhausted 30 attempts;
fixed by `vercel redeploy` after setting the env.

### An audit reconstruction trigger is only safe with its dedup index (2026-08-10)

**When:** installing triggers that INSERT INTO audit_events with
source_ledger/source_record_id set. The prepare-trigger's duplicate check needs
`idx_audit_events_source_phase`; without it every triggered insert seq-scans
the whole table and times out the OUTER statement — cron trigger dispatch
failed prod-wide for ~80 min. Order in any reconcile: dedup index BEFORE (or
immediately after) trigger install, never "later with the other indexes."
*Incident:* v0.12.7 reconcile installed triggers at 17:56, index landed 19:29.

### Never backfill data inside a single-transaction migration (2026-08-10)

**When:** writing any `.sql` migration under `packages/db/migrations/`.
A plain `.sql` migration runs in ONE transaction, so its `ALTER TABLE`s hold
ACCESS EXCLUSIVE until COMMIT — top-level `UPDATE`/`INSERT INTO`/`DELETE
FROM`/data-modifying `WITH` in the same file turns milliseconds of lock into the
full backfill duration, blocking every writer on the table. Write data moves as
batched, incrementally-committed `.concurrent.ts` passes or a supervised
out-of-band runbook (short-tx DDL → triggers → chunked updates → CONCURRENTLY
indexes → ledger rows).
*Incident:* v0.12.7 promote — `centralized_audit_v2` rewrote 30.5M rows of
`audit_events` under lock; prod down ~30 min.
*Enforcer:* `lint-migrations.ts` backfill-DML guard (`-- backfill-safe:`
sign-off escape hatch; `backfill-grandfathered-migrations.json` snapshot).

### Cost every pending prod migration before promoting (2026-08-10)

**When:** preparing a release/promote.
Ordering-correct is not enough. Diff `kortix_migrations.pgmigrations` on prod
against the promoted tree, and for each pending migration ask what it does at
prod data volume. A tag tree containing a migration file is NOT proof the
migration ran — only the ledger is.
*Incident:* same v0.12.7 outage — the dangerous migration had been "shipped" in
v0.12.6's tag but never applied; nobody costed it before the promote.
*Enforcer:* kortix-release skill Step 3.6 (checklist); this rule is the reason.

### The prod frontend must never deploy before the API serves the release (2026-08-10)

**When:** touching `vercel.json`, `vercel-ignore.sh`, or `deploy-prod.yml`.
A push to `prod` must not auto-deploy kortix.com; the frontend deploys only from
deploy-prod's `deploy-web-vercel` job after `verify-live-version` proves the API
is on the release. A new frontend against an old API calls routes that do not
exist — every project load fails "before we could check your access".
*Incident:* v0.12.7 — Vercel auto-promoted the new frontend while the API stayed
back after its migration failed; second occurrence of the class (v0.10).
*Enforcer:* `deploymentEnabled.prod:false` + `deploy-web-vercel` job, pinned by
`tests/unit/web-ecs-workflow.test.ts`.

### node-pg-migrate checkOrder is index-wise on ledger run order (2026-08-10)

**When:** doing any out-of-band migration apply or ledger surgery.
`checkOrder` compares the ledger's run order (`ORDER BY run_on, id`) position by
position against filename order — appending an older-named migration to the end
of the ledger fails the NEXT migrate even though "everything is applied". Place
reconciled rows' `run_on` so ledger order matches file order.
*Incident:* staging deploy failed post-reconcile until the 7 audit-v2 rows were
re-timestamped before the two later migrations.

### Cancel the CI run before killing its DB backend (2026-08-10)

**When:** a deploy's migration step is wedging prod and you terminate it.
The migrate step (and `withMigrationDeadlockRetry`) retries: killing only the
Postgres backend re-locks the table minutes later. Order: cancel the workflow
run, then `pg_terminate_backend`, then verify no reconnect.
*Incident:* v0.12.7 — first kill was undone by a retry; prod degraded a second
time before the run was cancelled.

### Bot-pushed release PRs and repo Actions approval policy (2026-08-10)

**When:** a required check sits in `action_required`, or changing repo Actions
settings. `fork-pr-contributor-approval: all_external_contributors` holds EVERY
PR workflow whose actor lacks write access — including `github-actions[bot]` on
promote-created release PRs — stalling releases behind a manual approve click.
Keep it at `first_time_contributors` (org default) unless there is a concrete
reason, and never quietly stricter than the org.
*Incident:* v0.12.7 release gate stalled in `action_required`.

### Verify CI assertions against the real artifact format on the CI OS (2026-08-10)

**When:** writing shell assertions in workflows (grep/awk over curl output,
cookie jars, headers). curl's Netscape cookie-jar puts the domain in the FIRST
field with an `#HttpOnly_` prefix — a tab-anchored grep can never match; and GNU
grep -E treats `\t` in single quotes as a literal `t` while macOS grep interprets
it, so a locally-green pattern can be dead on ubuntu runners. Use ANSI-C
quoting (`$'\t'`) and test the exact pattern in an ubuntu container.
*Incident:* staging web verify failed twice on the same one-line assertion.

### A TLS/proxy component is only as correct as the third-party clients that accept it (2026-08-14)

**When:** shipping anything that terminates TLS, mints certificates, or sits in
front of other people's HTTP clients (the in-guest egress shim, any MITM proxy).
Unit tests and a `curl` probe are NOT evidence. Three separate bugs in this one
component passed every in-process test and every curl check, and each was found
only by running a real heterogeneous client in a real guest:

- `git` sends CONNECT, gets a 407, and retries **on the same socket**. Without
  `Content-Length: 0` + `Connection: close` on the challenge the retry vanishes
  and every clone fails, while curl is unaffected because it reconnects.
- Python's OpenSSL refuses a chain whose leaf carries no **Authority Key
  Identifier** (`CERTIFICATE_VERIFY_FAILED ... Missing Authority Key
  Identifier`); curl accepts the identical certificate. An AKI also needs a
  **Subject Key Identifier** on the issuer to point at, and node-forge's PARSED
  `subjectKeyIdentifier` is a hex string — feeding it back yields an AKI naming
  an issuer that does not exist and breaks every handshake. Use
  `caCert.generateSubjectKeyIdentifier().getBytes()`.
- `curl` offers `Accept-Encoding: gzip` by default. Any redaction that scans
  response BYTES is silently defeated by a compressed body, so a credential
  echoed back returns intact. Force `identity` on the relayed request.

Run the real clients — `curl`, `python3 -m requests`, `git`, `node fetch` — in a
real sandbox before claiming a proxy works, and assert on what the UPSTREAM
received, not on the absence of an error.
*Incident:* the Daytona network-boundary shim shipped to dev broken for every
Python client; caught by a live probe, not by 27 green tests.

### Bun diverges from Node in three load-bearing ways around raw sockets and TLS (2026-08-14)

**When:** writing socket/TLS code that runs under Bun (the API and the sandbox
daemon both do). Measured, bun 1.3.14 vs node v22.22.0:

- `http.Server.emit('connection', socket)` is a **no-op** — the request event
  never fires and the connection hangs with nothing in any log. Use a real
  loopback listener and pipe into it.
- `SNICallback` **never fires** — the handshake completes against a default
  certificate. Bind one static-cert listener per terminated host instead.
- The `'upgrade'` event fires, but a write from that handler **never reaches the
  client**; Node delivers the same bytes. Destroy the socket rather than trying
  to answer.

All three fail SILENTLY (a hang, or the wrong certificate), never an exception.
*Incident:* each cost a debugging cycle in the egress proxy/shim.

### A path allowlist that gates non-idempotency must list EVERY turn-creating endpoint (2026-08-11)

**When:** touching the sandbox proxy's retry loop, or adding an OpenCode endpoint
that starts an agent turn.
`routes/preview.ts` derived "is this safe to retry?" from
`shouldSyncProjectEnvBeforeProxy`, a predicate named after env sync whose regex
listed only `/session/:id/{message,prompt_async}`. `POST /session/:id/command` —
what every `/` slash-command posts to — matched neither that nor
`isLongTurnCompletionRequest`. One omission silently disabled FOUR independent
safeguards at once: no dedupe claim, retry-on-5xx allowed, retry-on-ambiguous-
timeout allowed, and a 15s connect cap applied to an endpoint that blocks for the
whole turn. `MAX_RETRIES = 3` then re-POSTed the non-idempotent body, so one user
submit ran the agent four times and billed four turns.
**Rules:** (1) a predicate that answers "may I send this twice?" gets its OWN
name and its own list — never reuse one written for a different question, because
adding an endpoint to one concern silently opts it into or out of the other;
(2) any new turn-creating path must be added to `isNonIdempotentSessionWrite`
(`sandbox-proxy/prompt-dedupe.ts`) AND `isLongTurnCompletionRequest`
(`sandbox-proxy/preview-retry-budget.ts`) in the same commit.
**Enforcement:** both predicates are unit-tested per endpoint in
`prompt-dedupe.test.ts` / `preview-retry-budget.test.ts`. Black-box proof: two
identical `/command` POSTs must yield exactly one new user message.
*Incident:* session `9f6b0d87`, one `/webapp` submit recorded as 4 identical user
messages 11.0s / 11.8s / 13.7s apart (attempt timeout + `RETRY_DELAYS_MS`
[250, 1000, 3000]).

### Two proxy layers must agree on which upstream calls legitimately block (2026-08-11)

**When:** changing a timeout in `kortix-sandbox-agent-server/src/proxy.ts` or
`apps/api/src/sandbox-proxy/`, or adding an OpenCode endpoint that withholds
headers until its work completes.
The daemon bounded EVERY proxied header wait at `UPSTREAM_RESPONSE_TIMEOUT_MS =
10_000`, reasoning only about SSE (headers arrive fast) and a wedged opencode.
`POST /session/:id/command` emits nothing until the whole turn finishes, so
every command over 10s was aborted and answered `502 {"error":"upstream
unreachable"}` — the banner users saw in chat, on a healthy turn. Its own
comment said the 502 exists so "apps/api's retry+auto-wake loop can act on it
immediately" — and that loop assumed idempotency. **A fail-fast designed to
trigger a retry met a retry loop that assumed it was safe to repeat.** One
`/webapp` submit ran the agent four times, each retry aborting the turn the
previous one started, which is where the "Interrupted" labels came from.
**Rules:** (1) a header-wait timeout is only valid for endpoints that ANSWER
fast — blocking-turn endpoints need their own generous bound
(`isBlockingTurnRequest` / `LONG_TURN_RESPONSE_TIMEOUT_MS`); (2) when one layer
fails fast *expecting* another to retry, the retry decision must be written down
in both layers, never inferred; (3) a client must not render a
delivered-then-disconnected prompt as a failed send — the retry it invites is
what aborts the live turn (`delivered-but-disconnected.ts`).
**Enforcement:** `blocking-turn-timeout.test.ts` drives BOTH layers' predicates
with the same inputs and requires identical verdicts (verified falsifiable — it
goes red when either side drifts).
**Deployment trap:** the daemon ships inside the sandbox image, so this fix
reaches only sandboxes created from a NEW snapshot. Existing sessions keep the
10s bound; the web-side classifier is what covers them.
*Incident:* session `9f6b0d87`.

### A control split across API and daemon is only live when BOTH halves are (2026-08-14)

**When:** shipping any security control whose two halves live in `apps/api` and
`apps/kortix-sandbox-agent-server`. The API half goes live the moment Deploy Dev
finishes. The daemon half does NOT: it is baked into the sandbox image, reaches
a guest only through a new meta-snapshot build, and the fingerprint that
triggers that build hashes `apps/kortix-sandbox-agent-server/src`. Until an
image carrying the new daemon exists, the API half is running against old
guests and the control does nothing.

The sandbox egress pin hit this exactly: the API mount was verifiably live
(boot-timeline went 403 → 401 on the same request), but a real exfiltrated-token
attack still SUCCEEDED because the box's baked daemon still sent the wrong
token, so nothing wrote a pin. The identical test passed later, unchanged, once
a sandbox with the new daemon existed.

Two rules:

- **Never conclude "the control does not work" from one post-deploy run.** Prove
  which half is live first. An API-side before/after on the same request is
  cheap and decisive (`403 handler-guard` → `401 middleware`).
- **A control that fails OPEN is the right default while it propagates** — the
  pin allows `unpinned`, so old guests kept working and nothing regressed
  during the lag. A fail-closed control shipped this way is an outage.

Do not read a fast `session_start_timeline.totalMs` as proof of a warm-pool box
either: `KORTIX_WARM_SNAPSHOT_ENABLED` defaults false, and ~2s is also what
creating a container from an ALREADY-BUILT image costs.
*Incident:* the token-binding verification failed twice before the image landed.

### A resource-scaled timeout moves the cliff, it never removes it (2026-08-16)

**When:** sizing any timeout whose budget you are tempted to scale by how big
the work is — prompt bytes, file size, row count, payload length.

The LLM gateway gave a new upstream stream a first-byte budget of
`30_000 + ceil((requestBytes - 64KiB) / 1MiB) * 15_000`, capped at `120_000`.
Four size steps land on `90_000` exactly, so every request body between
3,211,776 and 4,259,840 bytes got a 90-second budget and then died with
`upstream stream probe timeout exceeded (90000ms with no bytes)` on a
completely healthy upstream. Users saw a Claude Fable 5 turn fail identically
on every retry once an analysis step pushed the context past ~3 MiB.

The scaling was the bug, not an insufficient constant. Growing the context
raises the budget linearly but raises the model's prefill + thinking time by
more, so the cliff is reachable at every size — it just relocates. **Scale the
budget and you have chosen which inputs fail, not whether they fail.**

Three rules:

- **A slow dependency is not a broken one.** Reserve timeouts for detecting
  *death*. Where "slow" and "dead" are locally indistinguishable — which is
  always, for a model that is prefilling — the deadline must pick a
  *degradation*, not a failure. Here it became a COMMIT point: the stream is
  handed to the relay, which sends headers and heartbeats while the model
  works. Failing over is what silently downgraded users to a fallback model.
- **A timeout you cannot observe from the outside will fire on healthy work.**
  The transport emitted nothing for the AI SDK's `start` / `start-step` parts,
  so a live prefill was byte-identical to a dead socket. One keep-alive byte at
  stream open is what separates them.
- **Check the edge before raising any budget.** Nothing is written downstream
  while a pre-header probe runs, and the live `kortix.com` zone reports
  `proxy_read_timeout = 125` with `editable: false` (Free plan). Raising the
  probe past ~125s cannot work — Cloudflare 524s first. Measured, not assumed:
  `GET /zones/$ZONE/settings/proxy_read_timeout`.

**Enforcement:** `streaming.test.ts` sweeps request sizes 0–16 MiB and asserts
the resolver returns one constant, so no size can reproduce 90,000 again.
**Dead-telemetry corollary:** when a failure stops being reachable, delete the
metric that counted it. `kortix.probe_timeout` was left pinned to false on
every span — a dashboard built on it looks healthy by construction.
*Incident:* PR #6473, merged `7e8a56badaef80374a189e0e427a08eb06b44697`.
