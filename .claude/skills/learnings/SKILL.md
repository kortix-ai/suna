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

### Rewiring writers and converting their table to a view must be TWO releases (2026-08-19)

**When:** an expand/contract store swap (table -> compatibility view). The
migration applies BEFORE the new image rolls, so old pods run against the view
for the whole build+rollout window — and any of their `INSERT ... ON CONFLICT
(cols)` writers 42P10 for that entire window (INSTEAD OF triggers cannot help;
conflict inference precedes them). Locally it is worse: the shared Supabase DB
is cutover'd the moment the migration runs, and EVERY other worktree still on
pre-cutover code breaks until it merges main.
The rule: **release N rewires every ON CONFLICT writer off the table; release
N+1 converts it to a view.** If they must ship together, size the window
explicitly (dev: minutes; prod: pod drain + build — unacceptable for hot
writers) and schedule the promote accordingly. After cutting over a shared
local DB, tell every other active session to merge main IMMEDIATELY.
*Incident:* RBAC cutover #6594 — dev's grant/invite/SSO-JIT/SCIM upserts
42P10'd from migration-apply until the API rollout landed; every local
worktree session on pre-cutover code broke against the shared DB at once.
*Enforcer:* none — prose only. The promote runbook must carry this check.

### A VALIDATE ships only with a reconciliation the TARGET data has passed (2026-08-19)

**When:** writing `VALIDATE CONSTRAINT` for an FK/CHECK added `NOT VALID`.
Zero violating rows on the local DB is not evidence — local data is young.
Long-lived envs hold rows written before the catalog/constraint existed (dev:
`iam_role_actions` rows with retired `project.cr.*`/`trigger.*` actions).
Either probe every target env for violators first, or — better — precede the
VALIDATE with idempotent reconciliation DML in the same migration so it cannot
fail on data the constraint predates. A merged migration that VALIDATE-fails
blocks EVERY deploy of that env; the only sanctioned fix is a checksum-guarded
runtime override (`packages/db/scripts/migration-runtime-overrides.ts`).
*Incident:* RBAC cutover #6594 — `role_permissions_action_permissions_fk`
VALIDATE 23503'd on dev; Deploy Dev blocked ~1h; fixed by the third runtime
override (map `cr.*`→`gitops.*` dedup-aware, purge uncataloged, then VALIDATE).
*Enforcer:* `migration-runtime-overrides.test.ts` pins the override; nothing
yet lints "VALIDATE without reconciliation" — prose only.

### `drizzle-kit generate` reports a TTY prompt as "no schema changes" (2026-08-19)

**When:** running `bun packages/db/scripts/generate.ts <slug>` from any
non-interactive shell (an agent, CI, a piped command).
When a diff contains BOTH a created and a deleted table, drizzle-kit opens an
interactive "created or renamed?" picker. Without a TTY it throws
`Interactive prompts require a TTY terminal`, and the wrapper still prints
`No schema changes detected — kortix.ts matches the snapshot. Nothing generated.`
— the snapshot is NOT written, and `schema-sync` then rubber-stamps a stale one.
The rule: **read the line drizzle-kit itself prints (`No schema changes, nothing
to migrate 😴`), not the wrapper's summary**, and verify
`drizzle/meta/_journal.json`'s tail plus the snapshot `prevId` chain by hand. To
avoid the prompt entirely, split the change into two generate runs — deletions
first, then creations — so neither diff has both sides.
*Near-miss:* the canonical-RBAC cutover; `account_memberships` (created) landed
in the same diff as three dropped tables, and the first run silently produced no
snapshot. Same failure class as the 2026-07-16 forked-snapshot incident
(MIGRATIONS.md "Why drizzle-kit generate needed fixing").

### `ON CONFLICT (cols)` cannot run against a view (2026-08-19)

