# `@kortix/sdk` — progress

**Single source of truth for *state*** across every session and every plan. Not for
design (that's a spec) and not for *how* (that's a plan). This file indexes them.

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
tests). A file move has *no behaviour to assert* — the only proof you moved files
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

| Stream | Where | Safe? |
|---|---|---|
| The Now chain (Tasks 1→10) | `suna-ts-sdk`, one session | ✅ — parallelise **inside** it with subagents, never across sessions |
| **Lumen productionisation** | a **separate worktree** (`pnpm worktree create --name lumen-prod`) | ✅ — touches `apps/whitelabel-demo/src/server/*` only. Zero overlap with `packages/sdk`. Needs its own spec first. |
| RN transport seam | — | ❌ edits `src/state/event-stream.ts`, the exact file Task 4 moves |
| Backlog B1/B2/B3 | — | ❌ all add exports; collides with Task 5's barrel rewrite. Do them **after** Task 5. |

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

## NOW — active plan: v2 structure & distribution

- **Plan:** `docs/superpowers/plans/2026-07-10-sdk-v2-structure-and-distribution.md`
- **Spec:** `docs/superpowers/specs/2026-07-10-sdk-v2-structure-and-distribution-design.md`
- **Kickoff prompt:** `docs/superpowers/plans/2026-07-10-sdk-v2-execution-prompt.md`

**Ordering is load-bearing.** Each task is the safety net for the next. Task 3's
snapshot is the *only* test Task 4 has, because a file move has no behaviour to
assert. **Do not run out of order. Do not parallelise.** Dependencies are strictly
`1 → 2 → … → 10`; only 7, 8 and 10 have slack, and only after 6.


