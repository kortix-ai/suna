# `@kortix/sdk` — progress

**Single source of truth for _state_** across every session and every plan. Not for
design (that's a spec) and not for _how_ (that's a plan). This file indexes them.

> **Multiple sessions run against this repo.** Read this file **before** starting
> work, and update it **before** ending your turn. Both are mandatory.

**Scope:** everything `@kortix/sdk`. The **Now** section below tracks one plan at a
time. Work outside that plan lives in **Next** and **Backlog** — it is real, it is
tracked, and it is not forgotten just because it isn't scheduled.

---

## Who may edit what

| Section                     | Agents may…                                            | Agents may **not**…                                                                                         |
| --------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| **Now** (the active chain)  | claim a task, update its status, add evidence          | **renumber, reorder, delete, or insert tasks.** The plan and the execution prompt reference them by number. |
| **Next**                    | move an item to Now when its plan exists               | start it without a spec                                                                                     |
| **Backlog**                 | **append freely** — this is where discovered work goes | reorder or delete existing rows                                                                             |
| **Discovered this session** | **append freely**                                      | rewrite others' entries                                                                                     |
| **Open decisions**          | append a question; mark one RESOLVED with the answer   | resolve one on the user's behalf                                                                            |
| **Session log**             | **append only**, newest at the bottom                  | edit any earlier entry                                                                                      |

**Never delete a row.** Mark it `WON'T DO (reason)` and leave it. A deleted row is
a decision nobody can audit.

**Found work mid-task? Do not do it.** Append it to **Backlog** or **Discovered
this session**, finish the task you claimed, and tell the user. Scope creep inside
a task is how a 146-file move becomes unreviewable.

**Multi-step work does not become a Task.** The **Now** chain comes from one plan
document. New multi-step work earns its own spec → plan → chain. Backlog rows are
single, self-contained changes.

---

## "Can I run three agents, each picking a task?" — No.

Read this before you try. It is the most expensive mistake available here.

**This file is a handoff across _time_, not a work queue across _space_.** It exists
so a session that starts tomorrow knows what yesterday's finished. It does **not**
make the tasks parallelisable.

Two independent reasons:

**1. The Now chain is a chain.** Task 4 moves **146 files** (97 source + 49 colocated
tests). A file move has _no behaviour to assert_ — the only proof you moved files
rather than renamed an export is that **Task 3's snapshot did not budge**. Start 4
before 3 lands and the riskiest change in the plan runs with no net. 5 needs 4's
tree; 6 needs 5's surface; 8 bundles 5's final shape.

**2. Sessions in the same worktree share one filesystem and one git index.** Agent B
running `bun test` while Agent A is mid-`git mv` does not read a stale file — it
reads a file that no longer exists. The claim commits race too: both
`git add PROGRESS.md && git commit`, and one loses.

And there is nowhere to hide: Tasks 4 and 5 touch **both export maps**, `src/index.ts`,
`src/index.isomorphic.test.ts`, and 146 moved files — nearly every file in the
package. No second task avoids collision.

### What the claim protocol actually buys

Only this: **two sessions never do the same task.** It is not a lock on the tree, and
it does not make a chain into a queue. Do not read it as permission to fan out.

### What _can_ run in parallel

| Stream                      | Where                                                              | Safe?                                                                                                              |
| --------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| The Now chain (Tasks 1→10)  | `suna-ts-sdk`, one session                                         | ✅ — parallelise **inside** it with subagents, never across sessions                                               |
| **Lumen productionisation** | a **separate worktree** (`pnpm worktree create --name lumen-prod`) | ✅ — touches `apps/whitelabel-demo/src/server/*` only. Zero overlap with `packages/sdk`. Needs its own spec first. |
| RN transport seam           | —                                                                  | ❌ edits `src/state/event-stream.ts`, the exact file Task 4 moves                                                  |
| Backlog B1/B2/B3            | —                                                                  | ❌ all add exports; collides with Task 5's barrel rewrite. Do them **after** Task 5.                               |

Throughput inside the SDK comes from **subagents within one session**
(`superpowers:subagent-driven-development`), sequenced against the chain — not from
concurrent top-level sessions.

---

## Protocol for sessions

Git is the only lock we have, and it is advisory. Behave accordingly. This protocol
guards **sequential** sessions (and the rare deliberate second worktree), not a
free-for-all.

**Before you start**

1. `git pull` (or rebase) so you are not reading a stale table.
2. If a task is `IN PROGRESS` and `Last touched` is within ~24h, **do not take
   it** — another session owns it. Take the next `NOT STARTED` task whose
   dependencies are `DONE`.
3. Claim it: set status `IN PROGRESS`, add your session id and the date, and
   **commit that one-line change by itself, before doing any work:**

       git add packages/sdk/PROGRESS.md
       git commit -m "chore(sdk): claim Task N"

   A claim made after the work is a report, not a lock.

**Before you finish**

4. Update the row: `DONE (sha)`, or back to `NOT STARTED` / `BLOCKED (reason)`.
   A task left `IN PROGRESS` by a session that ended is a lie the next session
   will believe.
5. **Append a session-log entry.** Appends merge cleanly across branches; table
   edits conflict. Short on turn? Append anyway.

**Stale claims.** `IN PROGRESS`, older than ~24h, no commits touching its files →
abandoned. Take it over and say so in the log. Never overwrite silently.

**Never mark `DONE` without pasting the evidence** — the commands you ran and their
real output. `typecheck` is not evidence.

---

## COMPLETED PLAN — v2 structure & distribution

- **Plan:** `docs/superpowers/plans/2026-07-10-sdk-v2-structure-and-distribution.md`
- **Spec:** `docs/superpowers/specs/2026-07-10-sdk-v2-structure-and-distribution-design.md`
- **Kickoff prompt:** `docs/superpowers/plans/2026-07-10-sdk-v2-execution-prompt.md`

**Ordering is load-bearing.** Each task is the safety net for the next. Task 3's
snapshot is the _only_ test Task 4 has, because a file move has no behaviour to
assert. **Do not run out of order. Do not parallelise.** Dependencies are strictly
`1 → 2 → … → 10`; only 7, 8 and 10 have slack, and only after 6.