**When:** replacing a table with a compatibility view (expand/contract), or
adding an INSTEAD OF trigger.
A view has no indexes, so `INSERT ... ON CONFLICT (a, b) DO UPDATE` fails at
runtime with `42P10 there is no unique or exclusion constraint matching the ON
CONFLICT specification` — INSTEAD OF triggers do not help, because inference
happens before they run. `ON CONFLICT DO NOTHING` with NO target does work. A
view with a JOIN is not auto-updatable at all, and a rendered/expression column
is never assignable even on an otherwise auto-updatable view.
The rule: **before turning a table into a view, grep every writer for
`onConflictDoUpdate` / `ON CONFLICT (` on that relation and rewire it first.**
*Near-miss:* the canonical-RBAC cutover — five production write sites on
`project_members` / `project_group_grants` / `iam_resource_grants` / the
`account_members` accept paths would have 500'd on the first grant after deploy.
*Enforcer:* `apps/api/src/__tests__/unit-iam-gate-codemod-pin.test.ts`
("no production module writes a legacy grant table directly").

### A store swap needs the FKs the old store had, or it silently loses a cascade (2026-08-19)

**When:** moving rows from several tables into one canonical table.
`project_members`, `project_group_grants` and `iam_resource_grants` each had
`ON DELETE CASCADE` from `kortix.projects`; the canonical `role_assignments` had
no FK on `scope_id`, so the swap would have made "delete a project" stop
retracting its grants. The legacy `iam_policies` never had that FK either, and
410 of its 413 local rows pointed at deleted projects — orphans nothing could
observe and nothing cleaned up.
The rule: **enumerate every FK and every ON DELETE rule on the tables you are
replacing, and reproduce them on the survivor.** Add the FK `NOT VALID`, purge
the pre-existing violations in a batched `.concurrent.ts`, then `VALIDATE` in a
follow-up file.
*Near-miss:* the canonical-RBAC cutover, caught by diffing `pg_constraint` for
the retired tables before writing the migration.


### A picker that offers a model the runtime does not know is a silent outage; the runtime must learn the set from the API it talks to (2026-08-19)

**When:** adding or changing a managed model (`LLM_GATEWAY_MANAGED_MODELS`,
`@kortix/llm-catalog` MANAGED_MODELS), or touching how the sandbox daemon
builds OpenCode's `kortix` provider (`apps/kortix-sandbox-agent-server/src/opencode.ts`).
The web picker reads the API (`/model-picker`, `/v1/llm/models`); OpenCode in the
guest accepts only the ids in the provider map it BOOTED with, built from the
image-baked `/opt/kortix/llm-catalog.json`. That file is frozen at template-build
time and nothing rebuilds a template for a catalog change, so every managed
model added after the bake is offered by the picker and rejected by the guest
(`ModelNotFound: kortix/<id>`, 2 ms after the user message, before any gateway
call). Rules: (1) the guest must fetch the managed set from the API on EVERY boot
(`GET /models?scope=managed`, ~3 KB) and overlay it — never trust a baked list
for anything deployment-config decides; (2) a boot-path fetch gets its own small
budget and a bundled fallback, and is started in parallel with the clone, never
awaited on the critical path beyond a cap; (3) a catalog "refresh" that can
silently fall back (here 2.5 s/4 s for a 3.3 MB body) is not a refresh — size the
payload to the budget; (4) a `session.error` with no assistant message must be
rendered under the turn that failed, or the user sees nothing at all.
*Incident:* prod 2026-08-19, `grok-4.6` and `deepseek-v4-pro-0813` (added
2026-08-12/13) returned no reply in every session on templates built before
then; 0 gateway log rows ever. PR #6576.
*Enforcer:* `managed-fallback-sync.test.ts` (bundled table vs `MANAGED_MODELS`
drift), `managed-model-overlay.test.ts` (stale file + live overlay; failed
fetch → bundled floor; await cap), `managed-scope.test.ts`; web: sync-store
per-turn `session.error` tests. Not enforced: a live "picker ⊆ guest provider
map" assertion after deploy — run the dev sweep by hand until it exists.

### `KORTIX_SELF_HOST_CONFIG_DIR` isolates the config, NOT the containers (2026-08-19)