| #   | Task                                                    | Status      | Session    | Last touched | Commit                   |
| --- | ------------------------------------------------------- | ----------- | ---------- | ------------ | ------------------------ |
| 0   | Docs: spec, plan, `AGENTS.md`, prompt, this file        | **DONE**    | `01AzJBSa` | 2026-07-10   | `6cd4d6e4e`              |
| 1   | Assert the two export maps agree                        | **DONE**    | `ab099b6a` | 2026-07-10   | `ecb78a113`              |
| 2   | Install smoke test — pack, install, import              | **DONE**    | `ab099b6a` | 2026-07-10   | `7220e9587`              |
| 3   | Public-export snapshot                                  | **DONE** (snapshot approved by Jay at hard stop #2) | `ab099b6a` | 2026-07-10   | `84e15ca72`              |
| 4   | Axis 1 — internal restructure (`core`/`browser`/`node`) | **DONE**    | `ab099b6a` | 2026-07-10   | `4c6f7102c` (4 commits from `25068d272`) |
| 5   | Axis 2 — root canonical, subpaths deprecated            | **DONE** (snapshot growth accepted by Jay at hard stop #3) | `ab099b6a` | 2026-07-10   | `b5e588dbc`+`aafbdf91b`  |
| 6   | Dogfood `whitelabel-demo` (acceptance gate)             | **DONE**    | `ab099b6a` | 2026-07-10   | `db30c6df3`+`19e500e50`  |
| 7   | Portability — ban bare globals in `core/`               | **DONE**    | `ab099b6a` | 2026-07-10   | `189428df7`+`a485ad401`  |
| 8   | `tsup` bundles — CDN ESM + `window.Kortix`              | **DONE**    | `ab099b6a` | 2026-07-10   | `c7bca7a7e`              |
| 9   | Examples — `07-vanilla.ts`, `08-cdn.html`               | **DONE** (steps 1–5 `549d597a0`, review clean; Step 6 executed 2026-07-12 — D2a + D3 **PASS** in real Chromium vs live local stack, evidence in session log + `docs/superpowers/reviews/2026-07-12-sdk-production-readiness.md`) | `ab099b6a` | 2026-07-10   | `549d597a0` + live gate  |
| 10  | Docs — README, CHANGELOG, API-MAP                       | **DONE**    | `ab099b6a` | 2026-07-10   | `6e9cc9f5a`              |


Statuses: `NOT STARTED` · `IN PROGRESS` · `BLOCKED (reason)` · `DONE (sha)` · `WON'T DO (reason)`

### Hard stops — bring these to Jay, do not decide alone

- [ ] **Task 2, first run.** Nothing has ever installed and imported the tarball. A failure is a **real pre-existing bug**, not something to loop on. Report it.
- [ ] **Task 3, before committing the snapshot.** It becomes ground truth for everything after.
- [ ] **Task 5, Step 12 — the snapshot diff.** Additions fine. **A removal or rename means a broken consumer.** Never accept the diff to reach green.
- [x] **Task 9, Step 6.** Real browser, live stack, real sandbox. D2a (streaming through the IIFE global) and D3 (`instanceof Kortix.ApiError` under the bundle) cannot be claimed without it. — **Executed 2026-07-12, both PASS** (Chromium + live stack + real PAT/sandbox; see session log).

Also stop if the same failure survives three different fixes (use
`superpowers:systematic-debugging`), or you are about to change what a test asserts.

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


| #   | Gap                                                                                                                                                  | Evidence                                                                                                                                                                          | Status                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| B1  | **No skills create/update/delete surface.** The only agent capability with zero SDK coverage.                                                        | `grep -rn "createSkill|deleteSkill" packages/sdk/src` → nothing but a comment in `projects-client/agent-config.ts:7`                                                              | OPEN                                                                               |
| B2  | **No account-deletion surface.**                                                                                                                     | `grep -rn "deleteAccount" packages/sdk/src` → nothing                                                                                                                             | OPEN                                                                               |
| B3  | **Host-local React hooks that belong in the SDK.** `apps/web` hand-rolls hooks over client fns the SDK already exposes — violating "hosts are thin". | `apps/web/src/hooks/{transcription/use-transcription,projects/use-project-gateway,channels/use-channel-bindings}.ts`. `@kortix/sdk/react` has only `use-gateway-catalog-sync.ts`. | OPEN                                                                               |
| B4  | `**.name` on `ApiError` is duck-typed by legacy sniffers.** Changing it is a *silent runtime* break, not a compile break.                            | `src/platform/api/errors.ts:59` — `this.name = 'ApiError'`, with a comment noting legacy sniffers                                                                                 | WON'T DO for now — documented in `AGENTS.md`; revisit only with a deprecation path |
| B5  | `**structure_version` semantics undocumented** (`1` = legacy tasks, `2` = tickets/board)                                                             | `src/opencode/kortix-master.ts`                                                                                                                                                   | OPEN                                                                               |
| B6  | **Tripwire regex is blind to side-effect imports.** `import 'react';` (no `from`) matches neither the graph walker's regex nor the examples tripwire — a bare framework side-effect import slips through | Task 9 probe: brief's literal `import 'react';` did NOT fail the test; `import { createElement } from 'react'` did. `src/index.isomorphic.test.ts` (`collectGraph` importRe + examples test) | **CLOSED 2026-07-12** — shared `importSpecifiers` helper now catches side-effect imports (both quote styles) in the graph walker, the examples scan, AND the inline tier scan; RED-proven, reviewed. Uncommitted fix wave, see `.superpowers/sdd/fix-wave-2-report.md` |
| B7  | **Provider-qualified gateway defaults must remain in the `kortix` picker namespace.** Lock `codex/gpt-5.6-sol` to `{ providerID: 'kortix', modelID: 'codex/gpt-5.6-sol' }` rather than misclassifying it as a native provider. | `src/react/use-model-store.ts:42` defines every gateway wire model as a `kortix` model ID; `src/react/use-opencode-local.test.ts` now covers the Codex default. | **DONE 2026-07-12** — implementation `ee7d2cc09`; full SDK suite, typecheck, and packed-install smoke green |
| B8  | **Retire the experimental project-app deployment SDK surface with its removed platform capability.** This is intentionally subtractive because the user explicitly requested complete removal of the underlying capability. | The former project-app client module, facade property, types, examples, and snapshot entries were removed in `ec8b44dda`. | **DONE 2026-07-13** — session `remove-freestyle`; full SDK gates green |
| B9  | **Expose E2B as an additive sandbox-provider literal everywhere the published SDK accepts or reports a provider.** | Stale explicit unions remained in `src/core/rest/{platform-client/types,projects-client/session-sandbox,projects-client/sessions}.ts`; the server provider unification adds `e2b`. | **DONE 2026-07-13** — implementation `5763b63e4`; full SDK gates green |
| B10 | **Expose the managed Git username alongside the push token.** Code Storage uses `t:<token>` while GitHub uses `x-access-token:<token>`; clients need the provider-selected username to clone and push without hard-coding GitHub credentials. | `src/core/rest/projects-client/projects.ts` models `ProjectGitToken` with only `push_token`; the Code Storage end-to-end flow requires an additive `git_username`. | **DONE 2026-07-19** — implementation `ab80f9305`; full SDK suite, typecheck, and packed-install smoke green |
| B11 | **Expose owner-scoped member connection-profile creation and profile-specific Pipedream connect/finalize.** | Existing profile lifecycle methods only target manager-owned `/connector-profiles` and the shared connector Pipedream identity; session-selected member profiles need additive typed methods for `/connector-profiles/me` and `/{profileId}/connect`. | **DONE 2026-07-21** — implementation `3eb18b361`; full SDK suite, typecheck, and packed-install smoke green |
| B12 | **Allow daemon-owned PTY queries before OpenCode reports ready.** | `useOpenCodePtyList()` gates `/kortix/pty` on `useOpenCodeRuntimeReady()`, while `apps/kortix-sandbox-agent-server/src/proxy.ts` owns `/kortix/pty` independently of OpenCode. | **DONE 2026-07-22** — implementation `c973f9209`; SDK and web suites, packed-install smoke, isolated proxy tests, and live Platinum/Daytona PTY smokes green |
| B13 | **Add bounded GitHub repository discovery for large managed owners.** The current client can only request the full owner repository list, which exceeds the API processing deadline for `managed-kortix`. | Production `GET /v1/projects/github/repositories?...&installation_id=pat` returned `503` after 25 seconds; `packages/sdk/src/core/rest/projects-client/github.ts` exposes no page or search input. | **DONE 2026-07-23** — `0748271116`; session `github-repo-selector` |
| B14 | **Remove the synthetic `auto` model and enforce paid-tier access for every Kortix-managed model in every environment.** Free-tier wallet credits are sandbox-only; stale `auto` requests must fail closed instead of selecting a managed fallback. | `packages/sdk/src/react/use-opencode-local.ts` sends `kortix/auto`; `apps/api/src/billing/services/tiers.ts` disables managed-model entitlement enforcement for every dev/preview account. | **DONE 2026-07-24** — implementation `406eb5e9a`; session `fix-free-tier-model-entitlement` |


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


| Date       | Session    | Finding                                                                                                       | Where                                                                           |
| ---------- | ---------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 2026-07-10 | `01AzJBSa` | The original plan's "bump to `0.3.0`" is **impossible** — `version` is inert and `latest` on npm is `0.9.100` | `scripts/stage-npm-publish.mjs:32`                                              |
| 2026-07-10 | `01AzJBSa` | `KortixProject` declared **twice**, as two different interfaces                                               | `core/rest/projects-client/projects.ts:31`, `core/runtime/kortix-master.ts:577` |
| 2026-07-10 | `01AzJBSa` | Bare `process.env` read in the isomorphic core → `ReferenceError` in a `<script>` bundle                      | `platform/platform-client/shared.ts:29` — fixed in Task 7                       |
| 2026-07-10 | `01AzJBSa` | The tripwire walks **imports**; it cannot see globals (`process`/`window`/`document`)                         | `src/index.isomorphic.test.ts` — fixed in Task 7                                |
| 2026-07-10 | `01AzJBSa` | Nothing installs and imports the tarball. `npm pack --dry-run` lists contents only                            | `.github/workflows/package-tests.yml` — Task 2                                  |
| 2026-07-10 | `ab099b6a` | Plan's smoke script can't install: staged `workspace:*` dep pins `@kortix/llm-catalog@0.0.0-smoke`, absent from npm. Fixed per Jay: pack + install the sibling tarball alongside | `packages/sdk/scripts/smoke-install.mjs` — Task 2 |
| 2026-07-10 | `ab099b6a` | **`createServerKortix` does not exist.** Plan (`:253,991`) and spec (`:158`) assert it from `./server`; real exports are `createScopedKortix`, `runWithKortix`, `getScopedConfig` (`src/server.ts`). Also affects Task 6's Lumen snippet | `docs/superpowers/{plans,specs}/2026-07-10-*` — Task 2/6 |
| 2026-07-10 | `ab099b6a` | Docs prose says 25 subpaths / 21 legacy; reality is 23 export keys / 20 legacy. Plan's enumerated key lists (Task 5 Step 9) match reality exactly | `packages/sdk/package.json` |
| 2026-07-10 | `ab099b6a` | Plan's `createCliToken` facade name is fictional; real facade method is `kortix.project(id).tokens.create(input?)` (→ `createProjectCliToken`). `gateway.sessions(days?)` was correct | `packages/sdk/src/core/client/kortix.ts:303` — found in Task 6 |
| 2026-07-10 | `ab099b6a` | Demo e2e harness memoizes builds on `.next/BUILD_ID` — e2e runs silently exercise STALE builds after source changes; must clear `.next` (or fix the harness) for trustworthy runs | `apps/whitelabel-demo/tests/e2e/harness.ts` (`ensureBuilt()`) |
| 2026-07-10 | `ab099b6a` | Original preview-token malformed-200 guard was itself broken: `upstreamRes.status \|\| 502` returns 200 on that path, so the "error" response shipped as HTTP 200. Fixed by the Task 6 rewrite (now a real 502, e2e-covered) | `apps/whitelabel-demo/src/app/api/preview-token/route.ts` (pre-`19e500e50`) |
| 2026-07-10 | `ab099b6a` | **CRITICAL (final review): the CDN claim is unfulfillable by the release pipeline.** Publish runs tsc only (`publish-npm-package.sh:36`; `prepublishOnly` tsc-only) so tsup bundles never land in the tarball; `stage-npm-publish.mjs:37` promotes only `type/main/types/exports/files/bin`, so `browser`/`unpkg`/`jsdelivr` stay nested in `publishConfig` where npm/unpkg/jsDelivr never look; nothing validates them at release. Plan flaw (plan `:1253-1278` said "pass through untouched"), faithfully implemented. Decision with Jay: wire the pipeline vs walk back the README/CHANGELOG claim | `scripts/{publish-npm-package.sh,stage-npm-publish.mjs}`, `packages/sdk/{README,CHANGELOG}.md` |
| 2026-07-10 | `ab099b6a` | `bundle.test.ts` never executes in CI (no workflow runs `build:bundles` → both tests skip forever) and NO workflow runs `pnpm --filter @kortix/sdk typecheck` at all (examples' "typechecked in CI" claim is local-only). Two cheap CI steps close both | `.github/workflows/package-tests.yml` |
| 2026-07-10 | `4003a41b` | GETTING-STARTED step 3 was un-followable: the web "API keys" tab's **Create button only rendered in the empty state**, and the executor auto-mints "Executor Session" tokens, so real accounts never see it — no way to mint a PAT from the UI. Fixed (uncommitted, this worktree): `CreateApiKeyAction` header button + regression test; doc wording updated ("CLI tokens tab" → "API keys") | `apps/web/src/features/accounts/settings/cli-tokens-tab.tsx`, `packages/sdk/GETTING-STARTED.md` |
| 2026-07-10 | `4003a41b` | **`ensureReady()` is single-shot** — one `/start` with `wait_ms=30_000`, then throws `RUNTIME_UNAVAILABLE`; a cold provision (observed: minutes) makes EVERY ensureReady example (02/04/06/07) fail — callers must hand-roll a retry loop (examples 09/step4 in this worktree do). Live-observed worse: the server returned near-instantly ~99× in 5min (long-poll not held), and one session went provisioning→stopped and then **disappeared from `projects.sessions()`**. SDK DX gap: `ensureReady({ deadlineMs })` or documented retry | `packages/sdk/src/core/client/kortix.ts:674` (verified live against local stack) |
| 2026-07-10 | `4003a41b` | Local-stack default-agent sends fail: gateway forwards opencode's `max_tokens` to a model demanding `max_completion_tokens` (OpenAI `unsupported_parameter`, HTTP 400) → default `send()` turns error with no assistant reply. Workaround verified live: per-send model override `{ providerID: 'kortix', modelID: 'claude-sonnet-4.6' }` → full e2e pass. Platform fix belongs in the gateway param translation or default model config | `/v1/llm-gateway/v1/llm/chat/completions` (via tunnel), `apps/api/src/router/routes/proxy/helpers.ts:252` |
| 2026-07-11 | `4003a41b` | `session.transcript()` on a session whose sandbox was re-provisioned returns `{available:false, reason:"…ZlibError fetching …/session/<old opencode id>/message…"}` — graceful, but the compact transcript is unreadable after a sandbox swap (stale opencode session id?). Observed live on the local stack | `packages/sdk/src/core/rest/projects-client/sessions.ts` (`getSessionTranscript`) |
| 2026-07-11 | `4003a41b` | `sandboxShares.list(sandboxId)` (`GET /p/share?sandbox_id=…`) returns **502** on the local stack for a live, ready sandbox — session `publicShares` create/list/revoke on the same sandbox works fine. SDK surfaces it correctly as typed ApiError; route itself looks broken/misrouted locally | `packages/sdk/src/core/rest/projects-client/sandbox-shares.ts:33` |
| 2026-07-21 | `profile-owned-bindings` | The existing computer-connector integration's unknown-slug assertion depends on its arbitrary local project's Git manifest being readable. When GitHub returns 422, `getConnectorPoliciesFromManifest` returns `{ policies: [] }` before proving the slug exists, so the test reports **7 pass / 1 fail** instead of the earlier **8 / 0**. This branch does not touch that path. | `apps/api/src/executor/manifest-crud.ts:393`, `apps/api/src/__tests__/integration-computer-connector.test.ts:157` |


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

**Found** — see *Discovered this session*. The load-bearing ones: `0.3.0` was
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

**Status:** IN PROGRESS.

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