| #   | Task                                                    | Status                                                                                                                                                                                                                           | Session    | Last touched | Commit                                   |
| --- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------ | ---------------------------------------- |
| 0   | Docs: spec, plan, `AGENTS.md`, prompt, this file        | **DONE**                                                                                                                                                                                                                         | `01AzJBSa` | 2026-07-10   | `6cd4d6e4e`                              |
| 1   | Assert the two export maps agree                        | **DONE**                                                                                                                                                                                                                         | `ab099b6a` | 2026-07-10   | `ecb78a113`                              |
| 2   | Install smoke test — pack, install, import              | **DONE**                                                                                                                                                                                                                         | `ab099b6a` | 2026-07-10   | `7220e9587`                              |
| 3   | Public-export snapshot                                  | **DONE** (snapshot approved by Jay at hard stop #2)                                                                                                                                                                              | `ab099b6a` | 2026-07-10   | `84e15ca72`                              |
| 4   | Axis 1 — internal restructure (`core`/`browser`/`node`) | **DONE**                                                                                                                                                                                                                         | `ab099b6a` | 2026-07-10   | `4c6f7102c` (4 commits from `25068d272`) |
| 5   | Axis 2 — root canonical, subpaths deprecated            | **DONE** (snapshot growth accepted by Jay at hard stop #3)                                                                                                                                                                       | `ab099b6a` | 2026-07-10   | `b5e588dbc`+`aafbdf91b`                  |
| 6   | Dogfood `whitelabel-demo` (acceptance gate)             | **DONE**                                                                                                                                                                                                                         | `ab099b6a` | 2026-07-10   | `db30c6df3`+`19e500e50`                  |
| 7   | Portability — ban bare globals in `core/`               | **DONE**                                                                                                                                                                                                                         | `ab099b6a` | 2026-07-10   | `189428df7`+`a485ad401`                  |
| 8   | `tsup` bundles — CDN ESM + `window.Kortix`              | **DONE**                                                                                                                                                                                                                         | `ab099b6a` | 2026-07-10   | `c7bca7a7e`                              |
| 9   | Examples — `07-vanilla.ts`, `08-cdn.html`               | **DONE** (steps 1–5 `549d597a0`, review clean; Step 6 executed 2026-07-12 — D2a + D3 **PASS** in real Chromium vs live local stack, evidence in session log + `docs/superpowers/reviews/2026-07-12-sdk-production-readiness.md`) | `ab099b6a` | 2026-07-10   | `549d597a0` + live gate                  |
| 10  | Docs — README, CHANGELOG, API-MAP                       | **DONE**                                                                                                                                                                                                                         | `ab099b6a` | 2026-07-10   | `6e9cc9f5a`                              |

Statuses: `NOT STARTED` · `IN PROGRESS` · `BLOCKED (reason)` · `DONE (sha)` · `WON'T DO (reason)`

### Hard stops — bring these to Jay, do not decide alone

- [ ] **Task 2, first run.** Nothing has ever installed and imported the tarball. A failure is a **real pre-existing bug**, not something to loop on. Report it.
- [ ] **Task 3, before committing the snapshot.** It becomes ground truth for everything after.
- [ ] **Task 5, Step 12 — the snapshot diff.** Additions fine. **A removal or rename means a broken consumer.** Never accept the diff to reach green.
- [x] **Task 9, Step 6.** Real browser, live stack, real sandbox. D2a (streaming through the IIFE global) and D3 (`instanceof Kortix.ApiError` under the bundle) cannot be claimed without it. — **Executed 2026-07-12, both PASS** (Chromium + live stack + real PAT/sandbox; see session log).

Also stop if the same failure survives three different fixes (use
`superpowers:systematic-debugging`), or you are about to change what a test asserts.

---

## COMPLETED PLAN — web SDK-only boundary

- **Plan:** `docs/superpowers/plans/2026-07-24-web-sdk-only-boundary.md`
- **Spec:** `docs/superpowers/specs/2026-07-24-web-sdk-only-boundary-design.md`

| #   | Task                              | Status | Session             | Last touched | Commit                    |
| --- | --------------------------------- | ------ | ------------------- | ------------ | ------------------------- |
| 1   | Baseline and static boundary gate | DONE   | `frontend-sdk-only` | 2026-07-24   | `b388f2f58`               |
| 2   | Canonical SDK imports             | DONE   | `frontend-sdk-only` | 2026-07-24   | `b84e23c17`               |
| 3   | One session engine                | DONE   | `frontend-sdk-only` | 2026-07-24   | `486df10f4`               |
| 4   | Runtime-neutral web state         | DONE   | `frontend-sdk-only` | 2026-07-24   | `afbd6e5a0`               |
| 5   | Typed platform API coverage       | DONE   | `frontend-sdk-only` | 2026-07-24   | `65202adea`               |
| 6   | Remove runtime routing knowledge  | DONE   | `frontend-sdk-only` | 2026-07-24   | `e6241bbfc`               |
| 7   | Local parity proof                | DONE   | `frontend-sdk-only` | 2026-07-24   | `6c02b601e`               |
| 8   | Delivery and dev proof            | DONE   | `frontend-sdk-only` | 2026-07-24   | `aefa2a628` + `8688b8492` |

---

## COMPLETED PLAN — native integration authentication lifecycle

- **Plan:** `docs/superpowers/plans/2026-07-25-native-integration-auth-lifecycle.md`
- **Spec:** `docs/superpowers/specs/2026-07-25-native-integration-auth-lifecycle-design.md`

| # | Task | Status | Session | Last touched | Commit |
|---|---|---|---|---|---|
| 1 | Contracts and RED tests | DONE | `native-oauth-full-lifecycle` | 2026-07-25 | `de7026bfc` |
| 2 | Database lifecycle | DONE | `native-oauth-full-lifecycle` | 2026-07-25 | `572bedb5a` |
| 3 | OAuth2 protocol engine | DONE | `native-oauth-full-lifecycle` | 2026-07-25 | `db31d216e` |
| 4 | API lifecycle routes | DONE | `native-oauth-full-lifecycle` | 2026-07-25 | `63dda6afe` |
| 5 | Executor and non-OAuth request authentication | DONE | `native-oauth-full-lifecycle` | 2026-07-25 | `35daeda10` |
| 6 | SDK and web integration | DONE | `native-oauth-full-lifecycle` | 2026-07-25 | `b3826fa8f` |
| 7 | Local verification | DONE WITH BROWSER BLOCKER | `native-oauth-full-lifecycle` | 2026-07-25 | `4575346db` |
| 8 | Delivery and dev proof | DONE | `native-oauth-full-lifecycle` | 2026-07-25 | `00bc29065` + `8a1249883` |

---

## NOW — active plan: OpenCode ACP canary

- **Plan:** `docs/superpowers/plans/2026-07-25-opencode-acp-canary.md`
- **Spec:** `docs/superpowers/specs/2026-07-25-opencode-acp-canary-design.md`

| # | Task | Status | Session | Last touched | Commit |
|---|---|---|---|---|---|
| 1 | Native process and protocol core | DONE | `acp-opencode-canary` | 2026-07-25 | `2ba64ab68` |
| 2 | Authenticated HTTP/SSE bridge | DONE | `acp-opencode-canary` | 2026-07-25 | `8560c2dfc` |
| 3 | API transport metadata and rollback | DONE | `acp-opencode-canary` | 2026-07-25 | `b558def6f` |
| 4 | SDK ACP transport | DONE | `acp-opencode-canary` | 2026-07-25 | `a28df36f3` |
| 5 | SDK session projection | DONE | `acp-opencode-canary` | 2026-07-25 | `951896a44` |
| 6 | Existing `useSession` integration | DONE | `acp-opencode-canary` | 2026-07-25 | `951896a44` |
| 7 | Local parity and rollback proof | DONE | `acp-opencode-canary` | 2026-07-25 | `33900d7f1` |
| 8 | Delivery and dev proof | DONE | `acp-opencode-canary` | 2026-07-25 | `3a45ab55b` |

---

## NEXT — committed, needs a spec before it starts

Real work, deliberately not scheduled. **Do not start these.** Each needs its own
spec → plan → chain.

| Item                                                        | Why it waits                             | Cost of waiting                                                                                                                                                                                                                                            |
| ----------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RN `EventStreamTransport` seam**                          | Designed in the v2 spec; deferred by Jay | `apps/mobile/lib/opencode/event-stream.ts` (655 loc) stays a parallel copy of the SDK's 571-loc one. **The divergence grows every week.** Schedule soon.                                                                                                   |
| **Lumen productionisation**                                 | Blocks Lumen's prod ship, not the SDK    | Ownership is a JSON file (`apps/whitelabel-demo/src/server/users.ts`), rate limiting an in-memory `Map` (`…/rate-limit.ts`), both documented single-instance. Anonymous visitors mint a fresh `userId` per visit **and provision real Daytona sandboxes**. |
| **Migrate `apps/web`'s 340 import sites to the root entry** | Optional, mechanical                     | None — the deprecated aliases exist precisely so this has no deadline.                                                                                                                                                                                     |

---

## BACKLOG — real gaps, unscheduled. Agents: append here.

Single, self-contained changes. Anything multi-step earns a spec instead.

| #   | Gap                                                                                                                                                                                                                                                                                                                                                                                                                                          | Evidence                                                                                                                                                                                                                                                                                                | Status                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | **No skills create/update/delete surface.** The only agent capability with zero SDK coverage.                                                                                                                                                                                                                                                                                                                                                | `grep -rn "createSkill                                                                                                                                                                                                                                                                                  | deleteSkill" packages/sdk/src`→ nothing but a comment in`projects-client/agent-config.ts:7`                                                                                                                                                                            | OPEN |
| B2  | **No account-deletion surface.**                                                                                                                                                                                                                                                                                                                                                                                                             | `grep -rn "deleteAccount" packages/sdk/src` → nothing                                                                                                                                                                                                                                                   | OPEN                                                                                                                                                                                                                                                                   |
| B3  | **Host-local React hooks that belong in the SDK.** `apps/web` hand-rolls hooks over client fns the SDK already exposes — violating "hosts are thin".                                                                                                                                                                                                                                                                                         | `apps/web/src/hooks/{transcription/use-transcription,projects/use-project-gateway,channels/use-channel-bindings}.ts`. `@kortix/sdk/react` has only `use-gateway-catalog-sync.ts`.                                                                                                                       | OPEN                                                                                                                                                                                                                                                                   |
| B4  | `**.name` on `ApiError` is duck-typed by legacy sniffers.** Changing it is a _silent runtime_ break, not a compile break.                                                                                                                                                                                                                                                                                                                    | `src/platform/api/errors.ts:59` — `this.name = 'ApiError'`, with a comment noting legacy sniffers                                                                                                                                                                                                       | WON'T DO for now — documented in `AGENTS.md`; revisit only with a deprecation path                                                                                                                                                                                     |
| B5  | `**structure_version` semantics undocumented** (`1` = legacy tasks, `2` = tickets/board)                                                                                                                                                                                                                                                                                                                                                     | `src/opencode/kortix-master.ts`                                                                                                                                                                                                                                                                         | OPEN                                                                                                                                                                                                                                                                   |
| B6  | **Tripwire regex is blind to side-effect imports.** `import 'react';` (no `from`) matches neither the graph walker's regex nor the examples tripwire — a bare framework side-effect import slips through                                                                                                                                                                                                                                     | Task 9 probe: brief's literal `import 'react';` did NOT fail the test; `import { createElement } from 'react'` did. `src/index.isomorphic.test.ts` (`collectGraph` importRe + examples test)                                                                                                            | **CLOSED 2026-07-12** — shared `importSpecifiers` helper now catches side-effect imports (both quote styles) in the graph walker, the examples scan, AND the inline tier scan; RED-proven, reviewed. Uncommitted fix wave, see `.superpowers/sdd/fix-wave-2-report.md` |
| B7  | **Provider-qualified gateway defaults must remain in the `kortix` picker namespace.** Lock `codex/gpt-5.6-sol` to `{ providerID: 'kortix', modelID: 'codex/gpt-5.6-sol' }` rather than misclassifying it as a native provider.                                                                                                                                                                                                               | `src/react/use-model-store.ts:42` defines every gateway wire model as a `kortix` model ID; `src/react/use-opencode-local.test.ts` now covers the Codex default.                                                                                                                                         | **DONE 2026-07-12** — implementation `ee7d2cc09`; full SDK suite, typecheck, and packed-install smoke green                                                                                                                                                            |
| B8  | **Retire the experimental project-app deployment SDK surface with its removed platform capability.** This is intentionally subtractive because the user explicitly requested complete removal of the underlying capability.                                                                                                                                                                                                                  | The former project-app client module, facade property, types, examples, and snapshot entries were removed in `ec8b44dda`.                                                                                                                                                                               | **DONE 2026-07-13** — session `remove-freestyle`; full SDK gates green                                                                                                                                                                                                 |
| B9  | **Expose E2B as an additive sandbox-provider literal everywhere the published SDK accepts or reports a provider.**                                                                                                                                                                                                                                                                                                                           | Stale explicit unions remained in `src/core/rest/{platform-client/types,projects-client/session-sandbox,projects-client/sessions}.ts`; the server provider unification adds `e2b`.                                                                                                                      | **DONE 2026-07-13** — implementation `5763b63e4`; full SDK gates green                                                                                                                                                                                                 |
| B10 | **Expose the managed Git username alongside the push token.** Code Storage uses `t:<token>` while GitHub uses `x-access-token:<token>`; clients need the provider-selected username to clone and push without hard-coding GitHub credentials.                                                                                                                                                                                                | `src/core/rest/projects-client/projects.ts` models `ProjectGitToken` with only `push_token`; the Code Storage end-to-end flow requires an additive `git_username`.                                                                                                                                      | **DONE 2026-07-19** — implementation `ab80f9305`; full SDK suite, typecheck, and packed-install smoke green                                                                                                                                                            |
| B11 | **Expose owner-scoped member connection-profile creation and profile-specific Pipedream connect/finalize.**                                                                                                                                                                                                                                                                                                                                  | Existing profile lifecycle methods only target manager-owned `/connector-profiles` and the shared connector Pipedream identity; session-selected member profiles need additive typed methods for `/connector-profiles/me` and `/{profileId}/connect`.                                                   | **DONE 2026-07-21** — implementation `3eb18b361`; full SDK suite, typecheck, and packed-install smoke green                                                                                                                                                            |
| B12 | **Allow daemon-owned PTY queries before OpenCode reports ready.**                                                                                                                                                                                                                                                                                                                                                                            | `useOpenCodePtyList()` gates `/kortix/pty` on `useOpenCodeRuntimeReady()`, while `apps/kortix-sandbox-agent-server/src/proxy.ts` owns `/kortix/pty` independently of OpenCode.                                                                                                                          | **DONE 2026-07-22** — implementation `c973f9209`; SDK and web suites, packed-install smoke, isolated proxy tests, and live Platinum/Daytona PTY smokes green                                                                                                           |
| B13 | **Add bounded GitHub repository discovery for large managed owners.** The current client can only request the full owner repository list, which exceeds the API processing deadline for `managed-kortix`.                                                                                                                                                                                                                                    | Production `GET /v1/projects/github/repositories?...&installation_id=pat` returned `503` after 25 seconds; `packages/sdk/src/core/rest/projects-client/github.ts` exposes no page or search input.                                                                                                      | **DONE 2026-07-23** — `0748271116`; session `github-repo-selector`                                                                                                                                                                                                     |
| B14 | **Remove the synthetic `auto` model and enforce paid-tier access for every Kortix-managed model in every environment.** Free-tier wallet credits are sandbox-only; stale `auto` requests must fail closed instead of selecting a managed fallback.                                                                                                                                                                                           | `packages/sdk/src/react/use-opencode-local.ts` sends `kortix/auto`; `apps/api/src/billing/services/tiers.ts` disables managed-model entitlement enforcement for every dev/preview account.                                                                                                              | **DONE 2026-07-24** — implementation `406eb5e9a`; session `fix-free-tier-model-entitlement`                                                                                                                                                                            |
| B15 | **Top-level `runtime()` on a scoped client bled to the process-global sandbox (cross-tenant).** `createScopedKortix`'s `wrapScoped` scopes the token but not the top-level `runtime()`, which resolves the process-global active runtime (`getActiveOpenCodeUrl()` → last session to `ensureReady()`). In a multi-tenant KaaB wrapper `kortixA.runtime()` reached another end-user's sandbox. #5273 scoped `session().runtime` but not this. | `src/node/server.ts` (`createScopedKortix`); `src/core/client/kortix.ts:43,752,1000`; `src/core/session/server-store/active.ts:21`. RED-proven in `src/node/server.test.ts` (scoped `runtime()` returned a client instead of throwing).                                                                 | **DONE 2026-07-23** — session `sdk-scoped-runtime`; scoped `runtime()` now throws + steers to `session(pid,sid).runtime`; adds no public export (surface snapshot unchanged); typecheck + full suite (1156 pass) + `smoke:install` green                               |
| B16 | **Retry transient transport failures on idempotent REST reads before reporting them.** Browser CORS preflight failures surface as opaque `TypeError: Failed to fetch`, bypass the existing HTTP 502/503/504 retry loop, and call the host error handler before React Query retries successfully. Cache successful preflights to reduce exposure without retrying mutations.                                                                  | Production session `d9abee06-5af1-48b9-ba92-53ca0fcf0589` logged continuous audit `200` responses after one browser preflight failure; `src/core/http/api-client.ts` retries response statuses but reports initial fetch throws immediately; `apps/api/src/index.ts` emits no `Access-Control-Max-Age`. | **DONE 2026-07-24** — implementation `9f6e5b615`; session `cors-transport-resilience`                                                                                                                                                                                  |
| B17 | **Add native OAuth2 client-credentials lifecycle support to existing connector connection profiles.** Static bearer credentials cannot acquire, cache, refresh, or revoke OAuth2 access tokens. Microsoft Graph and SharePoint require OAuth2 and cannot use a static API key.                                                                                                                                                               | `apps/api/src/executor/credentials.ts` decrypts one opaque value; `apps/api/src/executor/db-deps.ts` passes that value directly to `executeCall`; `packages/sdk/src/core/rest/projects-client/connectors.ts` accepts only `{ value }`.                                                                  | **DONE 2026-07-24** — session `native-oauth-sharepoint`; full SDK gates and real SharePoint proof green                                                                                                                                                                |
| B18 | **Keep the managed-model playground pin synchronized with the managed catalog.** The playground exits before API access when its pinned IDs differ from `MANAGED_MODELS`.                                                                                                                                                                                                                                                                    | `packages/sdk/playground/chat/14-change-default-model.ts` still pins retired `qwen3.7-max` and `deepseek-v4-pro`.                                                                                                                                                                                       | **DONE 2026-07-24** — session `managed-models-aster`; full SDK gates green                                                                                                                                                                                             |
| B19 | **Preserve explicit managed-model pricing and cache-write rates through the project catalog and turn-cost estimator.** Browser-side `models.dev` lookup can substitute another provider's price for a Kortix-managed model, and the turn estimator does not accept a distinct cache-write rate.                                                                                                                                              | `src/core/rest/projects-client/projects.ts`, `src/core/turns/types.ts`, `src/core/turns/state.ts`; confirmed for managed Aster `glm-5.2`.                                                                                                                                                               | **DONE 2026-07-25** — implementation `28c18cbfa`; full SDK suite, typecheck, public-surface snapshot, and packed-install smoke green                                                                                                                                   |
| B20 | **Keep ACP SSE connections outside the shared 30-second authenticated-fetch timeout.** The ACP controller uses `/kortix/acp/:sessionId` as a long-lived SSE stream.                                                                                                                                                                                                                                                                            | `src/platform/auth-core.ts` exempted only `/global/event`; deployed cold Chromium aborted the ACP stream before `session/load` settled.                                                                                                                                                                | **DONE 2026-07-25** — implementation `89b97f4cc`; RED test, full SDK gates, and local cold ACP plus REST browser matrix pass                                                                                                                                                                                                         |
| B21 | **Serialize ACP sends with runtime restart reloads.** A send that starts while OpenCode restarts can wait forever on `session/set_config_option` and never send `session/prompt`.                                                                                                                                                                                                                                                               | Deployed cold Chromium sent `session/set_config_option` at `13:36:20.250Z`, received `kortix/runtime_ready`, then sent `session/load` at `13:36:20.640Z`; `POST_RESTART_PONG` never produced `session/prompt`.                                                                                              | **DONE 2026-07-25** — implementation `d8537fa2c`; RED tests, full SDK gates, and test-harness typecheck pass                                                                                                                                                                                                                          |
| B22 | **Expose server-owned warm project-session ensure and claim operations.** The project index needs one reusable empty session without owning session selection or deduplication in app code.                                                                                                                                                                                                                                                   | `apps/web/src/app/(app)/projects/[id]/page.tsx` creates a session only after send. `packages/sdk/src/core/rest/projects-client/sessions.ts` exposes create and list, but no atomic warm-session operation.                                                                                              | **DONE 2026-07-26** — implementation `13167d7cf`; RED tests, full SDK gates, live API/SDK lifecycle, workspace refresh, and maintenance retention proof pass                                                                                                                                                                           |
| B23 | **Prevent ACP prompt results from exposing a false idle window before late protocol updates settle.**                                                                                                                                                                                                                                                                                                                                          | The deployed white-label parity screenshot rendered 4 ACP tool cards and `Agent is working…`, while REST rendered 26 completed tool cards. `applyAcpEnvelope()` marks the projection idle on the prompt result, and later tool or text updates can mark it busy again.                                                                                                  | **IN PROGRESS 2026-07-26** — session `whitelabel-acp-stable-completion`; RED test, SDK fix, strengthened parity gate, merge, Deploy Dev, and deployed proof required                                                                                                                            |
| B24 | **Accept a server-authorized initial OpenCode session pin in `useSession`.** The SDK must hydrate the cached transcript before runtime readiness without making the initial pin authoritative over the `/start` result.                                                                                                                                                                                                                          | Existing sessions wait for `/start` before `useSessionSync` can hydrate IndexedDB history. The preserved `session-load-latency` work proved the additive option and pin precedence.                                                                                                                       | **IN PROGRESS 2026-07-26** — session `api-latency-refactor`; RED test, implementation port, full SDK gates, browser proof, merge, and Deploy Dev proof required                                                                                                                               |
| B25 | **Start project model-picker and project-detail reads in parallel.** Gateway projects must not wait for project detail before the SDK starts the compact model-picker request.                                                                                                                                                                                                                                                                   | `src/react/use-opencode-sessions/providers.ts` enables the model query only after `projectDetailQuery.isSuccess`, which creates a sequential request waterfall on project load.                                                                                                                          | **IN PROGRESS 2026-07-26** — session `api-latency-refactor`; RED test, implementation, full SDK gates, browser network proof, merge, and Deploy Dev proof required                                                                                                                            |
| B26 | **Do not report an expected warm-session configuration mismatch as a global API error.** The web client catches `WARM_SESSION_CONFIGURATION_MISMATCH` and creates a normal session.                                                                                                                                                                                                                                                               | `src/core/rest/projects-client/sessions.ts` calls `/sessions/warm/claim` with the default `showErrors: true`, so the recoverable `409` still reaches the host error handler.                                                                                                                                | **DONE 2026-07-26** — PR #5529, merge `5c0ae97ec`; SDK tests `1280/0`; deployed US proof observed the typed `409`, normal-session fallback, exact `PONG`, and no global mismatch error                                                                                                      |
| B27 | **Retry the transient IAM policy read that caused the all-account project query failure.** The projects page can issue one query per account.                                                                                                                                                                                                                                                                                                     | Live US shadow evidence at `2026-07-26T20:03:20Z`: one IAM-backed `GET /projects` returned `500`; the identical retry returned `200` after `1.4s`. The wrapped `DrizzleQueryError` hid the nested PostgreSQL cause from logs.                                                                                  | **DONE 2026-07-26** — PR #5529, merge `5c0ae97ec`; one bounded transient read retry fails closed; wrapped PostgreSQL details are logged; API tests `40/0`; US API rollout completed with `2/2` tasks                                                                                             |
| B28 | **Keep an explicit project-composer agent selection through asynchronous project-default hydration.**                                                                                                                                                                                                                                                                                                                                               | The deployed US two-test session suite clicked `memory-reflector`, then `useOpenCodeLocal()` changed its selection scope when `defaultAgentName` hydrated to `kortix`. The picker reset to `kortix` for 30 seconds.                                                                                          | **DONE 2026-07-27** — PR #5533, merge `ee45f55fa`; SDK tests `1283/0`, typecheck, packed-install smoke, and deployed US two-test suite `2/2` pass; both sessions returned exact `PONG`, and the mismatch fallback emitted no global error                                                                                                                                    |
| B29 | **Preserve ACP upstream message boundaries in the projected transcript.**                                                                                                                                                                                                                                                                                                                                                                              | Dev session `ee41f742-9384-4f34-88e7-63ae3d765cae` emitted distinct `session/update.messageId` values for assistant steps, but `src/core/acp/projection.ts` discarded `messageId` and appended every text or reasoning chunk to one generated assistant message.                                                                                      | **DONE 2026-07-27** — implementation `60b06c6e4`; focused projection/controller tests `27/0`, full SDK tests `1299/0`, typecheck, packed-install smoke, supplied-transcript replay, and local ACP Chromium flow pass                                                                                                                                                                                          |
| B30 | **Expose message-based session rewind and restore through both REST and ACP transports.** Editing an earlier user message must rewind the same canonical session instead of creating a fork. The removed path must remain recoverable until the replacement prompt commits.                                                                                                                                                                      | `apps/web/src/features/session/session-chat.tsx` contains `TODO(session-rewind)`. OpenCode exposes `/session/{sessionID}/revert` and `/unrevert`; ACP has no standard rewind method and needs a Kortix bridge extension plus transcript reload.                                                               | **DONE 2026-07-27** — implementation `eab4eef0f`; PR #5619 merged as `9e90e8ed7`. Deploy Dev run `30293660760` deployed source `e548c6a8fc9ee1d5a92db66d6feb912d4442ebeb`, which contains the merge. Dev session `7feb4e84-072f-4b71-987f-dc25dd542890` kept canonical OpenCode session `ses_05b075d25ffe7PBkZ632pcVAlW` across ACP and REST rewind, restore, replacement commit, reconnect, and file rollback. ACP produced `DEPLOYED_ACP_REPLACEMENT`; REST produced `DEPLOYED_REST_REPLACEMENT`; cleanup removed `26/26` probe sessions and restored ACP runtime overrides. SDK tests `1309/0`, daemon tests `306/0`, web source contract `5/0`, local ACP Playwright `1/0`, and local real ACP plus REST smoke pass. Shippable to production: **YES** for protocol behavior. Deployed UI interaction remains unverified because Browser discovery returned `[]`. |
| B31 | **Allow a page-scoped ACP query override and settle completed ACP prompts that contain stale running tools.**                                                                                                                                                                                                                                                                                                                                     | `?acp` has no SDK transport override. Dev session `5322fa59-7a73-4fea-9f1a-9da59c2a0b5a` rendered the final assistant response while an older tool part remained `running`; `hasProjectionBlockers()` then kept the composer busy and blocked the queued prompt.                                                                 | **IMPLEMENTATION COMPLETE 2026-07-27** — implementation `d3544ae14`; focused SDK `40/0`, full SDK `1312/0`, typecheck, packed-install smoke, web routing `5/0`, and touched web ESLint pass. PR #5636, Deploy Dev, deployed SHA proof, and deployed ACP-only proof remain |
| B32 | **Synchronize generated Kortix session names from both ACP and OpenCode REST runtimes without navigation or refresh.**                                                                                                                                                                                                                                                                                                                           | ACP emits `session_info_update`; OpenCode `/global/event` emits a wrapped `session.updated`. Neither path reliably persisted `metadata.name`, and the sidebar query could stay stale after a completed prompt.                                                                                              | **IMPLEMENTATION COMPLETE 2026-07-28** — ACP and REST title events persist server-side; the SDK refetches list and detail queries through a bounded post-send loop; focused API `78/0`, full SDK `1318/0`, API and SDK typechecks, packed-install smoke, test-harness typecheck, and local ACP plus REST Chromium `1/0` pass. Full API has `3` pre-existing failures reproduced in the primary checkout. PR, Deploy Dev, deployed SHA proof, and deployed UI proof remain. |

> **Paths above are as of today (pre-Task-4).** After the restructure they move:
> `platform/api/` → `core/http/api/`, `opencode/` → `core/runtime/`,
> `platform/projects-client/` → `core/rest/projects-client/`. If a grep comes up
> empty, check whether Task 4 has landed before assuming the row is stale.

> **Adding a row?** Give it the next `B<n>`, cite **evidence** (a path, a grep, a
> command and its output), and set `OPEN`. Do not renumber existing rows.

---

## DISCOVERED THIS SESSION — append freely

Things found mid-task that you did **not** fix. Fixing them inside a claimed task
is scope creep; losing them is worse. Land them here, then tell the user.

| Date       | Session                  | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Where                                                                                                             |
| ---------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 2026-07-10 | `01AzJBSa`               | The original plan's "bump to `0.3.0`" is **impossible** — `version` is inert and `latest` on npm is `0.9.100`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `scripts/stage-npm-publish.mjs:32`                                                                                |
| 2026-07-10 | `01AzJBSa`               | `KortixProject` declared **twice**, as two different interfaces                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `core/rest/projects-client/projects.ts:31`, `core/runtime/kortix-master.ts:577`                                   |
| 2026-07-10 | `01AzJBSa`               | Bare `process.env` read in the isomorphic core → `ReferenceError` in a `<script>` bundle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `platform/platform-client/shared.ts:29` — fixed in Task 7                                                         |
| 2026-07-10 | `01AzJBSa`               | The tripwire walks **imports**; it cannot see globals (`process`/`window`/`document`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `src/index.isomorphic.test.ts` — fixed in Task 7                                                                  |
| 2026-07-10 | `01AzJBSa`               | Nothing installs and imports the tarball. `npm pack --dry-run` lists contents only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `.github/workflows/package-tests.yml` — Task 2                                                                    |
| 2026-07-10 | `ab099b6a`               | Plan's smoke script can't install: staged `workspace:*` dep pins `@kortix/llm-catalog@0.0.0-smoke`, absent from npm. Fixed per Jay: pack + install the sibling tarball alongside                                                                                                                                                                                                                                                                                                                                                                                                                      | `packages/sdk/scripts/smoke-install.mjs` — Task 2                                                                 |
| 2026-07-10 | `ab099b6a`               | **`createServerKortix` does not exist.** Plan (`:253,991`) and spec (`:158`) assert it from `./server`; real exports are `createScopedKortix`, `runWithKortix`, `getScopedConfig` (`src/server.ts`). Also affects Task 6's Lumen snippet                                                                                                                                                                                                                                                                                                                                                              | `docs/superpowers/{plans,specs}/2026-07-10-*` — Task 2/6                                                          |
| 2026-07-10 | `ab099b6a`               | Docs prose says 25 subpaths / 21 legacy; reality is 23 export keys / 20 legacy. Plan's enumerated key lists (Task 5 Step 9) match reality exactly                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `packages/sdk/package.json`                                                                                       |
| 2026-07-10 | `ab099b6a`               | Plan's `createCliToken` facade name is fictional; real facade method is `kortix.project(id).tokens.create(input?)` (→ `createProjectCliToken`). `gateway.sessions(days?)` was correct                                                                                                                                                                                                                                                                                                                                                                                                                 | `packages/sdk/src/core/client/kortix.ts:303` — found in Task 6                                                    |
| 2026-07-10 | `ab099b6a`               | Demo e2e harness memoizes builds on `.next/BUILD_ID` — e2e runs silently exercise STALE builds after source changes; must clear `.next` (or fix the harness) for trustworthy runs                                                                                                                                                                                                                                                                                                                                                                                                                     | `apps/whitelabel-demo/tests/e2e/harness.ts` (`ensureBuilt()`)                                                     |
| 2026-07-10 | `ab099b6a`               | Original preview-token malformed-200 guard was itself broken: `upstreamRes.status \|\| 502` returns 200 on that path, so the "error" response shipped as HTTP 200. Fixed by the Task 6 rewrite (now a real 502, e2e-covered)                                                                                                                                                                                                                                                                                                                                                                          | `apps/whitelabel-demo/src/app/api/preview-token/route.ts` (pre-`19e500e50`)                                       |
| 2026-07-10 | `ab099b6a`               | **CRITICAL (final review): the CDN claim is unfulfillable by the release pipeline.** Publish runs tsc only (`publish-npm-package.sh:36`; `prepublishOnly` tsc-only) so tsup bundles never land in the tarball; `stage-npm-publish.mjs:37` promotes only `type/main/types/exports/files/bin`, so `browser`/`unpkg`/`jsdelivr` stay nested in `publishConfig` where npm/unpkg/jsDelivr never look; nothing validates them at release. Plan flaw (plan `:1253-1278` said "pass through untouched"), faithfully implemented. Decision with Jay: wire the pipeline vs walk back the README/CHANGELOG claim | `scripts/{publish-npm-package.sh,stage-npm-publish.mjs}`, `packages/sdk/{README,CHANGELOG}.md`                    |
| 2026-07-10 | `ab099b6a`               | `bundle.test.ts` never executes in CI (no workflow runs `build:bundles` → both tests skip forever) and NO workflow runs `pnpm --filter @kortix/sdk typecheck` at all (examples' "typechecked in CI" claim is local-only). Two cheap CI steps close both                                                                                                                                                                                                                                                                                                                                               | `.github/workflows/package-tests.yml`                                                                             |
| 2026-07-10 | `4003a41b`               | GETTING-STARTED step 3 was un-followable: the web "API keys" tab's **Create button only rendered in the empty state**, and the executor auto-mints "Executor Session" tokens, so real accounts never see it — no way to mint a PAT from the UI. Fixed (uncommitted, this worktree): `CreateApiKeyAction` header button + regression test; doc wording updated ("CLI tokens tab" → "API keys")                                                                                                                                                                                                         | `apps/web/src/features/accounts/settings/cli-tokens-tab.tsx`, `packages/sdk/GETTING-STARTED.md`                   |
| 2026-07-10 | `4003a41b`               | **`ensureReady()` is single-shot** — one `/start` with `wait_ms=30_000`, then throws `RUNTIME_UNAVAILABLE`; a cold provision (observed: minutes) makes EVERY ensureReady example (02/04/06/07) fail — callers must hand-roll a retry loop (examples 09/step4 in this worktree do). Live-observed worse: the server returned near-instantly ~99× in 5min (long-poll not held), and one session went provisioning→stopped and then **disappeared from `projects.sessions()`**. SDK DX gap: `ensureReady({ deadlineMs })` or documented retry                                                            | `packages/sdk/src/core/client/kortix.ts:674` (verified live against local stack)                                  |
| 2026-07-10 | `4003a41b`               | Local-stack default-agent sends fail: gateway forwards opencode's `max_tokens` to a model demanding `max_completion_tokens` (OpenAI `unsupported_parameter`, HTTP 400) → default `send()` turns error with no assistant reply. Workaround verified live: per-send model override `{ providerID: 'kortix', modelID: 'claude-sonnet-4.6' }` → full e2e pass. Platform fix belongs in the gateway param translation or default model config                                                                                                                                                              | `/v1/llm-gateway/v1/llm/chat/completions` (via tunnel), `apps/api/src/router/routes/proxy/helpers.ts:252`         |
| 2026-07-11 | `4003a41b`               | `session.transcript()` on a session whose sandbox was re-provisioned returns `{available:false, reason:"…ZlibError fetching …/session/<old opencode id>/message…"}` — graceful, but the compact transcript is unreadable after a sandbox swap (stale opencode session id?). Observed live on the local stack                                                                                                                                                                                                                                                                                          | `packages/sdk/src/core/rest/projects-client/sessions.ts` (`getSessionTranscript`)                                 |
| 2026-07-11 | `4003a41b`               | `sandboxShares.list(sandboxId)` (`GET /p/share?sandbox_id=…`) returns **502** on the local stack for a live, ready sandbox — session `publicShares` create/list/revoke on the same sandbox works fine. SDK surfaces it correctly as typed ApiError; route itself looks broken/misrouted locally                                                                                                                                                                                                                                                                                                       | `packages/sdk/src/core/rest/projects-client/sandbox-shares.ts:33`                                                 |
| 2026-07-21 | `profile-owned-bindings` | The existing computer-connector integration's unknown-slug assertion depends on its arbitrary local project's Git manifest being readable. When GitHub returns 422, `getConnectorPoliciesFromManifest` returns `{ policies: [] }` before proving the slug exists, so the test reports **7 pass / 1 fail** instead of the earlier **8 / 0**. This branch does not touch that path.                                                                                                                                                                                                                     | `apps/api/src/executor/manifest-crud.ts:393`, `apps/api/src/__tests__/integration-computer-connector.test.ts:157` |

---

## Open decisions

| Question                                    | Owner | Status                                                                                                                                                              |
| ------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Second `KortixProject` name                 | Jay   | **RESOLVED** — platform keeps `KortixProject`; the kortix-master daemon's becomes `KortixMasterProject`, aliased                                                    |
| Rename `ApiError` → `KortixApiError`?       | Jay   | **RESOLVED — no.** Package name already namespaces the import; `.name` is duck-typed (B4); `instanceof` is the branch mechanism. Prefix only for genuine ambiguity. |
| "Shift the cortex tab to SDK" — what is it? | Jay   | **OPEN.** May re-order everything if it names work Marko is waiting on.                                                                                             |

---

## Standing facts (verified — don't re-derive)

- Baseline: **1046 tests pass, 0 fail, 65 files.** `typecheck` exits 0. Fewer tests
  in your run means you filtered by accident.
- `@kortix/sdk` is **live on npm**, `latest` = `0.9.100`. **Never edit `version`** —
  `scripts/stage-npm-publish.mjs:32` overwrites it from the root `VERSION`.
- `bun test <dir with no test files>` exits **0**. `Ran 0 tests` is not a green run.
- Streaming is `fetch` + `response.body.pipeThrough(TextDecoderStream)`, **not**
  `EventSource`. It **cannot run on React Native**.
- The 21 legacy subpaths are imported at **340 sites**. They get deprecated aliases, never deletion.co

---

## Session log

Append only. Newest at the bottom. One entry per session, even a short one.

### 2026-07-10 — session `01AzJBSa`

Brainstormed → spec → plan → execution prompt → this tracker. **No source code touched.**

**Written**

- `docs/superpowers/specs/2026-07-10-sdk-v2-structure-and-distribution-design.md`
- `docs/superpowers/plans/2026-07-10-sdk-v2-structure-and-distribution.md`
- `docs/superpowers/plans/2026-07-10-sdk-v2-execution-prompt.md`
- `packages/sdk/AGENTS.md` (+ `CLAUDE.md` symlink), root `AGENTS.md` pointer
- `packages/sdk/PROGRESS.md` (this file)

**Found** — see _Discovered this session_. The load-bearing ones: `0.3.0` was
impossible; `KortixProject` was declared twice; nothing tests an install; the
tripwire can't see globals; the SDK can't stream on RN and `apps/mobile` quietly
works around it with 655 parallel lines.

**Verified**

```
pnpm --filter @kortix/sdk typecheck  → exit 0
pnpm --filter @kortix/sdk test       → 1046 pass, 0 fail, 4381 assertions, 65 files
npm view @kortix/sdk version         → 0.9.100
```

**Unverified:** nothing — no source changed.

**Shippable to production: YES** (docs only).
**Next:** Task 1.

### 2026-07-10 — session `ab099b6a`

Executing the v2 chain via subagent-driven development. Docs committed
(`6cd4d6e4e`); baseline re-verified (typecheck exit 0; 1046 pass / 0 fail / 65
files).

**Task 1 DONE** (`ecb78a113`) — `src/package-exports.test.ts`, probe-verified
RED then green. Suite now **1048 pass / 66 files**. Review clean, one
plan-mandated finding for Jay: the plan's test code contains a tautological
assertion (`package-exports.test.ts:30`) that asserts nothing.

**Task 2 BLOCKED at the kickoff's hard stop #1** — the smoke script's
first-ever run failed in Step 2:

```
npm error notarget No matching version found for @kortix/llm-catalog@0.0.0-smoke
```

Root cause: `stage-npm-publish.mjs` rewrites `workspace:*` deps to the lockstep
version. Under `VERSION=0.0.0-smoke` the tarball depends on
`@kortix/llm-catalog@0.0.0-smoke`, which is not on npm, so `npm install
<tarball>` cannot resolve. This is the plan's known risk #2 realised — a design
gap in the smoke script (AGENTS.md documents the pinning behaviour), not a bug
in the published artifact. Real releases co-publish both packages, so prod
installs are unaffected. Also found: the script leaks the packed `.tgz` on
failure (cleanup sits outside `finally`). Fix decision is Jay's; the verbatim
script sits uncommitted at `packages/sdk/scripts/smoke-install.mjs`.

**Also found** — docs prose says 25 subpaths / 21 legacy; reality is 23 export
keys / 20 legacy. The plan's enumerated key lists (Task 5 Step 9) match reality
exactly, so the plan's literal instructions are unaffected.

**Task 2 resumed and BLOCKED a second time.** Jay approved packing the
workspace sibling (`@kortix/llm-catalog` staged at the same synthetic version,
both tarballs installed together — hermetic, mirrors the lockstep release);
that fix works and the ETARGET failure is gone. The smoke then failed at the
final ESM import with a NEW finding:

```
SyntaxError: The requested module '@kortix/sdk/server' does not provide an
export named 'createServerKortix'
```

`createServerKortix` exists nowhere in the SDK — it is a plan/spec authoring
error (plan `:253,991`; spec `:158`). The real `./server` exports are
`createScopedKortix` (`src/server.ts:123`), `runWithKortix`, `getScopedConfig`.
Task 6's Lumen snippet uses the same phantom name. Decision with Jay: assert
the real name and correct the docs, or add `createServerKortix` as new API.
Tautology in `package-exports.test.ts` removed per Jay (`4e39bb11e`).

**Continuation of session `ab099b6a` — the full chain.** Jay resolved both
Task 2 stops (pack the `@kortix/llm-catalog` sibling into the smoke install;
assert the real `createScopedKortix`, docs corrected in `2a7a3e56c`). From
there the chain ran task-by-task with a fresh implementer + independent
reviewer per task, fixes re-reviewed:

- **Task 2 DONE** `7220e9587` — first-ever pack→install→import, hermetic
  (both tarballs), wired into CI.
- **Task 3 DONE** `84e15ca72` — snapshot (23 subpaths / 833 runtime names)
  approved by Jay at hard stop #2. Suite 1049/67.
- **Task 4 DONE** `25068d272..4c6f7102c` (4 commits) — 146 files moved into
  core/browser/node + turns split; snapshot byte-identical; tier tripwire
  armed. Fixed a real pre-existing order-dependent `mock.module` isolation
  bug by rewriting `core/files/client.test.ts` mocking (zero `expect()` lines
  changed — verified twice). Suite 1050/67.
- **Task 5 DONE** `b5e588dbc`+`aafbdf91b` (orchestrator-implemented) —
  `KortixMasterProject` rename with aliases; canonical root barrel (26→518
  root names); 20 deprecated shims + 5 ./internal/*; both maps rewritten to
  28 keys; snapshot growth (+523/-0) accepted by Jay at hard stop #3. Suite
  1058/68; hosts compile untouched.
- **Task 6 DONE** `db30c6df3`+`19e500e50` — demo on root entry;
  `createScopedKortix` replaces raw transport (real names: `tokens.create`,
  `gateway.sessions`); fix restored the malformed-200 guard as a true 502
  with a RED-watched e2e (44/3/0 on a fresh build).
- **Task 7 DONE** `189428df7`+`a485ad401` — bare-globals tripwire (guard
  window per-global, comment-safe after probe-RED fix); `safeEnv` →
  `core/http/env.ts`; `shared.ts:29` fixed. Suite 1059/68.
- **Task 8 DONE** `c7bca7a7e` — tsup bundles (`kortix.esm.min.js`,
  `kortix.global.js` IIFE via `outExtension` — tsup would otherwise emit
  `.global.global.js`); zero `node:` specifiers in either bundle. Built
  suite 1061/69.
- **Task 9 steps 1–5 DONE** `549d597a0` — `07-vanilla.ts` (render loop
  corrected to the real API per examples/04), `08-cdn.html`, examples
  tripwire (+B6: the regex is blind to side-effect imports). Suite 1062/69
  built. **Step 6 (browser + live stack, D2a/D3) awaits Jay — hard stop #4.**
- **Task 10 DONE** `6e9cc9f5a` — README/CHANGELOG/API-MAP; count corrected
  to 20; `createScopedKortix` documented; RN-streaming not claimed.

**Final whole-branch review: "With fixes."** Purely-additive surface
re-verified independently. One CRITICAL: the README/CHANGELOG CDN claim is
unfulfillable by the release pipeline (see Discovered table) — wire it or
walk it back before merge. Important: bundle tests never run in CI;
no CI job runs the SDK typecheck. Minors triaged as follow-ups.

**Verified this session (final state):** typecheck exit 0; unbuilt suite
1060 pass / 2 skip / 69 files; built suite 1062 pass / 0 fail / 69 files;
`smoke:install` ✔; whitelabel-demo typecheck 0 + e2e 44/3/0; apps/web zero
SDK resolution errors.

**Unverified:** D2a/D3 (browser streaming + `instanceof` under the IIFE) —
Task 9 Step 6, needs Jay's live stack; the release pipeline path for the
bundles (the CRITICAL above); CI runs of the new workflow steps on Actions.

**Shippable to production: NOT YET** — pending Jay: CDN-claim decision,
README domain decision (`api.kortix.ai` vs `.com`), CI-gate fixes, and the
Task 9 Step 6 browser gate.

**Fix wave (same session, after Jay's decisions).** Jay chose: wire the CDN
pipeline, `api.kortix.com`, both CI gates now.

- `33f45e6f8` — `stage-npm-publish.mjs` promotes `browser`/`unpkg`/`jsdelivr`
  if present and hard-fails (`process.exit(1)`) when a promoted path is
  missing from the build (TDD in `stage-npm-publish.test.mjs`, RED watched,
  24/24). The load-bearing build fix went into `publish-npm-package.sh`
  (staging runs BEFORE `npm publish`, so `prepublishOnly` alone fires too
  late); `prepublishOnly && tsup` kept as defense-in-depth; the two other
  staging call sites (`smoke-install.mjs`, CI dry-pack loop) also build
  bundles — required, or the new validation would redline them. Tarball
  simulation: both bundles in the tarball, top-level CDN fields staged,
  manifests restored byte-identical. Siblings (llm-catalog, executor-sdk)
  provably unaffected (promote-if-present; pinned by test).
- `695908713` — README standardized on `api.kortix.com` (Jay's call).
- `e48a48489` — `package-tests.yml`: SDK typecheck step + `build:bundles`
  before the test run, so `bundle.test.ts` executes in CI (1062/0/69).

**Final re-review: "Ready to merge — Yes."** All findings closed by the named
mechanisms; the two call-site fixes judged required, not scope creep. Minor
follow-ups noted: triple bundle build in one CI job (~1 min redundant,
idempotent); redundant rebuild via prepublishOnly inside the scripted release.

**Remaining before the branch is DONE-done: Task 9 Step 6 only** (Jay: real
browser + live stack + real PAT/sandbox → D2a streaming through the IIFE
global, D3 `instanceof Kortix.ApiError` under the bundle).

**Shippable to production: NOT YET** — solely on the unverified D2a/D3
browser gate. Everything else is implemented, reviewed, and green.

### 2026-07-11 — session `b35eea56`

Jay-directed addition, outside the Now chain: `examples/step5-change-model.ts`
— change a project's default model with a compile-time-safe `ManagedModelId`
literal union (pinned in-file, startup-verified against `MANAGED_MODELS` from
`@kortix/llm-catalog` — first example to import the catalog; resolves fine
under `examples/tsconfig.json`). Defaults to Jay's project
`4cfe8027-5260-44d7-871b-ccd36368f63f`. Verified: typecheck exit 0 (bad model
id probe-confirmed RED → TS2345, then restored green); full flow ran live
against localhost:8008 (set → re-read ✓), then the project's prior default
(`openai/gpt-5.5`) was restored. Suite 1062 pass / 0 fail / 69 files. Note:
bun auto-loads `packages/sdk/.env.local` (holds `KORTIX_API_KEY`) — that is
how examples authenticate when run from the package dir.

---

### 2026-07-12 — Production-readiness review (Jay-requested, pre-merge): Task 9 Step 6 EXECUTED (PASS) + fix wave F1–F7

Fresh end-to-end review of the whole branch (41 commits vs `main`, base
`808fadfc8`): two-axis sub-agent review (standards + spec) over the full diff,
17-point distribution/CI fact-check (17/17 VERIFIED), all gates re-run, and the
**Task 9 Step 6 browser gate finally executed against a live stack**. Full report:
`docs/superpowers/reviews/2026-07-12-sdk-production-readiness.md`.

**D2a — PASS.** `examples/08-cdn.html` served from `:8099`, loaded in real
Chromium (Playwright) via `<script src=…kortix.global.js>` against `pnpm dev` +
fresh session `4f2953bc…` (project t1, real PAT, real sandbox). Page output:
`sent — streaming…` then `· message.part.updated` ×7 through `· session.idle`.
**D3 — PASS.** A bundle-thrown `ApiError` (`kortix.ts:681`) satisfied
`error instanceof Kortix.ApiError` in page script (branch printed
`ApiError undefined: Session runtime not ready`); a bad-PAT run threw
`SessionStartError` and correctly took the non-ApiError branch (extends `Error`
by design). **Discovery:** first attempt was CORS-blocked — the API allowlist
(`apps/api/src/index.ts:151-202`) has no `:8099`; local repro needs
`CORS_ALLOWED_ORIGINS=http://localhost:8099`. The CDN story only works from
allowlisted origins → product decision for Jay (in the report), docs now say so.

**Fix wave (UNCOMMITTED in working tree, reviewed "Approved" / spec ✅ ×7):**
F1 smoke-install finally-block made throw-safe (AggregateError, restore-first);
F2 stale JSDoc path fixed; F3+F7 side-effect-import blindness fixed everywhere
(shared `importSpecifiers`, RED-proven) — **closes B6**; F4 AGENTS.md stale
claims fixed (export-map + install-smoke guards now exist; baseline 1069/71);
F5 **new `public-type-surface.test.ts` + snapshot** (TS compiler API) — type-only
exports (`SessionHandle`, `ClassifiedPart`, …) are now rename-guarded, closing
the runtime snapshot's type blindness; F6 CORS constraint documented
(README + 08-cdn.html). Details + RED evidence: `.superpowers/sdd/fix-wave-2-report.md`.

**Verified:** typecheck exit 0 · full suite **1069 pass / 0 fail / 71 files**
(reproduced independently by implementer AND reviewer) · smoke:install OK ·
build:bundles OK (esm 189.90 KB, iife 190.88 KB).
**Unverified:** npm Trusted Publishing wiring for the `@kortix` org
(publish-npm-package.sh skips silently without OIDC/token — one-time infra
check, outside the repo); Safari/Workers legs of the runtime matrix.

**Shippable to production: YES** — supersedes the 2026-07-11 "NOT YET"
(its sole blocker, D2a/D3, is now observed passing). Remaining for Jay:
commit/merge decision (fix wave is uncommitted by request), CDN CORS policy,
Trusted Publishing check.

---

### 2026-07-12 — session `gateway-fallbacks`: B7 provider-qualified default lock

The platform gateway default is now `codex/gpt-5.6-sol`, but it remains a
Kortix gateway wire model in the picker: `{ providerID: 'kortix', modelID:
'codex/gpt-5.6-sol' }`. This deliberately does not expose or classify it as a
native OpenCode `codex` provider. Implementation: `ee7d2cc09`.

**TDD/regression evidence:** the focused picker regression is green (14 pass,
0 fail). Final full SDK suite: **1076 pass / 0 fail / 72 files** and **4958
expect() calls**. `pnpm --filter @kortix/sdk typecheck` exited 0, and
`pnpm --filter @kortix/sdk smoke:install` packed, installed, imported, and
constructed the published package successfully.

**Cross-package evidence:** gateway **144 pass / 0 fail**; catalog **25 pass /
0 fail**; focused API resolution/catalog/entitlement suite **45 pass / 0
fail**; standalone gateway server **13 pass / 0 fail**. Typechecks exited 0
for gateway, catalog, SDK, API, and standalone gateway. `git diff --check`
was clean.

**Real local E2E:** through `POST http://localhost:20908/v1/llm-gateway/v1/chat/completions`,
streaming `auto` selected `openai-codex` / `gpt-5.6-sol` and returned the exact
marker `AUTO_DEFAULT_CODEX_56_SOL_OK`; forced Codex 401 selected OpenRouter /
`z-ai/glm-5.2-20260616`, returned `CODEX_STREAM_401_TO_GLM_OK`, completed with
`[DONE]`, and persisted routing metadata selecting `glm-5.2`. Non-streaming
Codex primary and forced-401 fallback also returned exact markers. Temporary
gateway credentials were revoked and the Codex-secret mutation was restored.

**Shippable to production: YES** — SDK public behavior is regression-locked;
the wider gateway change still follows its normal PR, deploy-dev, and live-dev
verification lifecycle.

---

### 2026-07-13 — session `session-base-branches` (claim)

Claimed the user-directed additive branch-environment work: preserve the existing
per-session `base_ref` API, expose effective project/group branch defaults through
the typed project Git surface, and extend group-grant mutations without renaming or
removing public SDK symbols. TDD will be RED-watched before implementation; the
full SDK typecheck, test, and packed-install smoke gates are required before this
claim is closed.

**Status:** COMPLETE.

### 2026-07-25 — session `session-history-pagination` (completion)

Fixed complete-turn history pagination and stable scroll restoration.

The controller now follows assistant-only pages until it loads each referenced
parent user message. It hydrates the collected pages once in chronological
order. Tail reconciliation no longer resets a cursor after older-history
pagination starts. Repeated cursors stop with an explicit error.

The web host now captures the first visible `[data-turn-id]` element before the
request. It restores that element to the same viewport offset after React
commits. It no longer applies total `scrollHeight` growth.

**RED evidence:**

- The complete-turn test expected requests through `cursor-3`. The controller
  stopped after `cursor-1`.
- The cursor-invariant test expected the next request to use `cursor-2`. Tail
  reconciliation reset the cursor to `cursor-1`.
- The scroll tests failed because `session-history-scroll.ts` did not exist.

**Verification:**

- Focused SDK and web tests: **15 pass / 0 fail / 33 assertions**.
- SDK typecheck: exit 0.
- SDK suite: **1210 pass / 2 skip / 0 fail** across 98 files and 5461
  assertions.
- SDK packed-install smoke: pass.
- Focused ESLint: 0 errors. One pre-existing
  `react-hooks/exhaustive-deps` warning remains at `session-chat.tsx:3635`.
- Changed-file web TypeScript output: empty.
- Web suite: **2054 pass / 2 unrelated baseline failures**. Both failures expect
  the retired `deepseek-v4-pro` model in `src/lib/model-pricing.test.ts`.
- Browser discovery returned no available browser. Local DOM and network
  verification remains open.

**Shippable to production: NOT YET.** Repository delivery, Deploy Dev, and
deployed browser verification remain open.

---

### 2026-07-23 — session `session-sync-latency` (local completion)

Completed bounded session synchronization and persistent project navigation in
`session-sync-latency`. Initial and background history reads request 10 messages.
Older history uses cursor pagination. One active session owns the SSE stream.
Inactive running sessions receive one bounded tail prefetch. The 20-entry
controller registry owns and evicts prefetch state.

The shared project layout now owns `ProjectShell`. Session navigation keeps the
committed route visible until the target renders. The current session remains
selected during a pending switch. File selections, Customize state, onboarding,
and the presentation dialog persist across project routes. Session file stores
are bounded to 20 entries.

Connector reads no longer synchronize or write. The list path loads actions,
credential state, and channel state in parallel. Shared credential discovery is
one batched query. Explicit synchronization materializes connector icons.

The final maintainability review deleted the background SSE fan-out, removed
passive project-home reads, moved prefetch state into the bounded registry, and
removed a second mobile transcript compatibility cast. `formatTranscript`
accepts a narrow structural input while the exported `MessageWithParts` contract
remains unchanged. No changed file crosses from below 1,000 lines to above 1,000
lines.

**TDD evidence:** the new mobile transcript-shape test first failed SDK
typecheck with `TS2322`. The focused GREEN run reported **9 pass / 0 fail** with
16 assertions. The mobile older-page hydration test first returned only the
older page. Its GREEN run reported **1 pass / 0 fail**.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0. The full
suite reported **1171 pass / 0 fail** with 5170 assertions across 88 files.
`pnpm --filter @kortix/sdk run smoke:install` built, packed, installed, imported,
and constructed the package successfully.

**Other local gates:** API typecheck exited 0. Focused API tests reported **38
pass / 0 fail**. Focused web tests reported **22 pass / 0 fail**. The focused
mobile test reported **1 pass / 0 fail**. Changed-file web ESLint reported 0
errors and one pre-existing hook warning. Terraform formatting and validation
passed. Mobile typecheck still reports 56 baseline errors; none reference the
changed mobile files.

**Runtime evidence:** the authenticated connector list returned `200` twice in
10 ms and 5 ms. Legacy and default-profile credentials both returned
`secretSet: true`. Connector, action, and credential row counts did not change.
The real cloud session smoke reported **21 pass / 0 fail**. Project provisioning
took 4 seconds. The sandbox reached `ready` 18 seconds after session creation.
OpenCode and `kortix.yaml` returned `200`. Cleanup returned `200`.

**Infrastructure evidence:** `dev-api.kortix.com` returns
`x-backend: ecs-fargate`. ECS runs three tasks at its current three-task ceiling.
The 24-hour target-response maximum was 47.132 seconds. The API logged 1,904
target `5xx` responses. Stale background `/global/event` requests retried missing
sandboxes four times and consumed about 7 seconds each. This branch deletes that
fan-out and raises the ECS fallback maximum from 3 to 6.

**Unverified:** the browser runtime returned an empty browser list. Required DOM
and network assertions for persistent navigation, cached rendering, bounded
prefetch, cursor pagination, transcript export, and dialog persistence could not
run. The shared local migration ledger also has one pending concurrent migration
that precedes an applied migration. The shared ledger was not mutated.

**Shippable to production: NOT YET.** Browser DOM and network verification
remains required.

---

### 2026-07-19 — session `git-management-ux` (completion)

Completed the additive GitHub repository-template input. The public
`CreateProjectRepoInput` contract now accepts `source_item_id`, allowing the web
project creator to seed a selected `registry:project` item into a newly created
GitHub App repository. No exported name or existing field was removed or
renamed.

**TDD evidence:** the focused project-client test failed before
`source_item_id` existed on `CreateProjectRepoInput`; after implementation the
focused project-client suite passed, including the new marketplace-template
contract assertion.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full SDK
suite reported **1141 pass / 0 fail** across 86 files with 5054 assertions; and
`pnpm --filter @kortix/sdk run smoke:install` built, packed, installed, imported,
and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** for the SDK surface. Repository merge, Deploy
Dev, and live-dev verification remain part of the parent feature lifecycle.

---

### 2026-07-18 — session `connectors-discover-flag` (completion)

Completed the additive Discover integration-catalog SDK restoration as a separate,
per-project experimental connector marketplace. Existing Easy Connect remains intact
and default; `connectors_api_discover` is available but off by default. Pipedream
appears only as separately labelled OAuth alternatives. Runtime and type snapshots
contain additions only; no current export was removed or renamed.

**TDD and live evidence:** the focused contract/UI run passed **46 / 0** and the
focused API/catalog/router run passed **56 / 0**. An authenticated local project
round-tripped the flag false -> true -> false, queried live HubSpot catalogue and
surface endpoints, and resolved MCP, CLI, REST, and official Postman variants with
source-derived bearer auth. The official HubSpot Postman repository materialized as
an active connector with **1,223 actions**, `authSecret: credential`, and no stored
credential; live Pipedream HubSpot search returned OAuth records only. ke2e coverage
passed at **409 / 497 routes**.

**Final SDK gates after rebasing onto current `origin/main`:** typecheck exited 0;
the full SDK suite reported **1128 pass / 0 fail** across 84 files with 5029
assertions; and the packed install smoke built, packed, installed, imported, and
constructed `@kortix/sdk` successfully.

**Shippable to production: YES** for the SDK surface. Repository PR, Deploy Dev,
and live-dev verification remain part of the parent feature lifecycle.

---

### 2026-07-13 — session `session-base-branches` (completion)

Completed the additive session branch-environment surface in implementation
commit `0843d870c`: `ProjectBranchesResponse` now reports the caller's effective
session default and group-conflict metadata, while project group grants accept
an optional nullable `default_base_ref`. Existing names and required fields are
unchanged; compatibility with older servers is preserved through optional
response fields.

**TDD/regression evidence:** the focused cross-package run passed **103 tests / 0
failures** across the SDK access client, API branch resolver, DB schema, and web
session-create input. The real isolated API then proved: attached group default
`staging` -> persisted session `base_ref: staging`; explicit `dev` -> persisted
`base_ref: dev`; conflicting `dev`/`staging` group defaults -> project `dev` with
`session_default_conflict: true`; PATCH `default_base_ref: null` -> effective
default returned to `staging`. Both sessions retained their generated UUID as
`branch_name`.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0;
`pnpm --filter @kortix/sdk test` reported **1077 pass / 2 skip / 0 fail** across
72 files with 4955 assertions; `pnpm --filter @kortix/sdk run smoke:install`
packed, installed, imported, and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** for the SDK surface. The two skipped tests are
the existing browser-bundle tests that only execute after `build:bundles`; this
change does not touch bundles or runtime transport.

---

### 2026-07-13 — session `remove-freestyle`: B8 project-app surface removal

Completed the explicitly subtractive SDK portion in implementation commit
`ec8b44dda`: removed the project-app REST module, `project(id).apps` facade,
associated public types, playground example, API map/docs references, and the
corresponding runtime/type public-surface snapshot entries. No compatibility
alias remains because the underlying platform capability itself was removed.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0;
`pnpm --filter @kortix/sdk test` reported **1079 pass / 0 fail** across 72 files
with 4921 assertions; `pnpm --filter @kortix/sdk run smoke:install` built,
packed, installed, imported, and constructed the published package successfully.

**Shippable to production: YES** for the SDK subtraction. Repository delivery,
deployment, and the separate forward database-schema removal remain tracked by
the parent removal goal.

---

### 2026-07-13 — session `remove-app-deploy-residue`: B8 documentation follow-up

Removed stale affirmative references to the retired project-app deployment
surface from the SDK README and API map as part of the repository-wide starter
and documentation cleanup. No SDK source, export, type, or runtime behavior
changed; the B8 removal record remains as the audit trail.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0;
`pnpm --filter @kortix/sdk test` reported **1079 pass / 0 fail** across 72 files
with 4921 assertions after bundle generation; `pnpm --filter @kortix/sdk run
smoke:install` built, packed, installed, imported, and constructed the published
package successfully.

**Shippable to production: YES** — documentation-only SDK follow-up with the
full published-package gates green.

---

### 2026-07-13 — session `gateway-routing-ui` (claim)

Claimed the user-directed additive project LLM routing-policy surface: persisted
default and vision models, an ordered default fallback chain, exact-model
overrides, bounded `transient` / `any-error` conditions, and a route-preview
contract exposed through `@kortix/sdk` for the Customize UI. Existing model
default names and behavior remain unchanged. SDK work will follow RED → GREEN →
REFACTOR and finish on the full typecheck, test, and packed-install smoke gates.

**Status:** IN PROGRESS.

---

### 2026-07-28 — session `acp-session-name-sync` (B32 implementation)

ACP `session_info_update` and OpenCode REST `session.updated` events now persist
the generated root-session title in `project_sessions.metadata.name`.

The REST parser handles the real `/global/event` envelope:
`{ directory, payload: { type, properties } }`.

`useSession` refetches the active Kortix session list and detail queries after
runtime title events. It also runs a bounded refresh after each send.

Verification:

- Focused API: **78 pass / 0 fail / 178 assertions**.
- API typecheck: exit `0`.
- SDK typecheck: exit `0`.
- Full SDK: **1318 pass / 0 fail / 5797 assertions / 111 files**.
- SDK packed-install smoke: passed.
- Test-harness typecheck: exit `0`.
- Local ACP and REST Chromium: **1 pass / 0 fail**.
- Full API: **3 pre-existing failures**. The same failures reproduce in the
  primary checkout in `maintenance.test.ts` and
  `unit-hosted-deployment-vendor-removal.test.ts`.

**Status:** IMPLEMENTATION COMPLETE.

**Shippable to production: NOT YET.** PR merge, Deploy Dev, deployed SHA proof,
and deployed ACP plus REST UI verification remain.

---

### 2026-07-26 — session `warm-project-session` (B22 completion)

Added one server-owned available warm session per project and user. A partial
unique PostgreSQL index resolves concurrent ensure races. The SDK exposes
`ensureWarmProjectSession`, `claimWarmProjectSession`,
`project.sessions.ensureWarm()`, and `project.sessions.claimWarm()`.

The project index ensures the warm session on mount and starts its runtime.
Send claims that session atomically before navigation. A claimed, stopped, or
configuration-mismatched session cannot become the next warm session.

Reused active workspaces resolve the latest base SHA on the API. The sandbox
daemon returns immediately when the workspace already matches that SHA. It
fetches and checks out the exact SHA only when the workspace differs. OpenCode
does not restart. No agent message performs Git synchronization.

Available warm sessions bypass idle maintenance. Claimed sessions return to the
normal idle policy.

TDD evidence:

- Workspace refresh RED: the API did not resolve or send `base_sha`.
- Daemon RED: an unchanged workspace performed a Git fetch and returned `500`
  against a missing remote.
- Exact-SHA RED: the daemon checked out remote `v3` instead of requested `v2`.
- Stopped-session RED: the coordinator reused a stopped warm session.
- Maintenance RED: an available warm session entered idle-stop handling.

SDK gates:

- `pnpm --filter @kortix/sdk typecheck`: exit 0.
- `pnpm --filter @kortix/sdk test`: **1263 pass / 0 fail**, **5644**
  assertions.
- `pnpm --filter @kortix/sdk run smoke:install`: packed install and Node ESM
  import passed.

Additional local gates:

- Database: **121 pass / 0 fail**.
- API contract: **43 pass / 0 fail**.
- Warm coordinator and workspace tests: **9 pass / 0 fail**.
- Sandbox reaper: **43 pass / 0 fail**.
- Sandbox daemon: **297 pass / 0 fail**.
- Web helper: **3 pass / 0 fail**.
- API typecheck, daemon build, migration lint, changed web ESLint, and
  `git diff --check`: exit 0.
- ke2e coverage: **490/503 routes**, **13 allowlisted**, **0 uncovered**.

Real local proof used disposable project
`4f9f6c04-9101-424b-aaaa-2e850b18ef12`:

- Concurrent ensure calls returned one session. The database contained one
  available warm row.
- Reused workspace refresh changed
  `f309cbda70b97a124585ba0e6d12a0b6b2c8be9f` to
  `92b337bb3641598de4dec4e251f6087ba3609a18` in **2579 ms**.
- The next refresh returned `unchanged` in **801 ms**.
- A real maintenance pass returned `candidates=1`, `stopped=0`, and
  `skipped=1` for an available warm session.
- Session `5c83a894-d330-45c7-bc7e-a77c0c175881` reached runtime readiness.
- Claim completed in **14 ms**.
- Replacement session `444ca1db-97b9-4f16-bf0b-1eb96b2330a9` was different.
- The replacement reached runtime readiness in **22481 ms**.

The browser runtime returned `agent.browsers.list() = []`. Local DOM and network
assertions remain unavailable. Web typecheck reports only three unrelated
baseline errors in `template-url.test.ts` and `project-create-modal.tsx`.

The full API suite retains an existing `mock.module` isolation defect when
`sandbox-reaper.test.ts` shares a process with sibling files. Each changed API
test file passes in an isolated process. API typecheck passes.

**Shippable to production: YES.** The SDK surface is additive. The package,
database, API, daemon, web helper, live lifecycle, and maintenance retention
contracts pass. Browser verification remains a deployment item.

---

### 2026-07-25 — session `false-load-older` (local completion)

OpenCode paginates raw messages in groups of 10. The reported dev session has
one user message and 43 assistant messages in one logical turn. The initial page
contained 10 assistant messages and an `x-next-cursor` header. The user message
was on page 5.

The controller now follows assistant-only pages during the initial load until
every assistant parent user message is present. It hydrates the complete newest
turn once in chronological order. It exposes `hasOlder` only when the completed
turn has an earlier cursor.

Implementation commit: `b759cca6bad8548b54ec3ab80d105f162a1f497d`.

**RED evidence:**

- The focused controller suite reported **13 pass / 1 fail**.
- The new test expected three page requests. The controller made one request.

**Verification:**

- Focused controller suite: **14 pass / 0 fail** with 32 assertions.
- SDK typecheck and example typecheck: exit 0.
- SDK full suite: **1249 pass / 2 skip / 0 fail** across 104 files with 5589
  assertions.
- SDK packed-install smoke: pass.
- Exact dev-session probe: 5 HTTP `200` page requests, 44 hydrated messages,
  1 user message, 43 assistant messages, and `hasOlder: false`.
- `git diff --check`: exit 0.

The browser runtime returned `No browser is available` and `[]`. Local and
deployed DOM proof remains open.

**Status:** IMPLEMENTATION COMPLETE.

**Shippable to production: NOT YET.** PR merge, Deploy Dev, and deployed proof
remain.

### 2026-07-13 — session `gateway-routing-ui` (completion)

Completed the additive project LLM routing-policy SDK surface: typed whole-document
CRUD and route preview functions, `project(id).gateway.routing.{get,set,reset,preview}`,
and `useGatewayRoutingPolicy` with project-scoped caching/invalidation. Runtime and
type public-surface snapshots contain additions only; no existing SDK name or contract
was removed or renamed.

**Focused evidence:** routing transport/facade/hook tests passed **65 / 0** together
with the existing facade suite. The isolated black-box `GW-4` flow passed **1 / 0**
against the real API and a provisioned project, covering persisted save/read-back,
default and exact route preview, invalid-policy preservation, access boundaries, and
reset.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0;
`pnpm --filter @kortix/sdk test` reported **1083 pass / 0 fail** across 74 files with
4936 assertions; `pnpm --filter @kortix/sdk run smoke:install` built, packed,
installed, imported, and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** for the SDK surface. Repository merge, Deploy Dev,
and live-dev verification remain part of the parent feature lifecycle.

---

### 2026-07-13 — session `e2b-provider`: B9 unified E2B provider contract

Completed the provider contract in `5763b63e4`: E2B is selectable and observable
through the published SDK alongside Daytona and Platinum. Retired standalone
instance exports remain import-compatible as deprecated fail-closed stubs, while
the supported sandbox-provider union is exactly `daytona | platinum | e2b`.

**TDD/regression evidence:** focused E2B and retired-provider type/runtime tests
passed before the final suite. Final SDK gates: `pnpm --filter @kortix/sdk
typecheck` exited 0; `pnpm --filter @kortix/sdk test` reported **1083 pass / 0
fail** across 74 files with 4985 assertions; `pnpm --filter @kortix/sdk run
smoke:install` packed, installed, imported, and constructed `@kortix/sdk`
successfully.

**Shippable to production: YES** for the SDK surface.

---

### 2026-07-13 — session `personal-session-branch` (claim)

Claimed the user-directed personal session-branch preference work. This adds an
additive SDK/API contract for a project-scoped current-user default and makes
session base-ref resolution honor it before group and project defaults. No
existing public names or required fields will be changed. SDK work will follow
RED -> GREEN -> REFACTOR and finish with typecheck, full suite, and packed-install
smoke evidence.

**Status:** IN PROGRESS.

---

### 2026-07-28 — session `acp-multi-harness` claim

Claimed project-gated ACP multi-harness support.

The existing `acp_runtime` project experiment will become the single rollout
gate for ACP transport and Claude Code, Codex, OpenCode, and Pi harness
selection.

The implementation will port the behavioral contract from PR #4510 onto the
current session-scoped SDK architecture. It will not restore PR #4510's removed
SDK refactor or host-local runtime logic.

Implementation will follow RED -> GREEN -> REFACTOR.
Required gates are focused API, SDK, daemon, manifest, and web tests, API and
SDK typechecks, the full SDK suite, packed-install smoke, local browser proof,
real multi-harness sandbox proof, PR merge, Deploy Dev, deployed SHA proof, and
deployed browser plus protocol verification.

**Status:** IN PROGRESS.

---

### 2026-07-13 — session `personal-session-branch` (abandoned)

Abandoned the personal/group session-branch preference claim by explicit product
decision. Branch choice belongs to an ordinary isolated Kortix project: users may
connect the same Git repository more than once, choose an existing branch during
project creation, and keep each project's secrets, access, sessions, triggers,
deployments, and runtime settings independent. The advanced per-session `base_ref`
API remains compatible, but no preference hierarchy or environment entity will be
added.

**Status:** WON'T DO (superseded by independent same-repository projects).

---

### 2026-07-13 — session `personal-session-branch` (replacement completion)

Completed the replacement project-as-environment SDK surface. GitHub imports can
now discover existing repository branches through the typed
`kortix.github.listRepositoryBranches(accountId, installationId, repoFullName)`
facade. A Kortix project owns one selected repository branch as its canonical
`default_branch`; no personal/group preference hierarchy remains in the SDK.
Existing per-session `base_ref` support remains backward compatible.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0;
`pnpm --filter @kortix/sdk test` reported **1085 pass / 0 fail** across 77 files
with 4960 assertions; `pnpm --filter @kortix/sdk smoke:install` built, packed,
installed, imported, and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** — the public addition is typed, additive,
snapshot-locked, and verified from the packed package.

---

### 2026-07-13 — session `gateway-routing-ux` (claim)

Claimed the user-directed LLM Gateway routing UX simplification. The SDK scope is
an additive compact project model-picker REST surface so chat and settings model
selectors no longer download the full 5,262-model runtime catalog. The existing
`llm-catalog`, model-default, and routing-policy APIs remain backward compatible.
Implementation will follow RED -> GREEN -> REFACTOR and finish with the full SDK
typecheck, test, and packed-install smoke gates.

**Status:** IN PROGRESS.

### 2026-07-13 — session `gateway-routing-ux` (completion)

Completed the additive compact project model-picker SDK surface. The project
transport and `createKortix().project(id).models.picker()` facade now load the
connection-aware picker projection rather than the full runtime catalog, while
the existing `llm-catalog` API remains available and unchanged. React project
model/provider hooks share the compact project cache, and model visibility now
uses an indexed lookup instead of repeatedly scanning the catalog. Runtime and
type public-surface snapshots contain additions only.

The surrounding product flow now uses the shared model selector for the single
project-default control and every fallback choice. Routing saves and project-
default writes are mutually excluded through a shared mutation key, and an
effective-default refetch cannot replace unsaved fallback edits.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0;
`pnpm --filter @kortix/sdk test` reported **1094 pass / 0 fail** across 79 files
with 4988 assertions; `pnpm --filter @kortix/sdk smoke:install` built, packed,
installed, imported, and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** — the SDK change is additive, snapshot-locked,
install-verified, and backed by the real local compact-picker API flow.

---

### 2026-07-13 — session `sandbox-template-provider-readiness` (claim)

Claimed the additive provider-aware sandbox-template observation contract. The
template API will expose current launch readiness independently for Daytona,
Platinum, and E2B while retaining every existing response field. The web host
will consume that typed SDK contract instead of interpreting the legacy
Daytona-named field as universal provider truth.

**Status:** IN PROGRESS.

---

### 2026-07-13 — session `sandbox-template-provider-readiness` (completion)

Completed the additive provider-aware template contract. Sandbox template
responses now type independent Daytona, Platinum, and E2B launch-readiness
observations, routed provider mode, and exact provider attribution for new build
rows. Reusable template builds fan out to every enabled provider independently
of project routing pins. Existing fields and exported names remain compatible.

**TDD evidence:** the initial typecheck failed because `provider_coverage` was
absent, then passed after the additive contract was implemented. Final SDK gates:
`pnpm --filter @kortix/sdk typecheck` exited 0; `pnpm --filter @kortix/sdk test`
reported **1095 pass / 0 fail** across 80 files with 4990 assertions;
`pnpm --filter @kortix/sdk run smoke:install` built, packed, installed, imported,
and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** for the SDK surface. Parent API/UI rollout and
live provider verification remain part of the enclosing change.

---

### 2026-07-13 — session `sandbox-template-provider-status-v2` (completion)

Completed the follow-up provider-status and failure-recovery contract on top of
the provider-neutral synchronization rollout. The additive rebuild response can
now report providers that failed before their rebuild was started, while the UI
keeps Automatic neutral and shows selected-provider plus current-image status
only for pinned projects. Existing provider readiness and `launch_ready` fields
remain backward compatible.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0;
`pnpm --filter @kortix/sdk test` reported **1094 pass / 2 skip / 0 fail**
across 80 files with 4986 assertions; `pnpm --filter @kortix/sdk run smoke:install` built,
packed, installed, imported, and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** for the SDK surface. API/web typechecks,
focused provider tests, and UI lint also pass; live dev verification remains the
enclosing rollout gate.

---

### 2026-07-15 — session `self-host-e2e-snapshot-fix`

Accepted the intentionally additive public SDK surface introduced by the generic
self-host GitHub App/PAT and managed-git clients. The runtime snapshot gained 12
entries and the type-level snapshot gained 24 entries across the canonical root
and compatibility subpaths; no exported name was removed or renamed.

**RED evidence:** the focused public-surface guards failed 2 / 2 and reported only
additions for `GitHubApp*`, `ManagedGitStatus`, and their client functions.
**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0;
`pnpm --filter @kortix/sdk test` reported **1092 pass / 2 skip / 0 fail** across
80 files with 4943 assertions; `pnpm --filter @kortix/sdk run smoke:install`
built, packed, installed, imported, and constructed `@kortix/sdk` successfully.
The exact self-host fast E2E also reported **24 pass / 0 fail**.

**Shippable to production: YES** — the public additions are deliberate,
snapshot-locked, install-verified, and the self-host CLI contract is green.

- 2026-07-17 — additive: `PtyMutationOptions` + `ptyMutationOverrides`, `useCreatePty`/`useUpdatePty` accept optional `onError` so hosts can keep pty errors out of global toasts (web terminal UX). Surface snapshot re-recorded (adds only).

---

### 2026-07-17 — session `postman-connectors` (claim)

Claimed the additive Postman connector surface within the user-directed
end-to-end Postman ingestion rollout. The SDK scope is deliberately narrow: add
`postman` to existing connector provider unions and preserve the current
`ConnectorDraftInput` API. No exported name is renamed or removed. Design and
execution plan: `docs/specs/2026-07-17-postman-connectors.md` and
`docs/plans/2026-07-17-postman-connectors.md`.

Implementation will follow RED -> GREEN -> REFACTOR and finish with the full SDK
typecheck, test, and packed-install smoke gates.

**Status:** IN PROGRESS.

---

### 2026-07-17 — session `postman-connectors` (completion)

Completed the additive Postman connector provider contract. The published SDK
now accepts and reports `postman` anywhere the existing connector surfaces
accept a provider, without renaming or removing an exported symbol.

**TDD evidence:** the focused connector contract initially rejected `postman`,
then passed after the provider union was widened. **Final SDK gates:**
`pnpm --filter @kortix/sdk typecheck` exited 0; `pnpm --filter @kortix/sdk test`
reported **1113 pass / 0 fail** across 82 files with 4995 assertions; and
`pnpm --filter @kortix/sdk smoke:install` built, packed, installed, imported,
and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** — the SDK change is additive, its complete
runtime and type-level public surfaces remain snapshot-locked, and the packed
consumer install path is verified. The enclosing API/CLI/UI Postman rollout
retains its own merge, deploy, and live-dev gates.

**Post-rebase gate addendum:** after rebasing onto `origin/main` at
`bcb2a2afa`, the SDK typecheck remained green; the full suite reported
**1121 pass / 0 fail** across 84 files with 5005 assertions; and the packed
install smoke again passed. **Shippable to production: YES.**

---

### 2026-07-17 — session `discover-marketplace` (claim)

Claimed the additive Discover integration-catalog SDK surface for the user-directed
unified marketplace rollout. The SDK will expose integrations.sh catalog records and
their executable variants, while Pipedream entries remain separate, explicitly
labelled OAuth-only alternatives. Existing connector APIs and exported names remain
backward compatible. Implementation will follow RED -> GREEN -> REFACTOR and finish
with typecheck, full-suite, and packed-install smoke evidence.

**Status:** IN PROGRESS.

---

### 2026-07-17 — session `discover-marketplace` (completion)

Completed the additive Discover catalogue SDK surface. The published client now
exposes typed integrations.sh list/detail calls plus
`project(id).connectors.discover.{list,detail}`. Pipedream remains a separate
existing catalogue surface and its app contract is narrowed to the OAuth-only
records returned by the API. Runtime and type snapshots contain additions only;
no exported name was removed or renamed.

**TDD and live evidence:** the focused API/Postman/SDK/UI run passed **96 tests / 0
failures**. A real authenticated local flow searched HubSpot through the Discover
API, resolved its direct MCP/docs/CLI/Postman variants, verified the official
Postman repository requires bearer auth, and materialized **1,223 actions** with
zero sync errors. The live Pipedream search returned only `authType: oauth`.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full SDK
suite reported **1121 pass / 2 skip / 0 fail** across 84 files with 5009
assertions; and `pnpm --filter @kortix/sdk run smoke:install` built, packed,
installed, imported, and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** for the SDK surface. Repository merge, Deploy
Dev, and live-dev verification remain part of the parent feature lifecycle.

---

### 2026-07-17 — session `revert-discover-marketplace` (claim)

Claimed the user-directed rollback of the additive Discover catalogue SDK surface
while preserving the earlier first-class Postman connector provider contract. The
rollback removes only the integrations.sh list/detail APIs and facade bindings that
shipped in PR #4920. Full SDK typecheck, suite, and packed-install smoke gates are
required before completion.

**Status:** IN PROGRESS.

---

### 2026-07-17 — session `revert-discover-marketplace` (completion)

Completed the user-directed rollback of the Discover catalogue SDK surface from
PR #4920. The earlier first-class Postman provider remains accepted by connector
drafts and responses; only the integrations.sh list/detail functions and
`project(id).connectors.discover` facade binding were removed.

**Focused evidence:** executor/Postman tests passed **68 / 0**; the restored
Connectors/Channels source regression passed **6 / 0**; API typecheck exited 0;
and the ke2e coverage gate passed at **405 / 493 routes** with the two Discover
routes absent.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full SDK
suite reported **1119 pass / 2 skip / 0 fail** across 84 files with 4999
assertions; and `pnpm --filter @kortix/sdk run smoke:install` built, packed,
installed, imported, and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** for this explicitly requested rollback. The two
skips are the pre-existing browser-bundle tests that require a bundle build.

---

### 2026-07-18 — session `connector-auth-discovery` (claim)

Claimed the user-directed source-agnostic connector authentication discovery
work. Postman, OpenAPI, and every other supported connector source will preserve
usable authentication metadata, normalize it into one additive typed contract,
and prefill connector setup while leaving secret values and interactive consent
to the user. Existing connector draft fields and provider behavior remain
backward compatible. Implementation will follow RED -> GREEN -> REFACTOR and
finish with the full SDK typecheck, test, and packed-install smoke gates.

**Status:** IN PROGRESS.

---

### 2026-07-18 — session `connector-auth-discovery` (completion)

Completed the additive connector authentication discovery surface. The SDK now
exposes typed candidates and `project(id).connectors.auth.discover(input)`, while
connector creation keeps omitted auth as auto-detect and explicit `none` as a
durable opt-out. No exported name was removed or renamed.

**TDD and live evidence:** the focused API/parser/discovery run passed **101 / 0**.
The real HubSpot Postman-managed repository detected bearer auth across **1,223**
operations; authenticated connector creation synced **1 / 0 errors** and
materialized **1,223 actions** with `authSecret: credential` and `secretSet: false`.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full SDK
suite reported **1120 pass / 2 skip / 0 fail** across 84 files with 5005
assertions; and `pnpm --filter @kortix/sdk run smoke:install` built, packed,
installed, imported, and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** for the SDK surface. Repository PR, Deploy Dev,
and live-dev verification remain part of the parent feature lifecycle.

---

### 2026-07-18 — session `gateway-provider-key-verify` (completion)

Self-contained addition (not part of the Now chain — outside its own PR/plan):
`verifyGatewayProvider(projectId, providerId)` client fn +
`GatewayProviderVerifyResult`/`GatewayProviderVerifyStatus` types, backing a new
`POST /projects/:id/gateway/providers/:providerId/verify` endpoint that runs one
cheap live completion through a connected BYOK provider's credential and
classifies it `verified`/`invalid`/`unknown`/`not_connected` (closes the LLM
provider UI's "Connected ≠ proven working" gap). No exported name renamed or
removed — additive only.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full SDK
suite reported **1122 pass / 2 skip / 0 fail** across 84 files with 5009
assertions; and `pnpm --filter @kortix/sdk run smoke:install` built, packed,
installed, imported, and constructed `@kortix/sdk` successfully. Public-surface
snapshots re-recorded — diff is additive only (`verifyGatewayProvider`,
`GatewayProviderVerifyResult`, `GatewayProviderVerifyStatus`).

**Shippable to production: YES** for the SDK surface. apps/api route + apps/web
UI land in the same PR (#4990); see that PR for backend/frontend evidence.

---

### 2026-07-18 — session `connectors-discover-flag` (claim)

Claimed the user-directed restoration of the additive Discover integration-catalog
SDK surface as a separate, per-project experimental connector marketplace. Existing
Easy Connect remains unchanged; Discover is explicit opt-in and Pipedream entries
remain separate OAuth-only alternatives. The prior additive SDK names are restored
without removing or renaming any current export. Implementation will finish with
focused RED -> GREEN coverage, full SDK typecheck/test/packed-install gates, real
local browser/API proof, and the repository merge/deploy/live-dev lifecycle.

**Status:** IN PROGRESS.

---

### 2026-07-19 — session `code-storage-e2e` (completion)

Completed the additive managed-Git username contract. `ProjectGitToken` now
exposes `git_username` without removing or renaming any public SDK name, so
Code Storage clients use `t:<token>` while the existing GitHub path continues
to use `x-access-token:<token>`.

**TDD evidence:** the focused RED run of
`bun test src/core/rest/projects-client/manifest-git-token.test.ts` failed when
the response's `git_username` was absent; after implementation the same command
reported **3 pass / 0 fail / 10 assertions**.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full SDK
suite reported **1138 pass / 2 skip / 0 fail**; and
`pnpm --filter @kortix/sdk run smoke:install` built, packed, installed, imported,
and constructed `@kortix/sdk` successfully. Cross-surface verification also
reported API focused **18 pass**, provision fixture **9 pass**, CLI **454 pass / 0
fail**, sandbox agent **208 pass / 0 fail**, and the live isolated Code Storage +
Daytona session smoke **24 pass / 0 fail**.

**Shippable to production: YES** for the SDK surface and local end-to-end path.
Repository merge, Deploy Dev, and live-dev verification remain part of the parent
feature lifecycle.

---

### 2026-07-19 — session `git-management-ux` (claim)

Claimed the additive GitHub project-create template input needed by the
user-directed Git provider default. `CreateProjectRepoInput` will accept the
existing optional `source_item_id` concept so a selected marketplace project
template is seeded into the user's newly created GitHub repository rather than
silently falling back to the generic starter or Kortix-managed storage. No
exported name or existing field will be removed or renamed. Implementation will
follow RED -> GREEN -> REFACTOR and finish with the full SDK typecheck, test,
and packed-install smoke gates.

**Status:** IN PROGRESS.

---

### 2026-07-21 — session `project-session-inventory` (claim)

Claimed the user-directed privileged project session inventory contract. The
existing visible-session list remains backward compatible; an additive manager-
only inventory mode will expose every durable project session, resolved human or
agent ownership, and explicit viewer access/runtime availability so owners and
admins can investigate private, stopped, unavailable, and soft-deleted sessions
without granting ordinary members broader visibility. Implementation will follow
RED -> GREEN -> REFACTOR and finish with the full SDK typecheck, test, and
packed-install smoke gates.

**Status:** IN PROGRESS.

---

### 2026-07-21 — session `project-session-inventory` (completion)

Completed the additive manager-only project session inventory contract. The
ordinary list remains unchanged; `project(id).sessions.list({ scope: 'project' })`
now exposes every durable row with resolved human/service-account ownership,
viewer access, runtime state, and soft-delete audit metadata. No exported name
was removed or renamed.

**TDD and live evidence:** focused API/serializer/SDK/facade/web tests passed
**148 / 0**. API and web typechecks exited 0, focused web ESLint exited 0, the
full web suite reported **1837 pass / 0 fail**, and the API route contract suite
reported **59 pass / 0 fail**. A real authenticated local HTTP smoke proved the
manager default list stayed at 2 visible rows while project inventory returned
all 4 durable rows, including a private missing runtime, a stopped agent-owned
runtime, and a soft-deleted row; the ordinary member received 403 for project
inventory and a manager still received 404 when directly reading the private
session.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full SDK
suite reported **1145 pass / 0 fail** with 5071 assertions; and
`pnpm --filter @kortix/sdk run smoke:install` built, packed, installed, imported,
and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** for the SDK and local end-to-end contract.
Repository PR, Deploy Dev, and live-dev verification remain part of the parent
feature lifecycle.

---

### 2026-07-21 — session `profile-owned-bindings` (B11 completion)

Completed the additive member-owned connection-profile and session-binding
surface in implementation commit `3eb18b361`. A member can reconcile a profile
whose owner is derived from the bearer token, connect/finalize its distinct
Pipedream identity, and select it explicitly when starting a private session.
Project defaults remain shared. External, agent, and subject profiles retain the
management-capability path; that capability never exposes or mutates another
member's profile. Runtime resolution fails closed on owner or visibility drift.
No exported SDK name or existing field was removed or renamed.

**TDD and focused evidence:** profile/Postgres integration reported **15 pass / 0
fail**; authenticated HTTP authorization reported **5 pass / 0 fail**; Executor
gateway reported **32 pass / 0 fail**; and the computer connector regression
reported **8 pass / 0 fail**. The public runtime and type snapshots contain
additions only.

**Real local E2E:** two real Supabase users created, listed, mutated, and bound
only their own profiles; two real session starts persisted distinct bindings;
project/public sharing was rejected for the personal-profile session; and two
real Executor calls resolved distinct hidden credentials. The black-box proof
reported **21 pass / 0 fail**. Cleanup then verified zero synthetic projects,
users, tokens, and sandbox rows remained.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full SDK
suite reported **1145 pass / 0 fail** across 86 files with 5077 assertions; and
`pnpm --filter @kortix/sdk run smoke:install` built, packed, installed, imported,
and constructed `@kortix/sdk` successfully. API typecheck exited 0 and `git diff
--check` was clean.

**Post-rebase addendum:** after rebasing onto current `origin/main` at
`962498c4f`, SDK typecheck and packed-install smoke remained green; the full SDK
suite reported **1147 pass / 0 fail** across 86 files with 5080 assertions; API
typecheck exited 0; and the focused profile/authorization/Executor run reported
**52 pass / 0 fail**. The unrelated computer integration finding is recorded in
Discovered this session rather than changed inside B11.

**Shippable to production: YES** for the SDK surface and local end-to-end path.
Repository PR, Deploy Dev, deployed-SHA proof, and live-dev verification remain
the parent feature lifecycle.

---

### 2026-07-21 — session `revert-owner-profile-bindings` (completion)

Reverted the unfinished owner-scoped connector-profile session-start surface
introduced by #5139 so `main` returns to the previously published SDK contract.
This is an exact feature rollback rather than a new SDK behavior; the feature
will continue in a separate draft PR before it is considered shippable.

**Verification:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full SDK
suite reported **1145 pass / 0 fail** with 5071 assertions; the packed-install
smoke completed successfully; API typecheck exited 0; and the focused live-env
API regression run reported **41 pass / 0 fail** with 83 assertions.

**Shippable to production: YES** for the rollback. The owner-scoped binding
feature itself is **NOT YET** shippable and remains open as WIP.

---

### 2026-07-21 — session `service-account-profile-hardening` (claim)

Claimed the user-directed restoration of owner-scoped connector-profile bindings
after the security rollback, including the late Strix findings on both #5139 and
#5143. The restored additive SDK contract will remain unchanged; API enforcement
will additionally prove that service-account principals cannot create, list,
mutate, OAuth-connect, bind, or execute human `member` profiles, including
queued session creation and pre-existing forged bindings. Work will follow
RED → GREEN → REFACTOR and finish with the full SDK typecheck, test, and packed-
install smoke gates plus real HTTP/Executor proof.

**Status:** IN PROGRESS.

---

### 2026-07-21 — session `service-account-profile-hardening` (completion)

Completed the security restoration in `de11be3b0` and the post-rebase WhatsApp
principal propagation in `396a63823`. Direct service-account principals can no
longer create, enumerate, mutate, OAuth-connect, bind, or execute `member`
connection profiles, even when a forged row uses the service-account UUID as its
owner. Principal type survives durable queue persistence; older queued commands
infer it from the stored actor. Runtime resolution also rejects pre-existing
service-account sessions bound to forged member profiles. The restored manager
ownership and personal-session privacy checks cover every Strix thread from
#5139 and #5143.

**Focused evidence:** authenticated profile HTTP authorization reported **9 pass
/ 0 fail**; profile binding and Executor resolution reported **18 pass / 0
fail**; Executor gateway, sharing, public share, transcript, share endpoint,
session sandbox, and queue payload suites reported **86 pass / 0 fail**. Email,
Slack selection/dispatch, Teams, Telegram, trigger attribution, and WhatsApp
reported **60 pass / 0 fail**. API typecheck exited 0 and `git diff --check` was
clean. Multi-file Bun invocations reproduced the suite's known global mock
contamination; every affected file passed in its own isolated process.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full SDK
suite reported **1147 pass / 0 fail** across 86 files with 5080 assertions; and
`pnpm --filter @kortix/sdk run smoke:install` built, packed, installed, imported,
and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** for the SDK surface and locally verified API
hardening. Replacement PR review, Deploy Dev, deployed-SHA proof, and live-dev
HTTP/Executor verification remain part of the repository lifecycle.

---

### 2026-07-22 — session `terminal-connect-recovery` (B12 completion)

Removed the false OpenCode-health dependency from the daemon-owned PTY query.
The React hooks now subscribe to the session runtime URL directly. PTY create
and resize mutations stay pinned to that URL. The web panel replaces every
unbounded loading state with a 15-second server-URL deadline, a visible error,
and an explicit retry action. A WebSocket that never opens now expires after 15
seconds and enters the existing bounded backoff loop.

**TDD evidence:** the focused RED run failed because `isPtyQueryEnabled`,
`deriveTerminalPanelState`, and `shouldExpirePtyConnect` did not exist. The
focused GREEN run reported **14 pass / 0 fail** with 27 assertions.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full
suite reported **1148 pass / 2 skip / 0 fail** across 86 files with 5082
assertions; and `pnpm --filter @kortix/sdk run smoke:install` built, packed,
installed, imported, and constructed `@kortix/sdk` successfully. The full web
suite reported **1891 pass / 0 fail** with 5318 assertions. Focused web ESLint
exited 0.

**Runtime evidence:** isolated sandbox-agent and API proxy coverage reported 77
pass after the known Bun module-mock-contaminated file was rerun in isolation at
**6 pass / 0 fail**. Fresh local-stack smokes passed on both Platinum and
Daytona. Each smoke created a real PTY, opened two WebSocket attachments, wrote
and observed a marker, replayed scrollback, listed the running PTY, deleted it,
and cleaned up the session and project.

**Shippable to production: YES** for the SDK and local end-to-end terminal path.
Repository merge, Deploy Dev, deployed-SHA proof, and live-dev verification
remain part of the repository lifecycle.

---

### 2026-07-23 — session `github-repo-selector` (B13 completion)

Completed bounded GitHub repository discovery in `0748271116`. The SDK accepts
optional `search` and `limit` inputs. The API returns one recently updated page
for initial discovery. Repository-name searches use GitHub Search. Both managed
PAT and GitHub App installations use this bounded contract.

The web import flow debounces repository search by 300 ms, preserves selectable
results during background queries, and renders a retryable error state. The New
project modal now presents three explicit repository sources: Kortix managed,
create in GitHub, and import from GitHub. Account Git settings expose account
GitHub App connections without requiring platform-admin access. The synthetic
managed PAT is labelled as a server connection instead of a personal GitHub
account.

**TDD and runtime evidence:** focused SDK/API helper tests reported **9 pass / 0
fail**. The two API route tests reported **2 pass / 0 fail**. Focused web tests
reported **10 pass / 0 fail**. An authenticated local request returned the
managed installation plus an App install URL with status `200`. A bounded
repository search returned status `200` in **443 ms**. Production had returned
`503` after **25.08 seconds** on the unbounded path.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full
suite reported **1149 pass / 2 skip / 0 fail** across 86 files with 5083
assertions; and `pnpm --filter @kortix/sdk run smoke:install` built, packed,
installed, imported, and constructed `@kortix/sdk` successfully. API typecheck
exited 0. Focused web ESLint reported 0 errors. The full web typecheck remains
blocked by two unrelated `origin/main` errors in `template-url.test.ts`.

**Shippable to production: YES** for the SDK surface. Repository merge, Deploy
Dev, deployed-SHA proof, and live-dev verification remain part of the parent
feature lifecycle.

---

### 2026-07-23 — session `github-repo-selector` (GitHub installation linking claim)

Claimed the additive GitHub installation-save request field for secure
cross-account linking. The SDK sends an optional GitHub user token to the API.
The API verifies that the GitHub user owns the personal installation or
administers the organization installation. Existing callers remain compatible
at the type level.

**Status:** IN PROGRESS. Final SDK gates and repository delivery remain pending.

---

### 2026-07-23 — session `github-repo-selector` (GitHub installation linking completion)

Completed secure existing-installation linking. The additive SDK request field
passes the GitHub user token to the API. The API verifies personal ownership or
active organization-admin membership before it writes the account installation.
The signed install state also preserves the initiating frontend origin. A shared
GitHub App callback can therefore return to the Kortix host that started the
flow.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full
suite reported **1152 pass / 0 fail** across 86 files with 5090 assertions; and
`pnpm --filter @kortix/sdk run smoke:install` built, packed, installed, imported,
and constructed `@kortix/sdk` successfully.

**Shippable to production: YES** for the SDK surface. API typecheck, focused API
authorization tests, focused web tests, and focused web lint also pass.
Repository merge, Deploy Dev, and live-dev verification remain pending.

---

### 2026-07-23 — session `github-existing-installation-link` (claim)

Claimed the additive existing-GitHub-App installation discovery contract. The
SDK will request installations that the authorized GitHub user can link to one
Kortix account. The API will verify personal ownership or active organization
admin access before it returns or saves an installation. Existing install and
save contracts remain backward compatible.

**Status:** IN PROGRESS.

---

### 2026-07-23 — session `github-existing-installation-link` (completion)

Completed the additive existing-installation discovery and link surface. The SDK
exposes typed list and link functions. The API lists this GitHub App's
installations with the App JWT, then filters them against the authorized GitHub
user and active organization-admin memberships. The link route re-fetches the
selected installation with the App JWT and repeats the GitHub authorization check
before the database write. No exported name was removed or renamed.

**TDD and focused evidence:** the GitHub SDK client reported **5 pass / 0 fail**;
the GitHub App API suite reported **9 pass / 0 fail** with 30 assertions; and the
web GitHub setup and connection regressions passed inside the full web suite.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full
suite reported **1158 pass / 0 fail** across 86 files with 5110 assertions; and
`pnpm --filter @kortix/sdk run smoke:install` built, packed, installed, imported,
and constructed `@kortix/sdk` successfully.

**Cross-surface evidence:** API typecheck exited 0; the full web suite reported
**1952 pass / 0 fail** across 212 files with 5455 assertions; focused web ESLint
exited 0; and `git diff --check` exited 0. The full web typecheck reports only the
two existing `origin/main` errors in `template-url.test.ts`.

**Real local proof:** authenticated `POST
/v1/projects/github/installations/linkable` returned 200 for GitHub login
`markokraemer` and three verified installations. Authenticated `POST
/v1/projects/github/installations/link` returned 200 for personal installation
`148404669`. The account installation read-back returned the same owner and
installation. Chromium rendered the same-origin `Link a GitHub account` page and
opened GitHub OAuth in a popup with `read:user read:org`. The local OAuth callback
cannot complete because the local Supabase container has the literal placeholder
GitHub client ID; deployed-dev OAuth remains the repository delivery gate.

**Shippable to production: YES** for the SDK and locally verified API contract.
Repository PR, Deploy Dev, deployed-SHA proof, and full live-dev OAuth UI
verification remain part of the parent feature lifecycle.

---

### 2026-07-24 — session `fix-free-tier-model-entitlement` (B14 completion)

Removed the synthetic `auto` model from the catalog, API routing, sandbox
configuration, SDK defaults, web model picker, CLI, Slack, and tests. The
platform default is the concrete managed model `glm-5.2`. Stale `auto` and
`kortix/auto` selections are discarded by SDK storage compatibility paths and
rejected by the gateway as `model_not_found`.

Managed-model entitlement now depends only on the resolved billing tier.
`free`, `none`, and unknown tiers are blocked in every environment. Wallet
balance cannot grant managed-model access. Free-tier gateway authorization
does not place an LLM wallet hold. BYOK resolves with `billingMode: none` and
does not append a managed fallback. Codex remains provider-funded and reaches
its credential gate before any managed-model entitlement gate.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0; the full SDK
suite reported **1179 pass / 0 fail** across 89 files with 5187
assertions; and `pnpm --filter @kortix/sdk run smoke:install` built, packed,
installed, imported, and constructed `@kortix/sdk` successfully. The two public
surface snapshot diffs contain only the additive `resolvePromptModel` export.

**Cross-surface evidence:** the full web suite reported **1979 pass / 0 fail**
across 219 files with 5521 assertions. The sandbox-agent suite reported **215
pass / 0 fail**. The model catalog reported **64 pass / 0 fail**. The CLI
reported **514 pass / 0 fail**. The API contract reported **35 pass / 0 fail**.
All six affected package typechecks and focused web ESLint exited 0. Task-specific
API suites reported **69 pass / 0 fail** when run in isolated processes.

The standalone gateway reported **22 pass / 2 fail**. Both failures are
pre-existing architecture checks: `origin/main` already contains the
`@kortix/llm-catalog` dependency and the three flagged imports. The full API
command did not terminate after 14 minutes and was stopped. Its task-specific
files all pass in isolated processes.

**Real local HTTP evidence:** the API startup reported `Billing: ENABLED`. A
free account with `$100` balance received `400 plan_upgrade_required` for
`glm-5.2`; its balance remained `$100`. Both stale Auto IDs received `400
model_not_found`. The free catalog omitted all managed models and both Auto IDs.
The free model-default response returned `platformDefault: glm-5.2`,
`resolvedForCaller: null`, and `freeTier: true`. Free BYOK returned one
provider-funded candidate with no managed fallback. Free Codex reached
`provider_not_connected`, not the tier gate. A paid `per_seat` account received
`200` from `glm-5.2` with one completion choice.

**Shippable to production: YES** for B14 and the published SDK surface.
Repository merge, Deploy Dev, deployed-SHA proof, and live-dev verification
remain part of the repository lifecycle.

---

### 2026-07-24 — session `cors-transport-resilience` (B16 completion)

Added bounded transport retries to the shared SDK HTTP client. `GET` and `HEAD`
requests now use three total attempts. The retry delays are 250 ms and 500 ms.
The client still retries HTTP 502, 503, and 504 responses. It does not retry
mutations or abort errors. The host error handler runs once after exhaustion.

Extracted the API CORS configuration into `apps/api/src/middleware/cors.ts`.
The origin, method, header, credential, and preview policies remain unchanged.
Successful preflight responses now include `Access-Control-Max-Age: 600`.

**TDD evidence:** the first SDK regression run reported **18 pass / 2 fail**.
Both failures showed that `TypeError: Failed to fetch` received no SDK retry.
The first API test failed because `src/middleware/cors.ts` did not exist.
The focused GREEN runs reported **20 pass / 0 fail** for the SDK and **3 pass /
0 fail** for API CORS.

**Final SDK gates:** SDK and API typechecks exited 0. The full SDK suite reported
**1186 pass / 0 fail** across 89 files with 5204 assertions. The packed-install
smoke built, packed, installed, imported, and constructed `@kortix/sdk`.
`git diff --check` exited 0.

**API suite evidence:** the focused CORS suite passed. The full API suite reached
and passed the CORS suite. It then failed in unrelated existing tests. Examples
include missing `getTraceHeaders` and `captureException` exports, incomplete
maintenance mocks, and missing sandbox-reaper exports.

**Real local HTTP evidence:** an allowed preflight returned 204 with
`Access-Control-Allow-Origin: https://kortix.com`,
`Access-Control-Allow-Credentials: true`, and
`Access-Control-Max-Age: 600`. An unknown origin received no
`Access-Control-Allow-Origin`. `/v1/health` returned 200.

The in-app browser runtime exposed no browser. Local Chromium verification
remains unexecuted.

**Shippable to production: YES** for B16 and the published SDK surface.
Repository PR, Deploy Dev, deployed-SHA proof, and live-dev verification remain
part of the repository lifecycle.
---

### 2026-07-24 — session `native-oauth-sharepoint` (B17 claim)

Claimed the additive native OAuth2 client-credentials connection-profile
contract. The existing Executor and Connector architecture remains unchanged.
The server will acquire, cache, refresh, revoke, and inject OAuth2 access tokens.
The first slice supports client secrets and certificate-based client assertions.
Existing static credentials and Pipedream connections remain backward compatible.

**Status:** IN PROGRESS.

---

### 2026-07-24 — session `native-oauth-sharepoint` (B17 completion)

Added OAuth2 client credentials to the existing Connector and Executor
credential routes. Static credentials remain compatible. The new contract
supports `client_secret_post`, `client_secret_basic`, and `private_key_jwt`.
Certificate assertions use `PS256` and include `x5t#S256`.

The API validates the token endpoint before storage. It encrypts the OAuth2
configuration and cached access token with the project key. Executor resolution
refreshes tokens with 60 seconds or less remaining. A PostgreSQL advisory lock
serializes concurrent refreshes for each credential row. Profile revocation
removes the credential from the next Executor resolution.

**Final SDK gates:** the SDK typecheck exited 0. The full SDK suite reported
**1187 pass / 0 fail** across 89 files. The packed-install smoke built,
packed, installed, imported, and constructed `@kortix/sdk`. The public type
snapshot adds only `ConnectionProfileCredentialInput` and
`OAuth2ClientCredentials` under the root and `projects-client` exports.

**Cross-surface evidence:** the API contract reported **37 pass / 0 fail**.
The focused API suites reported **45 pass / 0 fail**. The isolated PostgreSQL
profile suite reported **22 pass / 0 fail**. The full web suite reported
**2089 pass / 0 fail**. Ke2e coverage reported **493/502 routes**, 9 allowlisted,
and 0 uncovered. API, SDK, and API-contract typechecks exited 0. Focused web
ESLint and `git diff --check` exited 0.

The repository-wide API suite is not green on this base. Unrelated baseline
failures include missing `getTraceHeaders`, stale sandbox-reaper exports, and
incomplete maintenance mocks. The changed OAuth2 and Executor suites pass.

**Real SharePoint evidence:** the isolated API acquired a Microsoft Graph token.
Graph returned 200 for the configured SharePoint site. Graph returned 200 for
the document-library list and returned one drive. Local profile revocation
returned 200. The next Executor call returned 404.

The browser runtime exposed zero browsers. Browser DOM and network verification
remain unexecuted. The temporary browser fixture was deleted. The isolated
database reports zero rows for its project and auth user.

**Shippable to production: YES** for B17 and the published SDK surface.
Repository merge, Deploy Dev, deployed-SHA proof, and live-dev verification
remain part of the repository lifecycle.
---

### 2026-07-24 — session `frontend-sdk-only` (web SDK boundary Task 1)

Created the web SDK-only specification and implementation plan. Added an AST
boundary scanner, an exact ratchet baseline, and ESLint import restrictions.

The RED test reported 155 forbidden production imports. The categories were 103
host runtime imports, 32 host-owned Kortix API imports, and 20 deprecated SDK
runtime imports.

The focused GREEN run reported 1 pass and 0 failures. ESLint returned one
`no-restricted-imports` error for a synthetic `@opencode-ai/sdk` import outside
the baseline. ESLint passed for the changed configuration, scanner, and test.

**Shippable to production: NOT YET.** The baseline still contains 155 violations.

---

### 2026-07-24 — session `frontend-sdk-only` (web SDK boundary Task 2)

Replaced frontend OpenCode compatibility imports with `@kortix/sdk` and
`@kortix/sdk/react`. Replaced host store imports with
`@kortix/sdk/internal/*`. Deleted 13 compatibility re-export files.

The boundary baseline decreased from 155 violations to 47 violations. All 20
deprecated SDK runtime imports are gone. The host runtime category decreased
from 103 imports to 15 imports. The 32 host-owned Kortix API imports remain for
Task 5.

Focused web tests reported **51 pass / 0 fail**. The boundary test passed.
ESLint checked 78 changed TypeScript files and reported 0 errors. It reported
four existing `react-hooks/exhaustive-deps` warnings.

The web typecheck reported four existing errors. None references a changed
file. Two errors are in the OG template test. Two errors are unresolved
generated docs-source imports.

**Shippable to production: NOT YET.** Tasks 3 through 8 remain incomplete.

---

### 2026-07-25 — session `native-oauth-full-lifecycle` (authentication Task 3)

Added the generic OAuth2 protocol engine. It implements PKCE S256,
Authorization Code exchange, refresh-token rotation, Device Authorization,
discovery, and revocation. Token requests support `none`,
`client_secret_basic`, `client_secret_post`, `client_secret_jwt`, and
`private_key_jwt`. Provider responses are bounded. Provider errors omit
descriptions and token values. Production egress uses the shared SSRF guard.

Expanded the existing Client Credentials contract with `none` and
`client_secret_jwt`. Removed the certificate-thumbprint requirement from
generic `private_key_jwt`. The optional thumbprint remains supported.

**RED evidence:** the focused protocol test failed because
`oauth2-lifecycle.ts` did not exist.

**Verification:**

- Focused OAuth, contract, and SDK suites: **83 pass / 0 fail**.
- API typecheck: exit 0.
- SDK typecheck and example typecheck: exit 0.

**Shippable to production: NOT YET.** Tasks 4 through 8 remain incomplete.

---

### 2026-07-25 — session `native-oauth-full-lifecycle` (authentication Task 4)

Added project-scoped routes for redacted application configuration, discovery,
Authorization Code start, Device Authorization start and poll, and status.
Added the public state-authenticated callback. Callback state is hashed,
profile-bound, user-bound, expiring, and consumed once. Added remote
revocation attempts with unconditional local delegated-credential deletion.

**Verification:**

- Focused OAuth, contract, and SDK suites: **83 pass / 0 fail**.
- API typecheck: exit 0.
- Local API proof: application PUT 200, redacted GET 200, status GET 200,
  Authorization Code start 200 with `S256` and state.
- Callback replay proof: first provider-error callback returned 302 to the
  allowlisted local frontend; the second callback returned 400.
- Ke2e `CONN-OAUTH2`: **1 pass / 0 fail** in 4.55 seconds.
- Ke2e coverage: **492/501 routes covered, 9 allowlisted, 0 uncovered**.

**Shippable to production: NOT YET.** Tasks 5 through 8 remain incomplete.

---

### 2026-07-25 — session `native-oauth-full-lifecycle` (authentication Task 5)

Added delegated OAuth2 token resolution and refresh under the credential
database advisory lock. Refresh-token rotation updates the encrypted credential.

Added native request authentication for API keys in headers, query parameters,
and cookies; generic HMAC-SHA256; AWS Signature Version 4; and mutual TLS.
Existing bearer, HTTP Basic, custom, OAuth 1.0a, and no-auth behavior remains.
The manifest schema and SDK types expose the same authentication matrix.

**RED evidence:** four executor tests failed before implementation. They showed
missing cookie placement, raw HMAC and SigV4 credentials in headers, and absent
TLS options.

**Verification:**

- Focused executor, OAuth, manifest, contract, and SDK suites:
  **205 pass / 0 fail**.
- Added manifest conformance proof: **108 pass / 0 fail** in the final focused
  wave.
- API typecheck: exit 0.
- SDK typecheck and example typecheck: exit 0.

**Shippable to production: NOT YET.** Tasks 6 through 8 remain incomplete.

---

### 2026-07-24 — session `frontend-sdk-only` (web SDK boundary Task 3)

Enabled the complete `useSession(projectId, sessionId)` engine on the project
session page. The root `SessionChat` now consumes its messages, status, and
pagination state. Child session modals retain an isolated read-only sync engine.

Moved permission recovery into `useSession`. Disabled duplicate question and
permission recovery inside the root `SessionChat`. Replaced the frontend
`getClient().session.command()` call with the typed SDK command action.

**TDD evidence:** the first command-input test failed because
`buildSessionCommandInput` did not exist. The first runtime forwarding test
failed because `executeOpenCodeCommand` did not exist. The GREEN SDK run
reported **20 pass / 0 fail**.

The web architecture test first reported **0 pass / 2 fail**. It detected
`chatEngine: false`, a second message sync engine, duplicate recovery pollers,
and a direct runtime client call. The GREEN web run reported **53 pass / 0
fail** across 11 focused files.

The SDK typecheck exited 0. The web typecheck reported four existing errors.
None references a changed file. ESLint reported 0 errors and one existing
`react-hooks/exhaustive-deps` warning.

**Shippable to production: NOT YET.** Tasks 4 through 8 remain incomplete.

---

### 2026-07-24 — session `frontend-sdk-only` (web SDK boundary Task 4)

Moved provider normalization, provider merging, and server-backed model defaults
into `@kortix/sdk/react`. Added `useSessionModelSelection` as the
runtime-neutral project model and agent hook.

Moved optimistic compaction state behind `useSession`. Consolidated first-message
files and boot-time queued messages into one presentation-only web store.
Deleted every file under `apps/web/src/hooks/opencode`.

The boundary baseline decreased from 47 violations to 32 violations. The host
runtime category decreased from 15 imports to 0 imports. The remaining 32
violations are host-owned Kortix API imports assigned to Task 5.

**TDD evidence:** the provider merge test failed because
`mergeProviderLists` did not exist. The model-default test failed because
`use-model-defaults` did not exist. The compaction boundary test failed while
`SessionChat` imported the host compaction store.

The GREEN SDK run reported **113 pass / 0 fail**. The GREEN web run reported
**33 pass / 0 fail**. The SDK typecheck exited 0. The web typecheck retained
four unrelated existing errors. ESLint reported 0 errors and two existing hook
warnings.

**Shippable to production: NOT YET.** Tasks 5 through 8 remain incomplete.

---

### 2026-07-24 — session `frontend-sdk-only` (web SDK boundary Task 5)

Moved every frontend Kortix API transport into `@kortix/sdk`. Deleted
`apps/web/src/lib/api-client.ts` and nine host API wrapper modules. Moved the
IAM client and portable React Query modules into the SDK.

The corrected boundary inventory found 40 forbidden imports after adding
`@/lib/api-client` enforcement. The final baseline contains 0 violations.
The scanner also rejects the `backendApi` and `authenticatedFetch` identifiers.

**TDD evidence:** five focused SDK files first failed on missing exports.
The GREEN SDK run reported **48 pass / 0 fail**. The web boundary and public
marketplace run reported **5 pass / 0 fail**. The SDK typecheck exited 0.
ESLint reported 0 errors.

The public runtime and type snapshots contain additions only. They contain no
removed or renamed exports.

**Shippable to production: NOT YET.** Tasks 6 through 8 remain incomplete.

---

### 2026-07-24 — session `frontend-sdk-only` (web SDK boundary Task 6)

Moved runtime routing, runtime actions, SSE transport, preview authentication,
presentation conversion, PTY commands, and explicit host-boundary transport
into `@kortix/sdk`.

Added runtime-neutral SDK aliases without removing existing public exports.
Renamed the remaining frontend files that contained `opencode`. The web source
tree now contains no file path with that term.

Expanded the AST boundary and ESLint gates. They reject OpenCode imports,
deprecated runtime SDK subpaths, SDK internal subpaths, legacy runtime stores,
runtime proxy paths, OpenCode REST paths, and raw Kortix backend routes.
The boundary baseline contains 0 violations.

The runtime snapshot added 145 names and removed 0 names. The type snapshot
added 167 names and removed 0 names.

**Verification:**

- SDK typecheck: exit 0.
- SDK suite: **1206 pass / 0 fail / 2 skip** across 98 files.
- SDK packed-install smoke: pass.
- Web suite: **2043 pass / 0 fail** across 224 files.
- Web boundary test: **1 pass / 0 fail**.
- Changed-file ESLint: 0 errors and 22 existing warnings.
- Web typecheck: four existing errors only. Two are in the OG template test.
  Two are unresolved generated docs-source imports.
- White-label typecheck: exit 0.
- White-label fresh build: exit 0.
- White-label E2E: **44 pass / 0 fail / 3 live-upstream skips**.

**Shippable to production: NOT YET.** Task 7 local parity proof and Task 8
delivery and dev proof remain incomplete.

---

### 2026-07-24 — session `frontend-sdk-only` (web SDK boundary Task 7)

Added a real browser regression for the SDK-only session path. The test creates
a confirmed user, provisions a project and Platinum session, sends one prompt,
observes the SDK runtime request, opens Files, and deletes all created resources.

Updated the shared browser login helper for the email-first password flow.
Added the SDK boundary test and frontend ESLint to the pull-request CI job.

**Verification:**

- SDK typecheck: exit 0.
- SDK suite: **1206 pass / 0 fail / 2 skip** across 98 files.
- SDK packed-install smoke: pass.
- Web suite: **2043 pass / 0 fail** across 224 files.
- Web SDK boundary plus full source ESLint: **1 pass / 0 fail**, ESLint exit 0.
- White-label typecheck and fresh build: exit 0.
- White-label E2E: **44 pass / 0 fail / 3 live-upstream skips**.
- Managed session HTTP smoke: **25 pass / 0 fail** with a visible `PONG`.
- PTY smoke: pass, including WebSocket attach and replay.
- File transport smoke: **26 pass / 1 optional agent-read failure**.
- SDK-only Chromium session: **1 pass** in 1.0 minutes. It observed one
  `prompt_async`, visible `PONG`, no failed Kortix responses, and `kortix.yaml`.
- Tests TypeScript check and `git diff --check`: exit 0.

The generic auth spec failed because its default local user credentials were
absent. The SDK-only regression creates and deletes its own confirmed user.

**Shippable to production: NOT YET.** Task 8 delivery and dev proof remains.

---

### 2026-07-24 — session `frontend-sdk-only` (web SDK boundary Task 8)

Merged the SDK-only web refactor in PR #5388. The merge commit is
`aefa2a6282ed540a7296e35db2747bce2cc1d3eb`.

Deploy Dev run 30129604715 completed successfully at
`ae967fdbc6066f3a941a4553c0d21afb10639774`. Git ancestry proves that deployed
commit contains the refactor merge. The API health route reported
`0.10.15-dev.ae967fdb`. The tested Vercel deployment reported
`0.10.14-dev.ae967fdb`.

The deployed Chromium regression passed in 1.2 minutes. It rendered the session
workspace, sent one `prompt_async` request, displayed `PONG`, observed zero
failed Kortix project or runtime responses, and opened `kortix.yaml`.

The first protected-dev browser run exposed an E2E harness defect. The shared
Vercel bypass header reached the cross-origin API and failed its CORS preflight.
The login helper now converts that header into a web-origin Vercel cookie before
the browser sends API requests.

The public PTY smoke exposed a Cloudflare WebSocket response defect. PR #5392,
merged as `8688b8492c9534bb6d43a3282904f19cbd557c78`, preserves Cloudflare
`response.webSocket` upgrade responses. Dev worker version
`33ef7b35-3e6d-452f-9165-b00bafd9e9a1` carries the fix.

The final public dev PTY smoke passed against a real Platinum sandbox. It
created a PTY, opened the WebSocket, sent and observed a marker, reconnected and
observed replay, listed the running PTY, deleted it, and removed its disposable
project and session.

**Verification:**

- SDK typecheck: exit 0.
- SDK suite: **1210 pass / 0 fail**.
- SDK packed-install smoke: pass.
- Web suite: **2043 pass / 0 fail**.
- Web boundary test: **1 pass / 0 fail**.
- White-label E2E: **44 pass / 0 fail / 3 live-upstream skips**.
- Managed session HTTP smoke: **25 pass / 0 fail**.
- SDK-only local Chromium session: **1 pass**.
- SDK-only dev Chromium session: **1 pass**.
- Public dev Platinum PTY smoke: pass.
- Cloudflare API router regression: **5 pass / 0 fail**.

**Shippable to production: YES.** All eight tasks are complete. Local and
deployed dev paths pass.
---

### 2026-07-24 — session `managed-models-aster` (B18 completion)

Synchronized the managed-model playground pin with the four-model managed
catalog. The pin contains `claude-opus-4.8`, `claude-sonnet-4.6`, `glm-5.2`,
and `deepseek-v4-flash`. The pin no longer contains `qwen3.7-max` or
`deepseek-v4-pro`.

**RED evidence:** the playground stopped before API access because the pinned
IDs contained retired managed models.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0. The full SDK
suite reported **1185 pass / 2 skip / 0 fail** across 89 files. The
packed-install smoke built, packed, installed, imported, and constructed
`@kortix/sdk`.

**Shippable to production: YES** for B18 and the published SDK surface.
Repository delivery and live-dev verification remain part of the repository
lifecycle.
---

### 2026-07-25 — session `native-oauth-full-lifecycle` (authentication Task 1)

Added provider-independent OAuth2 application, Authorization Code, Device
Authorization, connection-status, and client-authentication contracts. Added
typed SDK methods for every profile-scoped lifecycle route.

**RED evidence:** the focused test command reported two missing exports and
zero passing tests before implementation.

**Verification:**

- Contract and SDK focused suites: **67 pass / 0 fail**.
- SDK typecheck and example typecheck: exit 0.

**Shippable to production: NOT YET.** Tasks 2 through 8 remain incomplete.

---

### 2026-07-25 — session `native-oauth-full-lifecycle` (authentication Task 2)

Added project-scoped encrypted OAuth application storage. Added short-lived
Authorization Code and Device Authorization session storage. The database
enforces valid flow material, session status, unique state hashes, and profile
tenant ownership.

**Verification:**

- Database typecheck: exit 0.
- Migration lint: 72 files pass with eight existing destructive warnings.
- Isolated database migration: applied
  `20260725120000000_executor_oauth_lifecycle`.
- Database query returned `executor_oauth_applications` and
  `executor_oauth_sessions`.

**Shippable to production: NOT YET.** Tasks 3 through 8 remain incomplete.

---

### 2026-07-25 — session `native-oauth-full-lifecycle` (authentication Task 6)

Added provider-independent web controls for Client Credentials, Authorization
Code with PKCE, and Device Authorization. Added all five token-endpoint client
authentication methods. Added typed project-profile creation for the first
delegated connection.

Added visible request-authentication controls for API keys, OAuth 1.0a,
HMAC-SHA256, AWS SigV4, mutual TLS, bearer, Basic, custom parameters, and no
authentication. Structured strategies accept validated encrypted JSON
credentials.

**RED evidence:** the focused web suite reported four failures and one missing
export before implementation.

**Verification:**

- Focused web suite: **17 pass / 0 fail**.
- Focused SDK connector suite: **26 pass / 0 fail**.
- API typecheck: exit 0.
- Changed-file ESLint: exit 0.
- Changed-file web TypeScript output: no errors.
- Live profile creation: connector list `200`; profile creation `200`.

The browser runtime reported zero available browsers. DOM and browser network
proof remains open for Task 7.

**Shippable to production: NOT YET.** Tasks 7 and 8 remain incomplete.

---

### 2026-07-25 — session `native-oauth-full-lifecycle` (authentication Task 7)

Completed the local contract, API, executor, SDK, database, web, and live HTTP
verification.

**Verification:**

- OAuth and request-authentication API suite: **44 pass / 0 fail**.
- Executor faces and authentication discovery suite: **80 pass / 0 fail**.
- OAuth web suite: **18 pass / 0 fail**.
- Full web suite: **2064 pass / 0 fail**.
- Full SDK suite: **1214 pass / 0 fail**.
- SDK typecheck, example typecheck, and packed-install smoke: exit 0.
- API, contract, manifest, and database typechecks: exit 0.
- API contract: **41 pass / 0 fail**.
- Manifest schema: **321 pass / 0 fail**.
- Database: **118 pass / 0 fail**.
- Migration lint: **72 files pass**. Squawk reports zero issues.
- Authorization Code callback: HTTP `302`; PKCE method `S256`.
- Authorization state replay: first callback HTTP `302`; replay HTTP `400`.
- Device Authorization: start HTTP `200`; poll reaches `active`.
- Refresh-token rotation replaced both access and refresh tokens.
- Revocation: HTTP `200`; profile status reaches `revoked`.
- Local API health: HTTP `200`.

The browser runtime reports `No browser is available`. Browser discovery
returns `[]`. Chromium DOM and network proof remains blocked.

**Shippable to production: NOT YET.** Task 8 delivery and dev proof remains.

---

### 2026-07-25 — session `native-oauth-full-lifecycle` (authentication Task 8)

Merged the provider-independent authentication engine in PR #5403. The merge
commit is `00bc29065ac54791b71957b9d2e2ccac313b5c29`.

Deploy Dev run 30136343999 completed successfully. The workflow applied the
OAuth lifecycle migration. It deployed API image tag `dev-00bc2906` to ECS and
EKS. It also tagged the frontend image with the full merge SHA.

The live dev health route returned HTTP `200`, environment `dev`, and version
`0.10.15-dev.00bc2906`. The public OAuth callback returned HTTP `400` without
state. The protected OAuth status route returned HTTP `401` without
authentication. These responses prove that the deployed OAuth routes are
mounted on the merged API artifact.

The browser runtime returned `No browser is available`. Browser discovery
returned `[]`. Chromium DOM and network proof remains blocked by the missing
browser runtime.

**Status: COMPLETE.**

**Shippable to production: YES.** Local protocol proof, CI, repository delivery,
deployed-SHA proof, database migration, and live dev API verification pass.

---

### 2026-07-25 — session `session-history-pagination` (claim)

Claimed the user-directed session-history pagination repair. The SDK will load
complete turns across fixed-size runtime pages. The web host will preserve a
stable visible DOM anchor instead of applying total `scrollHeight` growth.
Existing exports and session synchronization contracts remain backward
compatible. Work will follow RED -> GREEN -> REFACTOR and finish with the full
SDK typecheck, test, and packed-install smoke gates, focused web tests, browser
verification, repository merge, Deploy Dev, and live-dev proof.

**Status:** IN PROGRESS.
---

### 2026-07-25 — session `gateway-billing-audit` (B19 claim)

Claimed the additive managed-model pricing and cache-write cost contract. The
project catalog will carry server-supplied managed prices. The turn estimator
will accept a distinct cache-write rate. Existing public names and required
fields remain backward compatible.

Implementation will follow RED -> GREEN -> REFACTOR. The final SDK typecheck,
full suite, and packed-install smoke gates are required.

**Status:** IN PROGRESS.

---

### 2026-07-25 — session `gateway-billing-audit` (B19 completion)

Added the server-supplied managed-model prices to the typed project catalog.
Added cache-write rates and context tiers to the public turn-cost contract.
The browser no longer uses `models.dev` as a fallback for `kortix` models.
`GatewayLogRow` now includes `cache_write_tokens`.

**RED evidence:**

- The managed GLM lookup returned another provider's price instead of Aster's
  `$1/M` input, `$0.20/M` cache-read, `$1/M` cache-write, and `$4/M` output.
- The turn estimator priced cache writes at the input rate because the public
  contract had no `cacheWritePer1M` field.
- The gateway log SDK contract had no `cache_write_tokens` field.

**Verification:**

- SDK typecheck and example typecheck: exit 0.
- Full SDK suite: **1216 pass / 0 fail** across 98 files.
- Public type-surface snapshot: additive `ModelCostTierRates`; no removals.
- Packed-install smoke: built, packed, installed, imported, and constructed
  `@kortix/sdk`.
- Web managed-pricing suite: **8 pass / 0 fail**.
- Changed-file web ESLint and Prettier checks: exit 0.

**Shippable to production: YES** for B19 and the published SDK surface.
Repository merge, Deploy Dev, and live-dev verification remain repository
delivery tasks.

---

### 2026-07-25 — session `acp-opencode-canary` (OpenCode ACP Task 3 claim)

Claimed the OpenCode-only ACP canary after both previous SDK claims closed.
PR #5400 merged the session-history pagination change.
PR #5403 and Deploy Dev run 30136343999 completed the authentication lifecycle.

The sandbox process and bridge slices are complete.
The real OpenCode `1.18.4` smoke negotiated ACP v1, exposed its internal HTTP
server, and created ACP session `ses_0693a6e03ffeGeChw6OVEfRGaW`.

Task 3 will add server-owned `acp` and `rest` transport metadata.
The SDK source remains unchanged until Task 4 starts with a failing test.

**Status:** IN PROGRESS.

---

### 2026-07-25 — session `acp-opencode-canary` (OpenCode ACP Task 3 completion)

Separated the OpenCode process transport from the SDK client transport.
Every sandbox injects `KORTIX_OPENCODE_PROCESS_TRANSPORT=acp`.
The API client transport defaults to `rest` during the parity implementation.
The `/start` response reports that client transport as `runtime_transport`.
Pre-ACP servers can omit the additive field.

**Verification:**

- API contract and runtime-env tests: **22 pass / 0 fail**.
- Focused `/start` HTTP contract: **1 pass / 0 fail**.
- API contract typecheck: exit 0.
- API typecheck: exit 0.

**Status:** COMPLETE.

---

### 2026-07-25 — session `acp-opencode-canary` (OpenCode ACP Task 4 completion)

Added the framework-free SDK ACP transport.
It sends JSON-RPC requests, notifications, and responses through the authenticated sandbox bridge.
It consumes ordered SSE events and reconnects with `Last-Event-ID`.
It exposes native `session/load`, `session/prompt`, `session/cancel`, and `session/set_config_option` methods.

Added the framework-free ACP session projection.
It converts user, assistant, thought, tool, plan, permission, question, usage, and stop updates into the existing Kortix session presentation types.
It rejects updates for a different ACP session.

**RED evidence:** the focused run reported two missing modules and zero passing tests.

**Verification:**

- Focused ACP SDK suite: **8 pass / 0 fail**.
- SDK typecheck and example typecheck: exit 0.
- Isomorphic export and public-surface gates: **69 pass / 0 fail**.
- Direct OpenCode `1.18.4` smoke: ACP v1 initialize, session creation, streamed thought and assistant chunks, and `end_turn` completion.

**Status:** COMPLETE.

**Shippable to production: NOT YET.** Tasks 5 through 8 remain incomplete.

---

### 2026-07-25 — session `acp-opencode-canary` (OpenCode ACP Tasks 5–6 completion)

Extended the ACP projection for command, mode, config, session-information,
usage, permission, question, cancellation, and transport-error state.

Integrated ACP into the existing `useSession(projectId, sessionId)` hook.
The server-provided `runtime_transport` selects the SDK path.
Missing metadata and `rest` retain the existing OpenCode REST path.
The ACP path disables OpenCode REST events, session listing, message sync, and
prompt sends.

The root web composer calls `sessionState.sendParts()`.
The web application does not inspect `runtimeTransport`.
The same SDK result handles commands, cancellation, permissions, and questions.

Added the `acp_runtime` project experiment.
The existing self-describing experimental settings UI renders its catalog entry.

**RED evidence:**

- Runtime policy test: missing `createSessionRuntimePolicy` export; **0 pass / 1 fail**.
- Web routing test: missing `sessionState.sendParts`; **1 pass / 1 fail**.
- Projection and controller error fixtures: **8 pass / 2 fail**.

**Verification:**

- Focused ACP projection/controller suite: **10 pass / 0 fail**.
- Runtime policy/controller suite: **8 pass / 0 fail**.
- Web SDK routing gate: **2 pass / 0 fail**.
- SDK typecheck and examples: exit 0.
- SDK full suite: **1228 pass / 2 skip / 0 fail**.
- SDK packed-install smoke: pass.
- API experimental-feature suite: **16 pass / 0 fail**.
- API serializer suite: **17 pass / 0 fail**.
- API contract schema suite: **41 pass / 0 fail**.
- Sandbox ACP process and bridge suite: **19 pass / 0 fail**.
- White-label typecheck: exit 0.

**Status:** COMPLETE.

---

### 2026-07-25 — session `acp-opencode-canary` (OpenCode ACP Task 7 completion)

Completed the real OpenCode ACP parity matrix in one Chromium session.
The matrix covers ordered SSE reconnects, `Last-Event-ID`, `session/load`,
transcript restoration, text streaming, permissions, questions, attachments,
busy-message serialization, cancellation, slash commands, and process restart.

The sandbox daemon resumes the canonical ACP session after OpenCode restarts.
It publishes the replayable `kortix/runtime_ready` process-generation signal.
The SDK reloads the canonical session before it accepts another prompt.

The OpenCode question compatibility bridge exposes questions as
`session/request_input`.
The browser returns only ACP JSON-RPC responses.

**RED evidence:**

- SDK restart recovery: **12 pass / 1 fail**.
- Sandbox restart signal: **13 pass / 1 fail**.
- The pre-fix Chromium matrix reconnected SSE after `/kortix/refresh/`.
  It did not send a post-restart prompt because the new process had no loaded
  ACP session.

**Verification:**

- Focused ACP SDK suite: **18 pass / 0 fail**.
- Focused sandbox ACP suite: **17 pass / 0 fail**.
- Linux sandbox daemon build: exit 0.
- Platinum image `kortix-default-0429779a8bc2`: built in 370.774 seconds.
- Full local Chromium ACP and REST rollback matrix: **1 pass / 0 fail** in
  4.3 minutes.

**Status:** COMPLETE.

**Shippable to production: NOT YET.** Task 8 delivery and dev proof remain.

---

### 2026-07-25 — session `acp-opencode-canary` (OpenCode ACP Task 8 completion)

Merged the OpenCode-only ACP canary in PR #5415.
The merge commit is `3a45ab55b7a53cc20a3a360a7e8d65e4180a5c2a`.

Deploy Dev run 30148258802 completed successfully at
`f8968d3e1ae3066a3cdc819e6da99b363e36b744`.
Git ancestry proves that the deployed commit contains the ACP merge.
The live API health route reports `0.10.15-dev.f8968d3e`.

The active Vercel deployment is
`dpl_E9tZk2nS94mk1cAH1FmX6X464zkr`.
It is `READY` at commit
`0aa15072cf91e7be5c0d0cd2c39b8d3d703d5be2`.
Git ancestry proves that this frontend commit contains the ACP merge.

The deployed cold Chromium matrix passed without a preloaded ACP session.
It covered ordered SSE reconnects, `Last-Event-ID`, `session/load`, prompt
streaming, transcript reload, permissions, questions, attachments,
cancellation, busy-message serialization, slash commands, process restart
recovery, and REST rollback.
Playwright reported **1 pass / 0 fail** in 4.2 minutes.

The first deployed run exposed a test-harness defect.
The welcome-card close action used a 10-second timeout and suppressed its
timeout with `.catch(() => {})`.
The production button already had `aria-label="Dismiss"`.
The corrected test uses a 30-second click timeout and does not suppress a
failed click.

**Final verification:**

- SDK typecheck and example typecheck: exit 0.
- SDK full suite: **1249 pass / 0 fail** across 104 files with 5589 assertions.
- SDK packed-install smoke: pass.
- Test-harness typecheck: exit 0.
- Frontend SDK and session-engine boundaries: **3 pass / 0 fail**.
- Test formatting and `git diff --check`: exit 0.
- PR #5415 checks: **18 successful / 0 failing**.
- CodeQL: **0 new alerts**.
- Local ACP and REST Chromium matrix: **1 pass / 0 fail**.
- Deployed cold ACP and REST Chromium matrix: **1 pass / 0 fail**.

**Status: COMPLETE.**

**Shippable to production: YES.** All eight tasks are complete.
Local and deployed dev ACP and REST paths pass.

---

### 2026-07-25 — session `acp-opencode-canary` (ACP stream timeout correction)

The follow-up deployed cold Chromium run exposed an ACP transport defect.
`authenticatedFetch` applied its 30-second default timeout to `/kortix/acp/:sessionId`.
The controller lost the stream while `session/load` was pending.
The browser never sent `session/prompt`.

`isStreamingRequest` now exempts both OpenCode REST `/global/event` streams and
ACP `/kortix/acp/:sessionId` streams.
Non-streaming requests retain the 30-second timeout.

**RED evidence:**

- Focused auth transport suite: **11 pass / 1 fail**.
- The ACP URL returned `false` from `isStreamingRequest`.

**Verification:**

- Focused auth transport suite: **12 pass / 0 fail**.
- SDK typecheck and example typecheck: exit 0.
- SDK full suite: **1250 pass / 0 fail** across 104 files with 5592 assertions.
- SDK packed-install smoke: pass.
- Test-harness typecheck: exit 0.
- Frontend SDK and session-engine boundaries: **3 pass / 0 fail**.
- Full local cold Chromium ACP and REST rollback matrix: **1 pass / 0 fail** in
  2.7 minutes.

**Status:** IMPLEMENTATION COMPLETE.

**Shippable to production: NOT YET.** PR merge, Deploy Dev, and the deployed
cold Chromium matrix remain.
---

### 2026-07-25 — session `acp-opencode-canary` (B21 implementation)

Serialized ACP prompt preparation with OpenCode runtime restarts.
The controller interrupts stalled config-option requests when
`kortix/runtime_ready` changes the runtime generation.
It waits for canonical `session/load` replay and retries only the idempotent
model and mode config preflight.
It does not retry `session/prompt` after dispatch.
It resets the ACP projection before runtime replay.

**RED evidence:**

- Focused controller suite: **13 pass / 2 fail**.
- Runtime replay produced four messages instead of two.
- The interrupted config preflight did not complete within 50 milliseconds.

**Verification:**

- Focused ACP controller suite: **16 pass / 0 fail**.
- SDK typecheck and example typecheck: exit 0.
- SDK full suite: **1253 pass / 0 fail** across 104 files with 5603 assertions.
- SDK packed-install smoke: pass.
- Test-harness typecheck: exit 0.
- `git diff --check`: exit 0.

**Status:** IMPLEMENTATION COMPLETE.

**Shippable to production: NOT YET.** PR merge, Deploy Dev, and the deployed
cold Chromium ACP plus REST rollback matrix remain.
---

### 2026-07-25 — session `false-load-older` (claim)

Claimed the user-reported false `Load older messages` control on a one-turn
session. The investigation will verify the runtime pagination response before
changing the SDK contract. The implementation will follow RED -> GREEN ->
REFACTOR and preserve all exported names.

Required completion gates are the full SDK typecheck, test suite, packed-install
smoke, focused web tests, local browser proof, repository merge, Deploy Dev, and
deployed browser proof.

**Status:** IN PROGRESS.

---

### 2026-07-25 — session `acp-opencode-canary` (B21 delivery completion)

Merged the ACP restart-safe send serialization in PR #5433.
The merge commit is `aedb8c16b1c11baeb501ea9107dfcac083cb8caa`.
All 15 PR checks passed.

Deploy Dev run `30160708566` completed successfully.
The active API reports `0.10.15-dev.85ae91df`.
The active Vercel deployment is `dpl_9M5yptfdDL48vPASvYDt92kQCFtD`.
It is `READY` at commit `85ae91df47da26281dc35d098954567b132f192e`.
Git ancestry proves that both deployed artifacts contain the B21 merge.

The first post-deploy rollback attempt pressed Enter before the REST model list
loaded. Its trace contains zero `/prompt_async` occurrences.
The harness now opens the model picker and waits for `Claude Sonnet 4.6` before
it sends the REST rollback prompt.

The final deployed cold Chromium matrix passed.
It proved ACP chat, SSE reconnect, transcript reload, tool approval, question
input, attachments, queueing, cancellation, slash commands, runtime restart,
post-restart prompt delivery, and REST rollback.

**Final verification:**

- Focused ACP controller suite: **16 pass / 0 fail**.
- SDK full suite: **1253 pass / 0 fail** across 104 files.
- SDK assertions: **5603**.
- SDK typecheck and example typecheck: exit 0.
- SDK packed-install smoke: pass.
- Test-harness typecheck: exit 0.
- PR #5433 checks: **15 pass / 0 fail**.
- Deployed cold ACP and REST Chromium matrix: **1 pass / 0 fail** in 3.3 minutes.

**Status:** COMPLETE.

**Shippable to production: YES.** ACP and REST rollback pass on deployed dev.

---

### 2026-07-25 — session `voice-sdk-import-recovery` (claim)

Claimed the stale `.channels.meet` SDK test references found by PR #5450.
The implementation already exposes `.channels.voice`.
This correction changes test references only.

Required completion gates are SDK typecheck, full tests, packed-install smoke,
PR merge, and Deploy Dev.

**Status:** IN PROGRESS.

---

### 2026-07-25 — session `voice-sdk-import-recovery` (implementation)

PR #5450 supplied the RED state.
The SDK typecheck failed because the voice change removed the public
`.channels.meet` compatibility surface.

Restored `.channels.meet` as a deprecated compatibility facade.
Kept `.channels.voice` as the current voice surface.
Restored the five removed REST compatibility tests.

**Verification:**

- SDK typecheck: exit 0.
- SDK full suite: **1254 pass / 0 fail** across 104 files.
- SDK assertions: **5608**.
- SDK packed-install smoke: pass.
- `git diff --check`: exit 0.

**Status:** IMPLEMENTATION COMPLETE.

**Shippable to production: NOT YET.** PR merge, Deploy Dev, and deployed web
verification remain.

---

### 2026-07-25 — session `whitelabel-acp-reference` (claim)

Claimed the full white-label ACP and SDK reference-app refactor.
The SDK will add the provider-neutral `default_agent` project-config field.
The legacy `open_code_default_agent` field will remain as a deprecated alias.

The reference app will use one `createKortix` client and one `useSession`
runtime path.
Client code will not import runtime transports, legacy runtime stores, or
OpenCode packages.
Client code will not construct Kortix REST or runtime proxy requests.
Project settings will render the server-provided experimental-feature catalog.

Implementation will follow RED -> GREEN -> REFACTOR.
Required gates are the SDK suite, SDK typecheck, packed-install smoke,
white-label typecheck, build, full E2E suite, deterministic boundary tests,
real ACP browser proof, REST rollback proof, PR merge, Deploy Dev, and deployed
artifact verification.

**Status:** IN PROGRESS.

---

### 2026-07-25 — session `whitelabel-acp-reference` (local completion)

Completed the SDK-only white-label ACP reference implementation.

The white-label application uses one `createKortix` client and one
`useSession` path. Application code does not import OpenCode packages,
runtime transports, legacy runtime stores, or SDK source files.

The wrapper BFF delegates HTTP forwarding to the SDK-owned
`forwardKortixRequest()` function. White-label BFF tests use
`createScopedKortix()` from `@kortix/sdk/server`. Repository Playwright specs
also import the public SDK entry point.

The boundary scanner covers application source, local tests, and repository
Playwright specs. It rejects raw Kortix transport calls, SDK source imports,
OpenCode imports, runtime proxy URLs, OpenCode REST paths, provider terms,
legacy runtime stores, and direct runtime imports.

ACP question requests remain pending without a timeout. Fresh subscribers
receive unresolved questions. The daemon accepts the first client response
and suppresses duplicate or late responses.

ACP tool projections preserve native tool names, output text, output metadata,
and reference-compatible labels. Projection resets preserve requests received
during `session/load`.

Local verification:

- SDK typecheck: exit 0.
- SDK suite: **1259 pass / 0 fail** with **5627** assertions.
- SDK packed-install smoke: pass.
- Sandbox daemon typecheck and build: exit 0.
- Sandbox daemon suite: **293 pass / 0 fail** with **704** assertions.
- White-label typecheck and build: exit 0.
- White-label suite: **56 pass / 3 skip / 0 fail** with **181** assertions.
- White-label SDK boundary: **0 violations**.
- API typecheck: exit 0.
- Repository test-harness typecheck: exit 0.
- `git diff --check`: exit 0.
- Real ACP and REST presentation plus question parity: **1 pass** in
  **11.9 minutes**.
- Real project-settings ACP-to-REST rollback: **1 pass** in **1.2 minutes**.
- Test cleanup archived **15** projects through SDK methods.
- Post-cleanup database proof: `active_projects=0`, `cleanup_users=0`.

The final boundary review found two Playwright imports of
`packages/sdk/src/node/server`. The RED test reported **10 pass / 1 fail**.
Both specs now import `@kortix/sdk/server`. The GREEN run reports
**11 pass / 0 fail**. Playwright lists both specs with the public package
import.

**Status:** IMPLEMENTATION COMPLETE.

**Shippable to production: NOT YET.** Rebase, full post-rebase gates, PR merge,
Deploy Dev, deployed SHA proof, and deployed ACP plus REST parity remain.

---

### 2026-07-25 — session `whitelabel-acp-reference` (CI repair)

PR #5458 exposed two delivery defects.

The root `@kortix/sdk` development dependency broke the reduced API Docker
workspace. The dependency now belongs to the minimal `tests/e2e` workspace.
Both Playwright specs import the public `@kortix/sdk/server` entry point.

The first package-unit run timed out while the mode suite built Next.js and
started two servers. The setup limit is now 120 seconds. Test assertions remain
unchanged.

Post-repair verification:

- SDK typecheck: exit 0.
- SDK suite: **1259 pass / 0 fail** with **5629** assertions.
- SDK packed-install smoke: pass.
- White-label suite: **57 pass / 3 skip / 0 fail** with **182** assertions.
- White-label SDK boundary: **0 violations**.
- Repository test-harness typecheck: exit 0.
- Playwright collection: **2 tests in 2 files**.
- API self-host Docker build: exit 0.
- `git diff --check`: exit 0.

**Status:** IMPLEMENTATION COMPLETE.

**Shippable to production: NOT YET.** PR merge, Deploy Dev, deployed SHA proof,
and deployed ACP plus REST parity remain.

---

### 2026-07-26 — session `use2-session-readiness` (B26 and B27 claim)

Claimed two notification regressions found during live US shadow verification.

- Warm-session configuration mismatches must remain recoverable without a
  global error notification.
- All-account project queries must let React Query retry transient failures
  without a global error notification.

Implementation will follow RED -> GREEN -> REFACTOR. Required gates are focused
SDK tests, full SDK typecheck, suite, packed-install smoke, web lint, PR merge,
Deploy Dev SHA proof, and US shadow verification.

**Status:** IN PROGRESS.

---

### 2026-07-26 — session `api-latency-refactor` (B24 and B25 claims)

Claimed two additive React SDK changes.

B24 adds an optional server-authorized initial OpenCode session pin. The pin
starts IndexedDB transcript hydration before `/start` completes. The `/start`
pin remains authoritative.

B25 starts the compact project model-picker request in parallel with project
detail. Native projects continue to wait for runtime readiness.

Implementation follows RED -> GREEN -> REFACTOR. Required gates are SDK
typecheck, the full SDK suite, packed-install smoke, focused web tests, local
browser proof, PR merge, Deploy Dev, deployed SHA proof, and deployed browser
proof.

**Status:** IN PROGRESS.

**Shippable to production: NOT YET.**

---

### 2026-07-26 — session `api-latency-refactor` (B24 and B25 local completion)

Completed the additive initial-session pin and parallel model-picker changes.

RED evidence:

- The initial-pin test failed because `resolveSessionPin()` did not exist.
- The provider plan test failed because the model-picker waited for project
  detail.
- The web session-load test failed because cached transcript content could not
  mount before the runtime switch completed.
- The provider-loading test failed because the modal waited for runtime
  provider discovery after project detail and secrets had resolved.

Post-rebase gates:

- SDK typecheck: exit 0.
- SDK suite: **1275 pass / 0 fail** with **5669** assertions across **107**
  files.
- SDK packed-install smoke: pass.
- Web suite: **2207 pass / 0 fail** with **5970** assertions across **244**
  files.
- Focused web ESLint: exit 0.
- API typecheck: exit 0.
- Focused isolated API tests: **67 pass / 0 fail**.
- Sandbox-agent typecheck: exit 0.
- Sandbox-agent suite: **298 pass / 0 fail** with **720** assertions.

Live local execution-lease proof:

- `acquire`: HTTP 200 in **33.9 ms**. The response and database stored the same
  `executionLeaseUntil`.
- `renew`: HTTP 200 in **20.8 ms**. The response and database stored the same
  `executionLeaseUntil`.
- `release`: HTTP 200 in **21.3 ms**. The database stored
  `executionLeaseUntil = null`.

Browser discovery returned no available browser. Local DOM and browser-network
verification remains open.

**Status:** IMPLEMENTATION COMPLETE.

**Shippable to production: NOT YET.** PR merge, Deploy Dev, deployed SHA proof,
and deployed browser verification remain open.

---

### 2026-07-26 — session `api-latency-refactor` (B24 and B25 delivery completion)

PR #5490 merged into `main`.
The merge commit is `4f46e3aafdd02d43bbb022a28fd17fcfb94baeb5`.
All PR checks passed.

Deploy Dev run `30204286487` completed successfully.
The run head is the full merge commit.
The API EKS and ECS rollouts used image tag `dev-4f46e3aa`.
The frontend retag used the full merge commit.
The live API health response reports `0.10.16-dev.4f46e3aa`.

Deployed API contract proof:

- An unauthenticated `POST /v1/projects/x/execution-lease` returned `401`.
- The disposable live verifier returned `200` for `acquire`, `renew`, and
  `release`.
- The verifier measured **2807.1 ms**, **598.4 ms**, and **534.0 ms**.
- Acquire and renew response timestamps matched `executionLeaseUntil` in the
  dev database.
- Release stored `executionLeaseUntil = null`.

Deployed sandbox-agent proof used Daytona snapshot
`kortix-default-631f50320491`.
Disposable session `07729779-f350-4af0-b46f-f727d91859f6` entered `busy` after
a real OpenRouter prompt.
CloudWatch recorded:

- One bootstrap-pin `turn-stream` request: `200` in **885 ms**.
- One lease `acquire` request: `200` in **793 ms**.
- One lease `release` request: `200` in **266 ms**.
- The gateway completed the model request with `200` in **2521 ms** and
  returned **808 tokens**.

CloudWatch Insights query
`dd8a17dd-bc08-4fdc-bc83-b0e8bfa21be5` covers the post-deploy window beginning
at `2026-07-26T13:44:00Z`.
It found **6** `execution-lease` requests across **3** disposable projects:
**266 ms p50**, **2005 ms p95**, **2005 ms p99**, and **603.2 ms average**.

CloudWatch Insights query
`874b0176-dc50-44ab-ab70-efdee3ac7268` covers the same window.
It found **227** `turn-stream` requests across **5** projects:
**260.9 ms p50**, **2006.6 ms p95**, **3001.9 ms p99**, and **593.0 ms
average**.
Three pre-existing sandboxes continued the legacy 20-second heartbeat.
New sandboxes use `execution-lease`; existing sandboxes retain their old daemon
until they stop or restart.

The deployed infrastructure-only session smoke completed **20 passes / 1
failure**.
The deployed busy-turn smoke completed **22 passes / 3 failures**.
Both smokes provisioned a real managed repository, built or reused the new
Daytona snapshot, started a real sandbox, reached OpenCode, and cleaned up.
The shared failures were `POST /git-token` returning `503`.
The busy-turn smoke also found no assistant text in the OpenCode message
response, although the gateway completed the model request with `200`.

Cleanup proof:

- Both disposable projects have status `archived`.
- Both disposable sessions have status `stopped` and a `deletedAt` timestamp.
- Both disposable sandboxes have status `archived` and a `stoppedAt` timestamp.
- Both disposable Supabase users were deleted with status `200`.

Browser discovery returned `[]` after troubleshooting.
Deployed DOM and browser-network verification remains open.

**Status:** MERGED AND DEPLOYED TO DEV.

**Shippable to production: NOT YET.** The deployed lease path passes.
Deployed browser verification, the `git-token` `503`, and the missing
assistant-text result remain open.

---

### 2026-07-26 — session `whitelabel-acp-stable-completion` (B23 delivery completion)

Merged B23 in PR #5477.
The merge commit is `480a44dcb9c6fce4f1f51c54dcb017750d187bdb`.
All PR checks passed: **15 pass / 0 fail** with **11** path-filtered checks.

Deploy Dev run `30184932143` completed successfully.
The API health response reports `0.10.16-dev.480a44dc`.
The API EKS rollout used image tag `dev-480a44dc`.
The frontend image tag references the full merge SHA.

Vercel deployment `dpl_FX4EmhvavKet4MvwcDyjVeqxZWdD` is ready.
GitHub maps that deployment to the full merge SHA.
The deployment owns the `dev.kortix.com` alias.

The final deployed ACP and REST presentation plus question matrix passed:

- Playwright: **1 pass / 0 fail** in **13.8 minutes**.
- ACP sent **2** ACP prompts and **0** REST prompts.
- REST sent **2** REST prompts and **0** ACP prompts.
- ACP rendered **28** completed tool cards.
- REST rendered **24** completed tool cards.
- Tool-card parity ratio: **0.857**.
- ACP created `/workspace/marko-kraemer.pptx` at **250,193 bytes**.
- REST created `/workspace/marko-kraemer.pptx` at **237,913 bytes**.
- Both transports persisted the question flow and rendered `QUESTION_BETA`.
- Post-cleanup database proof: `active_projects=0`, `cleanup_users=0`.

**Status:** COMPLETE.

**Shippable to production: YES.** ACP and REST stable completion pass on
deployed dev.

---

### 2026-07-25 — session `whitelabel-acp-reference` (runtime freshness follow-up)

The merged reference app exposed two live-path defects.

Project provisioning used the shared 30-second request timeout. Real sandbox
provisioning exceeded that limit. `projects.provision()` now accepts request
options and defaults to 120 seconds.

ACP startup accepted a stale last-known-good daemon snapshot while rebuilding the
current snapshot. That daemon dropped unresolved ACP questions after 120 seconds.
ACP sessions now require the current content-addressed runtime snapshot. REST
sessions retain the last-known-good compatibility policy.

TDD evidence:

- Provisioning request options and default timeout: RED before `6c9db9051`,
  GREEN after `6c9db9051`.
- Runtime-freshness module: **0 pass / 1 fail** before implementation.
- Session-sandbox policy: **9 pass / 2 fail** before implementation.
- Runtime-freshness module: **3 pass / 0 fail** after implementation.
- Session-sandbox policy: **11 pass / 0 fail** after implementation.

Post-fix verification:

- SDK typecheck: exit 0.
- SDK suite: **1260 pass / 0 fail** with **5630** assertions.
- SDK packed-install smoke: pass.
- API typecheck: exit 0.
- White-label typecheck and production build: exit 0.
- White-label suite: **57 pass / 3 skip / 0 fail** with **182** assertions.
- White-label SDK boundary: **0 violations**.
- Real local ACP and REST presentation plus question parity: **1 pass** in
  **12.4 minutes**.
- The ACP question remained visible after 121 seconds and a page reload.
- Both transports submitted Beta and rendered `QUESTION_BETA`.
- ACP used `session/prompt` and sent zero `/prompt_async` requests.
- REST used `/prompt_async` and sent zero `/kortix/acp/` requests.
- Post-cleanup database proof: `active_projects=0`, `cleanup_users=0`.
- `git diff --check`: exit 0.

**Status:** FOLLOW-UP IMPLEMENTATION COMPLETE.

**Shippable to production: NOT YET.** Follow-up PR merge, Deploy Dev, deployed
SHA proof, and deployed ACP plus REST parity remain.
---

### 2026-07-26 — session `whitelabel-acp-reference` (deployed parity completion)

The first deployed parity run exposed a fixture funding defect.
The test changed only `credit_accounts.balance`.
Billing reads `balance_precise` and `non_expiring_credits_precise`.
Both precise fields retained the default `$1.00` balance.

The corrected fixture seeds `$100.00` into the rounded and precise wallet
fields. The test rejects `Out of credits`.

The deployed screenshot comparison also exposed a REST synchronization defect.
The REST prompt reached `/prompt_async`, but the UI became idle before the first
SSE status event. The SDK did not start its 10-second reconciliation fallback.
The transcript therefore contained only the user message at the screenshot
point.

`useSession()` now marks an accepted REST prompt busy before the first SSE event.
The session synchronization controller polls the transcript and runtime status
until the runtime reports idle. Failed sends and explicit cancellation clear the
optimistic busy state.

The parity specification now requires:

- one rendered assistant message per transport;
- one rendered tool card per transport;
- no `Out of credits` transcript;
- ACP question persistence after 121 seconds and reload;
- `QUESTION_BETA` after both question replies;
- zero REST prompt calls from ACP;
- zero ACP prompt calls from REST.

TDD evidence:

- Deployed screenshot RED: REST had no assistant message or tool card.
- Focused unit RED: missing `beginRestPromptObservation` export.
- Focused unit GREEN: **20 pass / 0 fail** with **43** assertions.

Final verification:

- SDK typecheck and example typecheck: exit 0.
- SDK suite: **1261 pass / 0 fail** with **5632** assertions.
- SDK packed-install smoke: pass.
- White-label typecheck and dev-API production build: exit 0.
- White-label suite: **57 pass / 3 skip / 0 fail** with **182** assertions.
- White-label SDK boundary: **0 violations**.
- Test-harness typecheck: exit 0.
- Strong deployed ACP and REST presentation plus question parity:
  **1 pass / 0 fail** in **14.1 minutes**.
- ACP sent **2** ACP prompts and **0** REST prompts.
- REST sent **2** REST prompts and **0** ACP prompts.
- ACP rendered **29** real tool cards.
- REST rendered **32** real tool cards.
- Both screenshots contain completed presentation tool sequences.
- Both transports submitted Beta and rendered `QUESTION_BETA`.
- The stale project `81050937-bc7f-4b05-aafb-914acc019fe4` was archived
  through `@kortix/sdk`.
- Post-cleanup database proof: `active_projects=0`, `cleanup_users=0`.
- `git diff --check`: exit 0.

**Status:** DEPLOYED PARITY COMPLETE.

**Shippable to production: NOT YET.** The synchronization correction still
requires PR merge, Deploy Dev, deployed SHA proof, and one post-deploy smoke.

---

### 2026-07-26 — session `whitelabel-acp-stable-completion` (B23 claim)

Claimed the intermittent ACP false-completion gap exposed by the deployed
white-label parity screenshots.

The SDK will keep prompt completion monotonic across the JSON-RPC result and
late ACP tool, text, or reasoning updates. The parity gate will require stable
completion and a complete presentation artifact on both transports.

Implementation will follow RED -> GREEN -> REFACTOR. Required gates are the
focused SDK test, full SDK typecheck, suite, packed-install smoke, white-label
typecheck, build, suite, SDK boundary, test-harness typecheck, local ACP and REST
parity, PR merge, Deploy Dev, deployed SHA proof, and deployed parity.

**Status:** IN PROGRESS.

---

### 2026-07-26 — session `agent-sandbox-environments` (claim)

Claimed the user-directed per-agent sandbox environment contract. The additive
SDK field will expose `agents.<name>.sandbox` from `kortix.yaml`. Session
creation will resolve an explicit session override first, then the selected
agent environment, then the project default, then the platform default.

The central session path will apply this contract to manual sessions, triggers,
schedules, and channels. Replacement runtimes will retain the resolved sandbox
template. Existing public names and required fields remain unchanged.

Implementation will follow RED -> GREEN -> REFACTOR. Required SDK gates are the
full typecheck, test suite, and packed-install smoke.

**Status:** IMPLEMENTED — `7174dddc4`.

---

### 2026-07-26 — session `agent-sandbox-environments` (completion)

Added `agents.<name>.sandbox` as an optional SDK and manifest field. The server
now resolves session templates in this order:

1. Explicit session `sandbox_slug`.
2. Selected agent `sandbox`.
3. Project `sandbox.default`.
4. Platform `default`.

The central session-create path applies the result to manual sessions,
triggers, schedules, and channels. The server persists the resolved slug in
`project_sessions.metadata.sandbox_slug`. Runtime-open, unmaterialized-runtime
replacement, and restart allocation paths reuse this persisted value. Custom
templates cannot boot through a pinned project-default external template ID.

The dashboard agent editor now exposes the field as **Environment**. The new
session composer now sends `sandbox_slug` only for an explicit user override.
Manifest validation checks slug syntax. The agent-config API checks the slug
against manifest-defined and dashboard-managed templates before committing it.

TDD evidence:

- Manifest RED: `agents.researcher.sandbox` was not part of the v2 schema.
- API parser RED: the parsed `AgentSpec` had no `sandbox` value.
- Precedence RED: the new `session-sandbox-metadata` module did not exist.
- Provider RED: a custom image still selected the pinned default template ID.
- SDK RED: `AgentConfigBlock` rejected `{ sandbox: "ml" }`.
- Web RED: the agent editor had no environment control and the composer sent
  the project default as an explicit override.
- GREEN: manifest **324 pass / 0 fail**.
- GREEN: focused API **66 pass / 0 fail**.
- GREEN: focused web **17 pass / 0 fail**.
- GREEN: starter **45 pass / 0 fail**.

SDK gates:

- `pnpm --filter @kortix/sdk typecheck`: exit 0.
- `pnpm --filter @kortix/sdk test`: **1262 pass / 0 fail**, **5633**
  assertions.
- `pnpm --filter @kortix/sdk run smoke:install`: packed install and Node ESM
  import passed.

Additional gates:

- `pnpm --filter @kortix/manifest-schema typecheck`: exit 0.
- `pnpm --filter kortix-api typecheck`: exit 0.
- Focused web ESLint: exit 0.
- `pnpm --filter @kortix/starter typecheck`: exit 0.
- `git diff --check`: exit 0.

Real local proof used disposable project
`d6a155db-3ab5-44b2-aa26-0ffb7df42042`:

- Agent-config GET returned `block.sandbox = "ml"`.
- Manual session `e4ef1acd-44cb-4ad8-934a-169b95b7d4ca` persisted `ml`.
- Scheduled session `bddc4c18-de6b-485f-bb5b-32aaadcc2f85` persisted `ml`.
- Explicit override session `c046cc69-68b7-4ef1-8d05-ecd41dce1dde`
  persisted `default`.
- Both inherited sessions reached `active` on Platinum.
- Both inherited sessions used content hash
  `3e41f3954ec150c409e145f73c22de3c335f534713ea39981b562805bbc781bf`.
- Restarting the two unmaterialized rows allocated runtimes with the persisted
  `ml` environment.
- Established runtime identity remains immutable. Provider-confirmed loss
  returns `409 SESSION_RUNTIME_IDENTITY_UNAVAILABLE`; it does not create a
  replacement with a different external ID.
- Cleanup archived all three session rows, removed all three provider
  sandboxes, deleted the template, purged the managed repository, archived the
  project, and deleted the Supabase user.

Browser discovery returned `[]`. The Environment selector interaction, outgoing
PUT payload, and saved visible value remain unverified in a real browser.

**Shippable to production: YES.** The implementation, SDK package, API path,
provider allocation, generated schemas, starter artifact, and source-level web
contract pass. Browser interaction remains a deployment verification item.

---

### 2026-07-26 — session `warm-project-session` (B22 claim)

Claimed the additive SDK surface for server-owned warm project sessions.

The API will enforce one available empty warm session per project and user.
The project index will prefetch its runtime and claim it before navigation.
The existing daemon refresh operation will synchronize a reused warm workspace
to the latest base branch without restarting OpenCode.

Implementation will follow RED -> GREEN -> REFACTOR.
Required gates are SDK typecheck, full SDK tests, packed-install smoke, API tests,
ke2e coverage, local API proof, browser proof, PR merge, Deploy Dev, deployed SHA
proof, and deployed browser proof.

**Status:** COMPLETE — `13167d7cf`.

---

### 2026-07-26 — session `whitelabel-acp-stable-completion` (B23 local completion)

Completed the monotonic ACP and REST prompt-settlement implementation in
`7a546585c`.

ACP `send()` now resolves after the prompt result and a 500-millisecond quiet
period. Late assistant, tool, question, and permission updates restart or block
that settlement. Prompt queue serialization waits for full settlement.

REST prompt observation now belongs to `SessionSyncController`. Premature idle
events do not clear the public busy state. Late busy events cancel the
500-millisecond settlement timer. Status reconciliation and SSE events use the
same controller.

TDD evidence:

- ACP RED: `send()` resolved before delayed tool updates reached the transcript.
- REST RED: `beginPromptObservation()` did not exist.
- Focused REST GREEN: **40 pass / 0 fail** with **113** assertions.
- Preview RED: expected status `200`; received `502`.
- Preview GREEN: **7 pass / 0 fail** with **36** assertions.

Post-rebase gates:

- SDK typecheck: exit 0.
- SDK suite: **1268 pass / 0 fail** with **5662** assertions across **105**
  files.
- SDK packed-install smoke: pass.
- White-label typecheck: exit 0.
- White-label suite: **57 pass / 3 skip / 0 fail** with **182** assertions.
- White-label SDK boundary: **0 violations**.
- White-label dev-API production build: exit 0.
- Test-harness typecheck: exit 0.
- `git diff --check`: exit 0.

Post-rebase live ACP and REST presentation plus question parity:

- Playwright: **1 pass / 0 fail** in **13.5 minutes**.
- ACP sent **2** ACP prompts and **0** REST prompts.
- REST sent **2** REST prompts and **0** ACP prompts.
- ACP rendered **34** completed tool cards.
- REST rendered **28** completed tool cards.
- Tool-card parity ratio: **0.824**.
- ACP created `/workspace/marko-kraemer.pptx` at **231,898 bytes**.
- REST created `/workspace/marko_kraemer.pptx` at **228,064 bytes**.
- Both transports persisted the question flow and rendered `QUESTION_BETA`.
- Post-cleanup database proof: `active_projects=0`, `cleanup_users=0`.

**Status:** IMPLEMENTATION COMPLETE.

**Shippable to production: NOT YET.** PR merge, Deploy Dev, deployed SHA proof,
and deployed ACP plus REST parity remain.

---

### 2026-07-26 — session `use2-session-readiness` (B26 and B27 completion)

Completed both US shadow readiness fixes in PR #5529.

- `claimWarmProjectSession()` keeps the recoverable configuration `409` out of
  the global error sink.
- The IAM custom-policy read retries one transient database failure.
- Database error logging extracts the nested PostgreSQL cause from a wrapped
  `DrizzleQueryError`.
- The US shadow deployment requires managed models.

Verification:

- Merge commit: `5c0ae97ec7676f3cd439f7f19db154b53602feda`.
- Deploy Dev run `30222230764`: success for the exact merge commit.
- SDK typecheck: exit 0.
- SDK suite: **1280 pass / 0 fail** with **5707** assertions.
- SDK packed-install smoke: pass.
- API typecheck: exit 0.
- Focused API tests: **40 pass / 0 fail** with **82** assertions.
- US API: `0.10.16-dev.5c0ae97e`.
- US ECS API: task definition revision `11`, desired `2`, running `2`,
  pending `0`, rollout `COMPLETED`.
- US frontend: Vercel deployment
  `dpl_DSe54pvhXpCgUyG7wVWnb7VdNm9M`.
- Deployed real runtime flow: exact `PONG` and Files view loaded.
- Deployed warm mismatch flow: typed `409`, normal session creation, exact
  `PONG`, no global mismatch error, **27.4 seconds**.

Production routing and production data were unchanged.

**Status:** COMPLETE.

**Shippable to production: YES.**

---

### 2026-07-27 — session `acp-message-turns` (B29 implementation)

Preserved ACP upstream `messageId` values in the projected transcript.

- User and assistant chunks now retain their upstream message IDs.
- Text and reasoning chunks now update their owning assistant message.
- A new upstream assistant message completes the previous assistant message.
- Late tool updates now find the assistant message that owns the matching
  `callID`.
- ACP events without `messageId` still use generated IDs.

TDD and local verification:

- Implementation commit: `60b06c6e41f82d786f24095d366876483af85b68`.
- Focused projection and controller suite: **27 pass / 0 fail** with **75**
  assertions.
- SDK typecheck: exit 0.
- SDK suite: **1299 pass / 0 fail** with **5756** assertions.
- SDK packed-install smoke: pass.
- `git diff --check`: exit 0.
- Supplied transcript replay produced **1** user message and **18** separate
  assistant messages.
- The replay preserved upstream assistant IDs and tool-call ownership.
- Local Chromium ACP flow: **1 pass / 0 fail** in **58.3 seconds**.
- The browser flow covered prompt streaming, hard reload, permission response,
  question response, and the absence of REST `/prompt_async`.

**Status:** IMPLEMENTATION COMPLETE.

**Shippable to production: NOT YET.** PR merge, Deploy Dev, deployed SHA proof,
and deployed ACP transcript verification remain.

---

### 2026-07-27 — session `session-message-revert` (B30 local completion)

Implemented message-based session rewind and restore in `eab4eef0f`.

The implementation keeps one canonical OpenCode session. It does not create a
fork. Native REST uses `session.revert` and `session.unrevert`. ACP uses the
Kortix `session/revert` and `session/unrevert` extensions. The daemon forwards
both ACP extensions to native OpenCode history routes.

ACP transcript replay preserves native OpenCode message IDs. The controller
resolves an optimistic `acp-user-*` ID to its canonical `msg_*` ID before
rewind. REST transcript synchronization keeps removed messages hidden until
cleanup completes. The next accepted prompt commits the replacement path.

`useSession` now exposes `rewindMessageId`, `rewindPending`, `rewindError`,
`rewind(messageId)`, and `restoreRewind()`. The web session UI adds Edit,
confirmation, replacement composer prefill, staged-rewind status, and Restore.

TDD evidence:

- RED: the core rewind projection helper did not exist.
- RED: the ACP client had no revert or unrevert extension methods.
- RED: ACP transcript replay generated local IDs instead of native `msg_*` IDs.
- RED: the ACP controller had no reversible rewind state.
- RED: `useSession` had no provider-agnostic rewind contract.
- RED: the web message action still contained `TODO(session-rewind)`.
- GREEN focused SDK, daemon, and web suite: **145 pass / 0 fail**.
- GREEN ACP controller after optimistic-ID resolution: **20 pass / 0 fail**.

SDK gates:

- `pnpm --filter @kortix/sdk typecheck`: exit 0.
- `pnpm --filter @kortix/sdk test`: **1309 pass / 0 fail**, **5779**
  assertions across **111** files.
- `pnpm --filter @kortix/sdk run smoke:install`: packed install and Node ESM
  import passed.

Daemon and web gates:

- `pnpm --filter @kortix/sandbox-agent-server typecheck`: exit 0.
- `pnpm --filter @kortix/sandbox-agent-server test`: **306 pass / 0 fail**,
  **739** assertions across **33** files.
- Web source contract: **5 pass / 0 fail**, **11** assertions.
- Touched web ESLint: exit 0.
- Web `tsc --noEmit`: zero errors in the three touched session files. Two
  existing errors remain in `template-url.test.ts`.
- `git diff --check`: exit 0.

Local browser proof:

- Playwright ACP runtime canary: **1 pass / 0 fail**. The test ran for **1.6
  minutes**. Total runtime was **6.8 minutes** including snapshot provisioning.
- The canary verified Edit, destructive confirmation, `session/revert`,
  transcript truncation, replacement prefill, Restore, `session/unrevert`,
  replacement send, and old-path deletion.

Live local REST and ACP proof used one disposable canonical OpenCode session:

- ACP session: `ses_05b51aa3affeB0XyuUkhYt8L6n`.
- ACP rewind message: `msg_fa4ae82cc001LquUy2MNmLt5T5`.
- ACP restore: `true`.
- ACP replacement: `true`.
- ACP file result: `ACP_REWIND_REPLACEMENT`.
- REST session: `ses_05b51aa3affeB0XyuUkhYt8L6n`.
- REST rewind message: `msg_fa4aed6ad001VvRt8OASgvwlmU`.
- REST restore: `true`.
- REST replacement: `true`.
- REST file result: `REST_REWIND_REPLACEMENT`.
- Smoke result: `PASS`.

**Status:** LOCAL IMPLEMENTATION COMPLETE.

**Shippable to production: NOT YET.** PR merge, Deploy Dev, deployed SHA proof,
and deployed REST, ACP, and web verification remain.

---

### 2026-07-27 — session `acp-idle-query-override` (B31 claim)

Claimed the ACP page override and stale-tool settlement defect.

`?acp` will override the server-selected runtime transport for one session page.
It will not mutate `experimental.acp_runtime`.
The SDK will keep genuine active tools busy.
The SDK will settle stale running tools after a newer assistant message and the
final prompt result.
Queued prompts will dispatch after settlement.

Implementation will follow RED -> GREEN -> REFACTOR.
Required gates are focused SDK and web tests, full SDK typecheck, full SDK suite,
packed-install smoke, local Chromium ACP proof, PR merge, Deploy Dev, deployed SHA
proof, and deployed ACP-only network proof.

**Status:** IN PROGRESS.

---

### 2026-07-27 — session `acp-idle-query-override` (B31 local completion)

Implemented page-scoped ACP transport selection and stale-tool settlement in
`d3544ae14`.

`UseSessionOptions.runtimeTransport` is an additive per-hook override.
The session page passes `acp` only when the URL contains `?acp`.
The page does not mutate `experimental.acp_runtime`.
The SDK policy keeps one AI transport mounted.
The ACP policy disables OpenCode REST events, session listing, message sync, and
`promptAsync`.

A newer assistant message now closes unresolved tools from the previous assistant
message.
The 500-millisecond quiet period still blocks early idle while the current
assistant message contains a genuine active tool.
Queued prompts dispatch after stale tools settle.
Transcript reload starts idle when an older assistant message contains a stale
running tool.

TDD evidence:

- RED focused SDK: **36 pass / 4 fail**.
- RED web routing contract: **4 pass / 1 fail**.
- GREEN focused SDK: **40 pass / 0 fail**.
- GREEN web routing contract: **5 pass / 0 fail**.

Required gates:

- `pnpm --filter @kortix/sdk typecheck`: exit 0.
- `pnpm --filter @kortix/sdk test`: **1312 pass / 2 skip / 0 fail** with
  **5785** assertions across **111** files.
- `pnpm --filter @kortix/sdk run smoke:install`: packed install and Node ESM
  import passed.
- Touched web ESLint: exit 0.
- Web `tsc --noEmit`: no errors reference the touched files. Existing unrelated
  repository errors keep the full command at exit 1.
- `git diff --check`: exit 0.

The ACP browser canary now opens a server-selected REST session with `?acp`,
asserts ACP-only AI traffic, then removes `?acp` and asserts REST rollback.
The in-app browser runtime returned no available browsers.
The local Chromium canary remains unexecuted.

**Status:** IMPLEMENTATION COMPLETE.

**Shippable to production: NOT YET.** PR merge, Deploy Dev, deployed SHA proof,
and deployed UI verification remain.

---

### 2026-07-28 — session `acp-session-name-sync` (B32 claim)

Claimed the Kortix session-name synchronization defect for ACP-backed sessions.

The investigation will trace the authoritative server-side title mirror,
ACP runtime session metadata, project-session reads, SDK query invalidation,
and sidebar rendering.

Implementation will follow RED -> GREEN -> REFACTOR.
Required gates are focused API, SDK, and web tests, API and SDK typechecks,
the full SDK suite, packed-install smoke, local browser proof, PR merge,
Deploy Dev, deployed SHA proof, and deployed session-name synchronization.

**Status:** IN PROGRESS.

---

### 2026-07-28 — session `acp-multi-harness` local completion

Implemented project-gated ACP transport and OpenCode, Claude Code, Codex, and Pi
harness support.

The existing `acp_runtime` experiment is the single rollout gate.
The visible experiment name is `ACP & Multi-Harness`.
Project manifests use `kortix_version: 3` runtime profiles and logical agents.
Project-session ACP identity is immutable.
ACP envelopes persist in PostgreSQL with database ordinals as SSE cursors.
Upstream deduplication is scoped by runtime instance.
Triggers and automations deliver ACP prompts through the durable session
lifecycle queue.

A cold Daytona snapshot took `379,773 ms`.
The previous detached initial-prompt delivery stopped after `300,000 ms`.
The durable queue fix now survives this cold-build window.

Local verification:

- Daemon suite: exit `0`.
- Daemon typecheck: exit `0`.
- API ACP tests: **28 pass / 0 fail** with **77** assertions.
- API typecheck: exit `0`.
- SDK typecheck: exit `0`.
- SDK suite: **1347 pass / 0 fail** with **5855** assertions across **113**
  files.
- SDK packed-install smoke: pass.
- Manifest, shared, API-contract, CLI schema, and web helper gates: exit `0`.
- Route coverage: **507/517** routes, **10** allowlisted, **0** uncovered.
- `COV-10`: **1/1** passed against `http://localhost:19108/v1`.
- Real Daytona smoke: **4/4** harnesses passed.
- Smoke cleanup: OpenCode, Claude Code, Codex, and Pi sessions are `stopped`
  with `deletedAt`.
- Touched web ESLint: exit `0`.
- `git diff --check`: exit `0`.

The connected-provider row no longer renders the model-dependent provider-key
verification action.
The backend verification route remains available for existing SDK consumers.

The in-app browser runtime returned no available browsers.
Rendered agent selection and provider-row verification remain unexecuted.

**SDK shippable to production: YES.**

**Feature delivery status: NOT YET.**
PR merge, Deploy Dev, deployed SHA proof, and deployed protocol verification
remain.

---

### 2026-07-28 — session `acp-multi-harness` deployed completion

Completed repository delivery and deployed protocol verification.

PR #5749 merged as `239cda8a2c7b8e3862cae5d968224c1baf1d0a02`.
Its 25 executed checks passed.
The superseding Deploy Dev run `30402685106` deployed API and frontend commit
`8e86e27d045b8349eaf7dc9cfba47086e93cfaf8`.
Git confirmed that the feature merge is an ancestor of that deployed commit.

The first deployed smoke found two environment and restart conditions:

- The dev platform OpenAI key returned `401 invalid_api_key`.
- A Daytona stop/start changed its preview ingress credential.
  Another API replica could retain the old credential for five minutes.

The smoke runner now accepts a disposable project model override and an optional
temporary OpenAI key.
The local encrypted OpenAI key returned HTTP `200` from `GET /v1/models`.
PR #5759 added one ACP ingress refresh-and-retry after `401` or `403`.
It also retries prompt env synchronization after the same authentication
rejection.
PR #5759 merged as `35d4063c954176338e809abc4329e43410786122`.
Its 15 executed checks passed.
Deploy Dev run `30406252134` completed successfully for that exact SHA.
`GET https://dev-api.kortix.com/v1/health` reported:

- `environment`: `dev`
- `version`: `0.11.1-dev.35d4063c`
- `commit`: `35d4063c954176338e809abc4329e43410786122`

Deployed Daytona protocol smoke against
`https://dev-api.kortix.com/v1` reported:

- OpenCode: pass.
- Claude Code: pass.
- Codex: pass.
- Pi: pass.
- Final result: **4/4 harnesses passed**.

Each harness verified its headless prompt, follow-up prompt, transcript reload,
immutable harness identity, in-place restart, post-restart prompt, and persisted
ACP identity.

The disposable fixture project was
`196ff19b-dfa1-4aae-98eb-9fa5138446b6`.
Cleanup verification found:

- Project status: `archived`.
- OpenCode, Claude Code, Codex, and Pi session status: `stopped`.
- Four session sandbox rows: `archived`.
- Matching sandbox rows: `0`.

The connected-provider row no longer exposes the model-dependent verification
action.
The SDK verification route remains compatible.
The in-app browser runtime exposed no browser.
Rendered provider-row verification remains unexecuted.

**Status:** COMPLETE.

**Shippable to production: YES.** Local suites, CI, merge, deployed SHA,
deployed four-harness protocol behavior, restart recovery, and fixture cleanup
all pass.

---

### 2026-07-28 — session `acp-multi-harness-system-docs` claim

Claimed the multi-harness documentation and agent-discovery follow-up.

The SDK change is documentation-only. It will replace the stale statement that
ACP uses only OpenCode. It will document the server-selected OpenCode, Claude
Code, Codex, or Pi harness without changing the public SDK surface.

Required SDK gates are typecheck, the full test suite, and packed-install smoke.

**Status:** IN PROGRESS.

---

### 2026-07-28 — session `acp-multi-harness-system-docs` local completion

Completed the SDK documentation update for the server-selected OpenCode,
Claude Code, Codex, or Pi harness.

No SDK export or runtime implementation changed.

Final SDK gates:

- `pnpm --filter @kortix/sdk typecheck`: exit `0`.
- `pnpm --filter @kortix/sdk test`: `1356 pass`, `0 fail`,
  `5929 expect() calls`, `116 files`.
- `pnpm --filter @kortix/sdk run smoke:install`: packed tarball imported and
  constructed successfully.

**Status:** COMPLETE.

**SDK package shippable to production: YES.**

**Repository delivery shippable to production: NOT YET.** Main integration,
PR merge, Deploy Dev, deployed SHA proof, and deployed four-harness verification
remain.