**When:** exercising `kortix self-host` locally on a machine that already runs a
self-host instance. Pointing `KORTIX_SELF_HOST_CONFIG_DIR` at a temp directory
looks like a sandbox — `init` writes a fresh `.env` + compose there and touches
nothing else. But `composeProject(instance)` derives the Docker Compose project
name from the INSTANCE NAME alone (`kortix-<instance>`), so any command that
reaches `docker compose` — `env set`, `start`, `update`, `configure` — applies
the temp config to the containers of the REAL instance of the same name.
`env set EMAIL_URL=…` against a temp dir recreated the live instance's
`kortix-api` (×2, from the temp `KORTIX_APP_REPLICAS`) and `supabase-auth` with
the temp instance's secrets.

The rule: when testing self-host CLI commands against a throwaway config dir,
**also pass `--instance <unique-name>`** — that is the only input that moves the
Compose project. Verify with `docker ps --filter name=kortix-<instance>` BEFORE
running anything that restarts services, and prefer `--no-start` plus reading
the rendered `.env`/`docker-compose.yml` when you only need to inspect
derivation.

Recovery: re-apply the real instance's own files —
`docker compose --project-name kortix-<instance> --env-file <real>/.env -f
<real>/docker-compose.yml up -d --no-build` — then prove identity by diffing a
secret from the real `.env` against `docker exec … printenv`, not by health
alone (a container started from foreign config is perfectly healthy).
*Incident:* 2026-08-19 near-miss during the EMAIL_URL work — the local
`kortix-default` instance (16 containers, up 16 h) had 3 containers recreated
with a temp instance's secrets; restored in ~4 min, all 16 healthy after.
*Enforcer:* none — the CLI should either namespace the Compose project by the
config dir or refuse when the resolved project already exists under a different
instance directory. Until then this rule is the only guard.

### A request/response log must never cap what it captures (2026-08-18)

**When:** persisting or rendering a captured request/response body (gateway
traces, debug logs, any "what was actually sent/received" viewer). Do not add
a byte/char cap that silently swaps in `{truncated, bytes, preview}` or a
"...(truncated)" marker — a capped log lies about what happened and there is
no way for the reader to know how much is missing. If two layers each cap
independently (backend storage, then frontend syntax highlighting), the
combination is even harder to notice.
*Incident:* the gateway's `capture()` (256 KiB) and `relayStream`'s response
preview (256 KiB) both truncated request/response bodies before storage, and
the web Logs viewer then ran the residue through Shiki's highlighter, which
separately clamps at 50,000 chars. A 1.66 MB request showed as a
`{bytes, preview}` stub cut a second time. Fixed in #6523: full capture,
uncapped; `HighlightedCode` takes an `unbounded` flag for viewers whose whole
purpose is showing complete content, keeping the clamp elsewhere as a perf
guard for live-streamed re-highlighting.
*Enforcer:* `packages/llm-gateway` handler/streaming tests assert full-length
capture; `shiki-highlighter.test.ts` pins `unbounded` bypassing the clamp.

### A shared connector catalog needs one canonical credential scope (2026-08-18)

**When:** rematerializing a credential-dependent connector catalog. Only the
project-default credential may write project-wide `connectorActions`. Never use
a member-owned or non-default connection credential. Store catalogs per
connection before supporting credential-specific action sets.
*Incident:* Strix found that PR #6507 let a member MCP credential overwrite the
shared project catalog and expose tenant-specific tool metadata before merge.
*Enforcer:* `sync-mcp.test.ts` rejects member and non-default rematerialization.

### Catalog discovery must use execution credentials and fail on upstream errors (2026-08-18)

**When:** materializing a remote connector catalog, especially MCP
`tools/list`. Resolve the same effective connection credential and static
headers used by tool execution, including OAuth refresh. Reject non-2xx,
protocol-error, and malformed responses; persist a safe error instead of an
apparently healthy empty catalog. Re-run discovery after credentials change,
and never include raw or encoded credential material in diagnostics.
*Incident:* Essentia Dev Sage Intacct authenticated successfully and exposed
four MCP tools, while Kortix sent no credential, parsed an empty HTTP 401 body,
and materialized zero actions without an error.
*Enforcer:* `sync-mcp.test.ts`, `unit-connector-call.test.ts`, and
`oauth2.test.ts` cover authenticated discovery, refresh/rematerialization,
HTTP/JSON-RPC failures, and credential redaction.

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

### A user-visible string is a shared resource; file ownership cuts through it (2026-08-18)

**When:** any change that renames a label, error message, remedy or flag name —
especially work split across parallel agents by file ownership.

Renaming the network-boundary flag from "Network boundary without Platinum" to
"Network boundary in-guest shim" touched EIGHT files: the feature-flag registry
(which is what the Feature-flags screen actually renders), two route error
bodies, a provisioning-error remedy, its test, two docs pages and the web
constant. An agent that owned only the web file renamed it there and nowhere
else. Nothing failed — no typecheck, no test, no lint — and the result would
have shipped a UI telling users to turn on a flag by a name the screen never
displays. The one guard that existed was a source-text assertion in a file the
agent did not own, which is what eventually caught a sibling change.

The rule: before renaming any user-visible string, grep the OLD string across
the whole repo (`--include='*.ts' --include='*.tsx' --include='*.md'
--include='*.mdx' --include='*.json'`) and change every hit in ONE commit. Then
grep it again and expect zero. A partial rename is worse than no rename: the old
name at least matched the UI.

Corollary for parallel agents: **file ownership is the wrong boundary for a
shared string.** Assign the whole rename to one agent, or do it yourself after
the fan-out lands. Two other same-shaped catches in the same batch — a test
pinning the exact `networkBoundaryEchoNotice(...)` call site, and one pinning
the exact `sudo -u kortix --` invocation — both lived in files the changing
agent did not own, and both only surfaced in CI. Reproducing CI's own command
locally (`pnpm --filter ./packages/** --filter ./apps/** … test`) found them in
one pass instead of one CI round-trip each.
*Incident:* PR #6511, caught in review before merge; two CI round-trips spent.

### `tests-release`'s own load can knock staging over, then the edge worker hides it as "maintenance" (2026-08-18)

**When:** running `pnpm test -- --target-full` (the `full suite + quality
gates` release gate) shortly after a fresh `main` → `staging` promotion.

Two consecutive attempts of the v0.13.0 release gate failed the same way, not
with flaky test assertions but with real `MAINTENANCE_MODE` 503s: 36
occurrences across a 40-minute window (15:11–15:51) in attempt 1, cascading
into unrelated failures across accounts, billing, admin-console and
sandbox-template journeys. `target-browser-full` finished in 2394.0s and
failed; `target-api-full` (439 flows, 1681 cases) never finished at all before
the 90-minute cap killed the job. `staging-api`'s own `/health` showed
`started_at` 21 minutes after the instability began — i.e. the backend task
itself went unhealthy and ECS replaced it mid-run.

The `MAINTENANCE_MODE` response is not a real maintenance flag — it is
`infra/cloudflare/workers/api-router/worker.mjs`'s `AUTOMATIC_MAINTENANCE`
fallback (`worker.mjs:251-273`): on ANY single fetch failure or 502/503/504
from the real origin, the edge worker rewrites that one response into a
generic "Kortix is temporarily unavailable... maintenance" 503, per request.
It is a reasonable UX choice for real end-user traffic, but it means a genuine
backend capacity problem during a test run is invisible in the log as "backend
overloaded" — it reads as "scheduled maintenance," which sent this
investigation looking for a deploy or a flag before the real cause (a single
staging ECS task under-provisioned for the full release suite's own real
concurrent traffic) was found.

**The rule: don't diagnose `MAINTENANCE_MODE` at face value.** Check whether
`X-Maintenance-Mode: blocking` correlates with the backend's own health/restart
timestamps before assuming an intentional maintenance window — it is far more
likely the edge worker masking a real origin failure. And: running the full
release suite immediately after redeploying the target it tests is a
self-inflicted-outage risk on a single-task environment — the fresh task has no
warm connection pools and no capacity headroom, and the suite's own real load
is enough to tip it over. Give staging-api real headroom (task count/size) for
release runs, or the gate keeps eating its own tail.
*Incident:* v0.13.0 release (PR #6520). Correction 2026-08-19: this entry was
written during attempt 5 of run 32151213430; **no attempt of that run has
passed** (attempts 3–6 and 8–10 failed, 2 and 7 were cancelled). The
maintenance-mode 503s were real but were not the dominant cause of the later
attempts (4 occurrences in attempt 10 vs 36 in attempt 1) — see the next entry.
Capacity fix not yet made — staging still runs this gate at capacity risk.

**Addendum (2026-08-19) — what the capacity audit found, and the durable fix.**
Three facts, none of them visible from the symptom:

- **Staging was smaller than dev.** `environments/staging/main.tf:98-103` ran
  the API at `512/1024`, `desired/min/max = 1/1/3`; dev runs `2/2/6` and carries
  no load. The environment that absorbs the heaviest load in the company had the
  smallest box, and its autoscaling ceiling was 3 × 0.5 vCPU = 1.5 vCPU total.
- **The single task was Spot with `base = 0`** (`modules/ecs-api/main.tf:506`)
  behind `deployment_minimum_healthy_percent = 100` (`:521`). One Spot reclaim
  empties the service and ECS cannot place the replacement until Spot capacity
  returns. Some of the "cascading failures" chased that night may have been
  reclaims, not load — and the edge laundered both into the same 503. **Any Spot
  service whose total unavailability is a real cost needs an on-demand base.**
- **The database tier lives outside Terraform.** The staging DB is hosted
  Supabase (`ujzsbwvurfyeuerxxeaz`), injected as `STAGING_DATABASE_URL`; a
  repo-wide grep for RDS/ElastiCache returns zero hits. The `ci_micro` →
  `ci_medium` resize therefore survives every apply AND is recorded by nothing.
  **A resource no plan can show is a resource only a runbook can hold** —
  `docs/runbooks/staging-sizing.md` now does.

**The Terraform trap this exposed, which generalises past staging:** the ecs-api
service carries `ignore_changes = [task_definition, desired_count]` and the
task-def carries `ignore_changes = [container_definitions]`, by design so CI
image rolls do not fight Terraform. `infra/scripts/ecs-deploy.sh` then renders
each new revision from the service's CURRENT one. So **changing `task_cpu` /
`task_memory` in Terraform registers a revision the service never adopts — the
apply is green and the live task never resizes.** Writing a size into Terraform
is not the same as a task running at that size; verify with
`describe-task-definition` on the service's live revision, never from the plan.
Fixed durably by having `ecs-deploy.sh` take ONLY `cpu`/`memory` from the
family's latest ACTIVE revision (Terraform's, right after an apply; its own
previous one otherwise) and everything else from the service's current revision
— so a resize propagates on the next deploy and is a no-op on every other one.
*Enforcer:* `worker.test.mjs` pins staging >= dev on cpu/memory/min_capacity,
pins `fargate_base_on_demand = 1` on both staging services, and pins the new
module variable's default at `0` so dev/prod strategies cannot move.

### A frontend deploy job that `needs:` an unrelated edge job ships a half-deployed staging, and the release gate then blames the code (2026-08-19)

**When:** `deploy-staging.yml` for `044d99480d` (v0.13.0 candidate),
run 32149212400, 2026-08-18 14:34 UTC.

The job `Wire Cloudflare staging DNS and Worker` failed at
`Deploy staging API router Worker`: Cloudflare returned **403** on
`PUT …/workers/scripts/staging-api-kortix-router` (credential rejected; the
same step passed on 2026-08-12 run 31635834664). Because `deploy-web-vercel`,
`verify` and `promote-staging-channel` all `needs:` that job, they were
**skipped** — while `Apply DB migrations`, `Deploy API + gateway (ECS)` and
`Deploy staging web to ECS` had already succeeded. Staging ended up with the
new API and the OLD Vercel frontend, and nothing failed loudly: the workflow
was red, but the API `/health` reported the right SHA and the release PR kept
re-running `tests-release` against it. Every attempt then lost 15/21 browser
journeys to "heading/control not found" (`Admin overview`, `Billing`,
`Sandbox templates`, `Apps`, `Feature flags`, `Switch workspace`, …) — strings
that all exist on `staging` — plus `LOGIN-2`, which drives `$WEB/cli/authorize`.
Ten attempts and two learnings entries were spent reading those as
capacity/flake before anyone opened the deploy-staging run.

**The rule:** before re-running a release gate, open the *deploy* run for the
`RELEASE_SOURCE_SHA` and confirm every job is green — an API `/health` SHA
match proves the API only. When a gate fails with many "element not found"
browser assertions at once and the API lane is mostly green, suspect a stale
frontend deploy first. Structurally: the Vercel/frontend deploy must not
`needs:` the Cloudflare DNS/Worker job (they are independent), and `verify`
must fail loudly on a frontend/API SHA mismatch instead of being skipped along
with its dependency. And rotate the Cloudflare credential used by
`deploy-staging.yml`; it stopped working between 2026-08-12 and 2026-08-18.
*Incident:* v0.13.0 release (PR #6520), run 32151213430 ×10; frontend deploy
skipped since 2026-08-18 14:34 UTC.


### One OAuth provider per concern; and shape-validating a redirect is not authorizing it (2026-08-18)

**When:** wiring any OAuth/identity flow, reusing an existing provider for a
second purpose, or writing any route that redirects somewhere a caller named.

"Link a GitHub account" died on dev with Supabase's
`{"code":400,"error_code":"validation_failed","msg":"Unsupported provider: provider is not enabled"}`.
Nothing had changed in the code. Linking a GitHub **App installation** to a
Kortix account was minting its identity proof through Supabase's
general-purpose "Sign in with GitHub" **login** provider — so an account/org
feature's uptime hung on a per-Supabase-project dashboard toggle that exists
for unrelated product login and that no IaC in this repo manages. Supabase
never authenticated anyone's org; it was an incidental token-minting detour.
Meanwhile the GitHub App's OWN OAuth client — whose `client_id`/`client_secret`
the manifest flow already captured and stored — sat unread in the codebase.

The rule: **one integration per concern.** Before reusing an auth provider for
a second purpose, ask what a failure of the first purpose does to the second.
If the answer is "takes it down," they must not share. Prefer the credential
the feature already owns over the one that happens to be nearby.

**The expensive part was the replacement, not the diagnosis.** The new route
took a `frontend_origin` query param, signed it into the OAuth state, and had
the callback redirect the exchanged GitHub user token to it. Validation was
`normalizeGitHubFrontendOrigin` — which checks the *shape* (https, or http on
localhost) and NOT that the origin is ours. Every attacker HTTPS origin
passed, so `?frontend_origin=https://attacker.example` exfiltrated a victim's
user-to-server token, replayable against the installation-linking endpoints
(CWE-601, HIGH — found by strix-security in review).

**Shape validation is not authorization.** That sentence is the learning. A
URL being well-formed, https, and parseable says nothing about whether you are
allowed to send a credential to it. An allowlist — or better, no parameter at
all — is the check.

And the near-miss inside the near-miss: an earlier commit in the same PR
"fixed the open redirect" by normalizing that param before an early
`oauth_not_configured` return. That closed the *smaller* hole and left the
primary exfiltration path fully open, while reading like a completed security
fix in the diff and the commit message. **When you fix a redirect bug, enumerate
every branch that emits a Location header and every value that can reach one**
— fixing the branch you happened to be looking at is how a HIGH survives a
"security fix" commit. The final fix deleted the parameter entirely: the state
now carries only `{nonce, exp}` and both routes always land on `frontendUrl()`,
so there is no caller-influenced redirect target left to re-trust later.

Corollaries, all paid for in this same change:

- **Config that lives only in a vendor dashboard will drift and nobody will
  know.** Grep proved no Terraform anywhere manages Supabase Auth providers;
  each environment is hand-toggled. A feature depending on such config has no
  gate that can catch its absence — the first signal is a user hitting a 400.
- **Assert the negative.** The ke2e flow that earned its keep asserts where the
  redirect must NOT go ("never contains the attacker origin"), not which reason
  code came back. A happy-path assertion passes an open redirect; only the
  negative one fails it. It also has to cover every branch separately — the
  unconfigured-OAuth branch needed its own case because which branch fires
  depends on deployment state.
- **A branch no test configuration reaches is untested, however green the run.**
  The open-redirect branch only fires when OAuth is unconfigured; unit tests,
  tsc, lint and hand-run curl (against a *configured* API) were all green on it.
- An App's OAuth callback is `callback_urls` in the manifest, a different field
  from `redirect_url` (post-creation only); and binding new state to
  `SUPABASE_JWT_SECRET` broke instantly because hosted deployments set
  `KORTIX_GITHUB_APP_STATE_SECRET` and no Supabase JWT secret. Reuse the
  resolver the neighbouring feature already uses rather than a same-shaped one.
*Incident:* dev "Link a GitHub account" down; fixed in PR #6526. Four defects
were introduced and caught inside that one PR — an open redirect, a token
exfiltration (CWE-601), a signing secret unset in this deployment, and a
missing manifest field — none by a static gate.

### A test lane that rewrites tracked files is a concurrent writer; never `git add -A` beside it (2026-08-18)

**When:** committing while any background job runs — especially a publish,
release, codegen, or packaging check.

Every CI job on PR #6526 suddenly failed in setup: API typecheck in 11s,
Frontend build in 20s, all three test workers under 70s, none of them running
a single test. The error was `ERR_PNPM_OUTDATED_LOCKFILE — pnpm-lock.yaml is
not up to date with packages/sdk/package.json`. Local runs stayed green
throughout, because the local tree was fine.

The cause: `pnpm test -- --packages-only` was running in the background while
a commit was made with `git add -A`. That lane's publish check temporarily
rewrites every publishable `package.json` — version to `0.0.0-local-test`,
and it strips fields such as `keywords` — then restores them when it finishes.
The blanket add captured that mutated state mid-run and committed four
packages pinned to `0.0.0-local-test` with no matching lockfile.

The rule: **stage explicit paths, never `git add -A`, when anything else could
be writing the tree.** Treat a test lane that mutates tracked files as a
concurrent writer with the same care as a parallel agent (see
[[shared-worktree-parallel-agent-wipe]] and
[[primary-checkout-may-be-parallel-work]]).

Two diagnostics worth keeping: **a whole-matrix failure in well under the
usual runtime is a setup failure, not a test failure** — read the install step,
not the test output. And **reproduce the exact CI step** (`pnpm install
--frozen-lockfile`) rather than the lane it belongs to; it fails in one second
and names the file.
*Incident:* PR #6526, one full CI cycle lost; caught by reading the install
step after the failure pattern (fast + everything) ruled out the tests.

### `CREATE INDEX CONCURRENTLY` under a 5-second `lock_timeout` cannot land on live prod (2026-08-19)

**When:** writing or applying any `.concurrent` migration; responding to a `55P03`
("canceling statement due to lock timeout") during `Apply DB migrations to prod`.

v0.13.0's deploy-prod (run 32248002434) failed its migration job twice, both times
on a `.concurrent` migration that did `set lock_timeout = '5s'` then
`create index concurrently …` — first on `kortix.iam_roles` (6 rows, 80 kB),
then on `kortix.account_tokens` (30k rows). The table size is irrelevant:
`CREATE INDEX CONCURRENTLY` has to wait for EVERY transaction in the database
that started before it (it takes a ShareLock on each one's virtual transaction
id), and `lock_timeout` governs that wait. On live prod — audit_events writers
on every request, multi-second session-turn transactions — some transaction
outlives a 5-second budget almost every time, so the CIC is cancelled and leaves
an INVALID index behind, which makes a plain re-run fail with "already exists".
The 2–5 s house value exists to keep DDL from blocking prod; CIC's wait blocks
nobody, so that rationale does not apply to it.

The rule: **in a `.concurrent` migration, set `lock_timeout` long enough for a
live system — 2–3 minutes — and note why in the file.** The one lock a CIC
holds (ShareUpdateExclusive on the table) only excludes other DDL/VACUUM; a long
wait on virtual transaction ids hurts no user.

Recovery when it has already failed (used twice tonight, ~2 min each):
1. `select indexrelname from pg_stat_user_indexes s join pg_index i on
   i.indexrelid=s.indexrelid where not i.indisvalid` — find the INVALID leftover.
2. `drop index concurrently if exists <it>`.
3. Hand-run the migration's exact statements in `psql` with
   `set lock_timeout='180s'; set statement_timeout='30min'`; confirm `indisvalid`.
4. `insert into kortix_migrations.pgmigrations (name, run_on) values ('<file
   basename without extension>', now())` — the ledger must match what is live.
5. `gh run rerun <deploy-prod run> --failed` — the migrate step sees nothing
   pending and the roll proceeds.
Migration files are immutable once merged (CI enforces it), so do not edit the
failing file; fix the template/house rule for the next one.
*Incident:* v0.13.0 deploy-prod run 32248002434, migrations
`20260819015724600_rbac_canonical_indexes.concurrent` and
`20260819015726000_account_tokens_session_id_index.concurrent`; ~30 min of
release delay. Prod also carries four pre-existing INVALID legacy indexes
(`public.idx_messages_*`, old Suna table) that predate this and were left alone.

### A redirect URI, a protocol handshake, and a cached catalog all break silently the first time a third party is real (2026-08-19)

**When:** integrating any third-party OAuth provider or remote MCP server;
building any flow whose success depends on what an external server accepts.

Kortix's generic OAuth2 connector surface passed its unit tests, its ke2e flow,
and a full local run. It had never completed one authorization against a real
provider. Three defects were sitting in it, and each one is invisible until a
third party refuses you.

**1. A redirect URI derived from the request is the wrong origin.** The
authorize route built the callback with
`new URL('/v1/connectors/oauth2/callback', c.req.url)`. Behind the load
balancer the API sees the *internal* origin, so dev emitted
`http://dev-api-ecs-fargate.kortix.com/v1/connectors/oauth2/callback` — plain
http, internal hostname. An authorization server byte-compares `redirect_uri`
against the registered value, so every real authorization would have been
rejected. Locally it looked perfect, because locally `c.req.url` *is* the
public origin. **A value a third party will compare against must come from
configuration (`KORTIX_URL`), never from the incoming request.** The same rule
covers webhook URLs, issuer strings, and audience values. Anything derived from
`req.url` is correct exactly until a proxy is in front of you.

**2. "Optional" in a spec means "mandatory" for some implementations.** MCP's
streamable-HTTP transport describes `initialize` → `notifications/initialized`
→ `Mcp-Session-Id`. Kortix posted a bare `tools/call`, which every *stateless*
server accepts — so it worked against the servers we happened to try. Servers
built on the official MCP SDKs default to **stateful** and answer anything
without a session id with `400 Bad Request: Server not initialized`. Read as a
generic 400, that looks like a malformed request, not a missing handshake.
**When a protocol describes a handshake, implement the handshake, even if your
first three test servers do not need it.** Two details that are easy to get
wrong and are load-bearing: the session cache key must include the
*credential* (or two principals share one server session), and `401`/`403` must
never be treated as a handshake failure and retried — those are credential
problems and belong to the caller untouched.

**3. A credential-dependent cache computed before the credential exists is
poison, and nothing recomputes it.** An MCP tool catalog is fetched *with* the
connector credential. Creating the connector before authorizing it therefore
recorded `status: 'error'`, `last_error: "MCP tools/list failed: HTTP 401"`.
Completing OAuth wrote the token and stopped. The user finished the flow, saw
"connected", and the connector still read **Error** with zero tools — the exact
failure the feature existed to remove, now with a success toast on top of it.
**Whenever a credential starts to exist, re-run everything that failed for want
of it.** Ask of any cache: which inputs can arrive *after* this was computed,
and what re-runs it when they do? Here the repo already had the helper
(`rematerializeCatalogAfterCredentialUpdate`); only the OAuth completion paths
never called it.

The meta-rule tying all three together: **an integration is unverified until it
has completed once against the real third party.** Not a mock, not a fixture,
not a conformant test double — the actual server. All three defects survived a
green suite; all three fell out within minutes of pointing the flow at
`api.read.ai`. Budget for one live end-to-end run before calling any
third-party integration done, and prefer a provider that implements the spec
strictly (dynamic registration, stateful sessions) as the one you test against.

*Incident:* found and fixed while building one-click OAuth 2.1 for MCP
connectors, PR #6579. No production outage — the surface had never been used
against a real provider, which is precisely why all three shipped unnoticed.
