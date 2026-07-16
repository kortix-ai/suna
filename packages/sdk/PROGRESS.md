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
| B9  | **`core/turns/parts.ts`, `grouping.ts`, `shell.ts`, `state.ts` still lack `@deprecated` JSDoc.** WS3-P3-a tagged `classify.ts`/`view-model.ts`/`tool-registry.ts` (its granted file list) but NOT these 4 sibling files — which are the ones `apps/mobile`'s `SessionTurn.tsx` (3568 lines, the mobile session renderer) actually imports most heavily (`collectTurnParts`, `getTurnStatus`, `getWorkingState`, `formatDuration`, `formatCost`, `formatTokens`, `stripAnsi`, `getRetryInfo`, `splitUserParts`, `isFilePart`, etc.). Same additive/zero-risk JSDoc-only shape as the work already done; left alone here only because it was outside the granted scope. | `packages/sdk/src/core/turns/{parts,grouping,shell,state}.ts`; `apps/mobile/components/session/SessionTurn.tsx:71-93` | OPEN |
| B10 | **ModelPicker `defaultControls` omitted.** The unified ModelPicker (commits `9dbe2c24b`, `6be202616`) omits the old picker's "Set as my/project/agent default" footer because `ModelPickerViewModel` has no persistence seam. Restoring it requires either a vm seam (follow-up P0-a) or wiring the footer to `useModelStore`; **must be resolved or explicitly cut by Jay before `unified_model_picker` flag defaults on**. | `apps/web/src/features/session/model-picker.tsx` (new); `packages/sdk/PROGRESS.md` (TS SDK takeover) | **RESOLVED — no cut needed, WS5-P0-c.** Verified (`grep -rn "modelDefaultControls" apps/web/src`) that `modelDefaultControls`/`ModelDefaultControls` is declared and consumed ONLY inside `model-selector.tsx` and `session-chat-input.tsx`'s own prop plumbing — **zero call sites ever populate it**: `ComposerChatInput` (the composer's only `SessionChatInput` wiring path, confirmed the sole non-test caller via `grep -rln "SessionChatInput" apps/web/src`) never passes `modelDefaultControls`, so the "Set as my/project/agent default" footer was already unreachable dead code in the live composer BEFORE this flag existed. Flag OFF and flag ON are therefore both "no default-controls footer in the composer" — not a regression, a parity. (Every other `<ModelSelector>` call site — Customize/schedule/task-config pages — is untouched, out of this task's composer-only scope, and keeps whatever `defaultControls` behavior it already had.) See Open decisions and the 2026-07-17 session log entry for the full evidence trail. |


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
| 2026-07-16 | `ws3-p3-a` | `react/chat/use-chat-turns.ts`'s `useChatTurns`/`TurnView` (a React binding over `classifyTurn`) has **zero consumers** in `apps/web` or `apps/mobile` — exported, tagged `@deprecated` this session, but nothing imports it today. Candidate for outright removal on a future major, not just deprecation. | `packages/sdk/src/react/chat/use-chat-turns.ts` |
| 2026-07-16 | `ws3-p3-a` | `apps/mobile/lib/transcript.ts` is a hand-forked copy of the SDK's `transcript.ts` (own docstring: "Ported from apps/web/src/lib/transcript.ts", which no longer exists) — mobile's `ExportTranscriptSheet.tsx` calls the LOCAL fork's `formatTranscript`/`getTranscriptFilename`, not the SDK's. Drift risk: two independent implementations of the same formatter, one frozen by this session's golden harness and one not. | `apps/mobile/lib/transcript.ts`, `apps/mobile/components/session/ExportTranscriptSheet.tsx` |
| 2026-07-16 | `ws3-p3-a` | `apps/web`'s transcript EXPORT flow is already ACP-native (`export-transcript-modal.tsx`'s local `formatAcpTranscriptMarkdown` over `getSessionTranscript`), NOT the SDK's deprecated `formatTranscript` — it only still pulls `getTranscriptFilename`/`DEFAULT_TRANSCRIPT_OPTIONS`/`TranscriptOptions` from the deprecated module. One more data point that `apps/web` is fully off the OpenCode-wire projection stack for the live surface; only `apps/mobile` and session-list/`?oc` remain. | `apps/web/src/features/session/header/export-transcript-modal.tsx` |
| 2026-07-16 | `ws3-p3-a` | `packages/sdk/src/react/use-canonical-runtime-session.ts`'s own doc claims it backs "`?oc` deep-links and sidebar sub-session rendering" — but it's dead code, referenced only in two comments repo-wide, never imported/called. The real `?oc` read path calls `useSearchParams().get('oc')` directly and never touches this hook. Stale intent, not wired up. | `packages/sdk/src/react/use-canonical-runtime-session.ts` |
| 2026-07-16 | `ws3-p3-a` | `apps/web/src/ui/{index,types}.ts` re-export `QuestionOption` pinned (by one of the package's documented root-barrel ambiguity pins) to the deprecated `core/turns/view-model.ts`'s `QuestionOption`, not the structurally-identical wire-types version — and has **zero downstream consumers** anywhere in `apps/web/src`. Dead re-export chain. | `apps/web/src/ui/index.ts`, `apps/web/src/ui/types.ts`, `packages/sdk/src/index.ts:331` |
| 2026-07-17 | `ws5-p0-c` | The SDK's OWN `ExperimentalFeatureKey` union (`core/rest/projects-client/projects.ts`) is a hand-maintained mirror of `apps/api/src/experimental/features.ts` / `@kortix/api-contract`'s `ExperimentalFeatureMapSchema` — and it was already missing `experimental_harnesses` (added to apps/api by commit `8658acde6`) before this session touched it. Added `unified_model_picker` (this task's own key, required for `apps/web` typecheck) but left `experimental_harnesses` unfixed — pre-existing drift, out of this task's granted scope. A consumer reading `project.experimental.experimental_harnesses` off the SDK's `KortixProject` type today gets a `Record<ExperimentalFeatureKey, boolean>` whose key type doesn't statically include it (works at runtime via bracket access or the api-contract-typed route, just not through the SDK's own narrower type). | `packages/sdk/src/core/rest/projects-client/projects.ts:16` |
| 2026-07-17 | `ws5-p0-c` | `apps/api/.env.keys` (the dotenvx private key for the **local** profile) is absent from this sandbox and no `dotenvx-armor` CLI/session is available to pull it — `apps/api`'s own test suite (`bash scripts/test.sh`, per-file `dotenvx run -- bun test`) cannot execute here; `bun test` fails at `config.ts`'s env validation before any test file even loads (every encrypted var decrypts to `encrypted:…` literal, fails Zod). Not a regression from this task — pre-existing sandbox/environment gap. `apps/api`'s `tsc --noEmit` (no env needed) DOES run clean here, and was used as the substitute verification for the two `apps/api` files this task touched. | `apps/api/.env`, `apps/api/scripts/test.sh`, `apps/api/src/config.ts` |


---

## Open decisions


| Question                                    | Owner | Status                                                                                                                                                              |
| ------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Second `KortixProject` name                 | Jay   | **RESOLVED** — platform keeps `KortixProject`; the kortix-master daemon's becomes `KortixMasterProject`, aliased                                                    |
| Rename `ApiError` → `KortixApiError`?       | Jay   | **RESOLVED — no.** Package name already namespaces the import; `.name` is duck-typed (B4); `instanceof` is the branch mechanism. Prefix only for genuine ambiguity. |
| "Shift the cortex tab to SDK" — what is it? | Jay   | **OPEN.** May re-order everything if it names work Marko is waiting on.                                                                                             |
| B10 `defaultControls` restore-or-cut — did the composer need a footer restored? | Jay | **Applied the brief's own pre-authorized fallback (WS5-P0-c): "cut", not "restore".** No architecture work was needed either way — grep-verified `modelDefaultControls` had zero live call sites in the composer before this task (see B10's row and the session log). If this reasoning is wrong (e.g. another surface *was* relying on it reaching the composer), flag here for a real restore pass; nothing was silently dropped — the flag-ON and flag-OFF composer both render zero default-controls footer today. |


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

### 2026-07-13 — session `acp-harness-runtime-v2`: post-main-merge verification

Completed the ACP projection/route-ownership cleanup on the combined
`acp-harness-runtime-v2` + `main` tree. Mobile now selects the SDK's durable ACP
transcript polling transport automatically, secrets mutations are SDK-owned,
the last dead OpenCode session-mapping implementation and diagnostic scripts
are removed, and the web composer uses the canonical Kortix loading primitive.
No web/mobile/CLI/whitelabel host imports `@opencode-ai/sdk`, an old OpenCode SDK
subpath, or a `useOpenCode` client hook; OpenCode remains only a selectable ACP
harness plus explicit legacy migration compatibility.

**Final SDK gates:** `pnpm --filter @kortix/sdk typecheck` exited 0;
`pnpm --filter @kortix/sdk test` reported **952 pass / 0 fail** across 71 files
with 4401 assertions; `pnpm --filter @kortix/sdk run smoke:install` built,
packed, installed, imported, and constructed the published package.

**Cross-surface gates:** API typecheck exited 0 and the isolated API runner
reported **259 isolated suites passed**; web typecheck exited 0 and web tests
reported **1026 pass / 0 fail** across 128 files; mobile TypeScript exited 0 and
mobile tests reported **34 pass / 0 fail** across 13 files; CLI typecheck exited
0 and tests reported **204 pass / 0 fail** across 24 files; manifest compiler
reported **324 pass / 0 fail**; starter **37 pass / 0 fail**; API contract **34
pass / 0 fail**. The sandbox daemon typecheck/build exited 0, tests reported
**123 pass / 0 fail**, and the rebuilt Linux `dist/kortix-agent` is newer than
its source.

**Real user/runtime proof:** the local Chromium selector E2E passed and asserted
all four harness rows plus the exact Codex custom-model session-create payload.
Four fresh real Daytona sessions then completed ACP prompts with tool calls and
terminal stop state through OpenCode, Claude, Codex, and Pi; the runner ended
`[acp-all] PASS all harnesses`. A tracked-file scan found no pasted Claude setup
token, and forbidden native OpenCode SDK/dependency/conflict-marker scans were
empty.

**Shippable to production: YES** for the SDK ACP transport/projection and its
web/mobile consumers. The branch remains intentionally isolated in PR #4510;
the user has explicitly forbidden merging it into `main` until they separately
authorize that action.

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

### 2026-07-13 — session `acp-harness-runtime-v2`: ACP context projection claim

Claimed the branch-isolated ACP projection work required by the approved
multi-harness specification: move context-message and protocol `usage_update`
interpretation into `@kortix/sdk`, expose one harness-neutral projection to web
and mobile, and remove host-local ACP envelope inference. The existing stale
merge-to-main goal is not authoritative for delivery; PR #4510 remains open and
unmerged by explicit user instruction.

**Status:** IN PROGRESS. RED/GREEN evidence and the full SDK typecheck, test, and
packed-install smoke gates will be recorded on completion.

### 2026-07-13 — session `acp-harness-runtime-v2`: route ownership continuation

Expanded the existing isolated-branch claim to finish the harness-neutral SDK
cutover around ACP: classify every remaining runtime URL as ACP conversation,
sandbox-local daemon primitive, or Kortix platform REST; remove host-local
harness transport; and preserve public compatibility only where a live owning
service still exists. The legacy `kortix-master` task/ticket/credential/service
client is under explicit audit because neither the ACP daemon nor current
`main` implements those routes; they must not be recreated as fake ACP methods.
TDD remains mandatory for every changed SDK contract. PR #4510 stays open and
unmerged by explicit user instruction.

**Status:** IN PROGRESS.

### 2026-07-13 — session `acp-harness-runtime-v2`: ACP claims complete

Closed the branch-isolated ACP context-projection and route-ownership claims
above. The SDK now owns the harness-neutral ACP client, durable transcript and
chat projections, prompt/permission/elicitation state, usage/context projection,
runtime readiness, and React session/composer surfaces consumed by web and
mobile. Hosts contain no native harness transport or OpenCode SDK dependency;
OpenCode remains a selectable ACP harness alongside Claude, Codex, and Pi.

**Final SDK gates after merging `origin/main` at `f9d9bcfc3`:**
`pnpm --filter @kortix/sdk typecheck` exited 0;
`pnpm --filter @kortix/sdk test` reported **968 pass / 0 fail** across 79 files
with 4470 assertions; `pnpm --filter @kortix/sdk run smoke:install` built,
packed, installed, imported, and constructed the published package.

**Repository and real-runtime evidence:** API **275 isolated suites passed**;
web **1064 pass / 0 fail**; CLI **232 pass / 0 fail**; mobile **34 pass / 0
fail**; sandbox daemon **123 pass / 0 fail**. The real Chromium selector E2E
asserted Claude, Codex, OpenCode, and Pi plus the exact Codex custom-model
session-create payload. Four fresh Daytona sandboxes completed ACP prompts with
real shell tool calls for all four harnesses and ended with
`[acp-all] PASS all harnesses`. The daemon binary remains newer than every
source file. Native host `@opencode-ai/sdk` imports, old OpenCode client-hook
imports, conflict markers, and tracked Claude setup-token patterns are all zero.

**Status: DONE. Shippable to production: YES.** This closure supersedes both
ACP `IN PROGRESS` entries above. Delivery remains intentionally limited to the
open, unmerged PR #4510 by explicit user instruction; this branch must not be
merged into `main` without separate authorization.

### 2026-07-13 — session `acp-harness-runtime-v2`: CodeQL closure claim

Claimed the five security-severity findings GitHub attributes to this large PR:
the CLI doctor must use the SDK-owned authenticated ACP transport, SDK auth must
make its intentional credential egress boundary explicit, daemon file reads
must not check-then-open through a swappable path, and mobile release-title
normalization must escape arbitrary version text safely. RED regressions precede
implementation; affected/full gates and a green PR CodeQL aggregate are required.

**Closure:** `fa5731a79` completed the RED/GREEN security wave. CLI doctor now
uses `createKortix(...).session(...).acp`; authenticated SDK HTTP targets reject
embedded URL credentials and expose the intentional token-egress seam to
CodeQL; daemon reads validate and consume the same opened inode; and mobile
release-title normalization escapes every regex metacharacter. Focused
regressions and the full post-implementation suites passed: SDK **970 pass / 0
fail**, CLI **233 pass / 0 fail**, mobile **36 pass / 0 fail**, and daemon **125
pass / 0 fail**, with SDK typecheck and packed-install smoke green. GitHub then
reported both JavaScript analyses and the aggregate `CodeQL` check successful
for implementation head `9b8aa453e`.

The branch subsequently merged the latest `origin/main` at `a658091a3` without
conflicts; its new AWS remote-state recovery regression is **15 pass / 0 fail**.
Delivery remains the open, unmerged PR #4510 by explicit user instruction.

**Status: DONE. Shippable to production: YES.** PR #4510 must not be merged
without separate authorization.

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

### 2026-07-15 — session `acp-sdk-hardening` (claim, LOCAL-ONLY edit, not committed)

Claimed: ACP hardening WA per docs/superpowers/plans/2026-07-14-acp-sdk-hardening-web-ux.md
(AcpSession store, transport hardening, reducer fixes, transcript exports, tool-part
normalization, useAcpSession→useSyncExternalStore). Jay-directed, subagent-driven,
no commits by Jay's standing rule; W0 pre-merge fixes already in this working tree.

### 2026-07-16 — cortex-cycle SDK changes (controller: sdd-main; cycle ledger: docs/superpowers/plans/2026-07-15-cortex-cycle-progress.md)

- **WS1-P0-c** (`f34086c3b`): internal `acp/harness-mirror.ts` (`SDK_HARNESS_IDS`) + colocated drift-guard test vs `@kortix/shared` `HARNESS_IDS` (devDependency-only; not exported from any barrel; snapshots unchanged).
- **DISC-02** (`d072187fe`): `acp/reduce.ts` `findLastIndex` → ES2017-safe reverse-loop shim (private fn; no surface change) — cleared apps/api's older-lib typecheck error.
- **WS3-P0-a** (`f4607618e`): extracted `acp/sse-core.ts` (`createSseBlockParser`, `isDeliverableSseBlock`, `isAcpResponseEnvelope`) from `AcpClient.consumeSse` — behavior-preserving, parity-pinned (pins green before AND after; deliberate-RED detector proof; reviewer independently reproduced). Snapshots +3 runtime / +4 type names, additions only. Suite 1102→1129/0. Poison-handling + Last-Event-ID dedupe deliberately stay in `client.ts` (caller-contract-specific). `pollTranscript` never shared SSE parsing (consumes parsed rows via `transcript()`) — considered, correctly untouched. Next: api proxy + headless engine consume this core (cycle WS3-P0-b/c); their known divergences (headless poison intolerance, `data:`-stripping variance, proxy CR-holdback gap) are catalogued in the cycle ledger.
- **WS3-P2-a**: `acp/reduce.ts` dead-code + guarded numeric-id review, + DISC-05 pin.
  - **Part 1 (deleted):** `isPermissionMethod`/`isQuestionMethod` — grepped absent from both `public-surface.snapshot.json` and `public-type-surface.snapshot.json`, and their only call sites were their own definitions (one comment mention in `use-acp-session.test.tsx` is prose, not a call). Module-internal dead code per the brief's decision rule → deleted outright; snapshots byte-unchanged (confirmed no diff).
  - **Part 2 (kept, nothing removed):** the `openRequestOrdinals`/`openPromptOrdinals`/`openPromptSessionIds` machinery and their ordinal-comparison backstops were evaluated candidate-by-candidate against the conservative bar and kept in full. Existing tests (`reduce.test.ts:118-162`, pre-dating this session) already prove same-order numeric-id reuse reaches all three maps. Two NEW tests prove the `< row.ordinal` comparison itself (not just the map) is load-bearing, independent of id scheme: a response/prompt-response delivered with a SMALLER ordinal than the currently-open entry (simulating `AcpSession.applyBatch`'s own documented out-of-order path, `session.ts:583-611`, or any external caller feeding an unsorted `rows` array straight into the public `reduceEnvelope`/`project*` functions) does NOT spuriously close the open entry — removing the comparison (keeping only `.has(key)`) would break both. `answeredIds`/`promptAnsweredIds` etc. are additionally locked by `AcpReducerState` being a published type (field removal risks a structural break even though nothing internal reads them past the has-check gate) — untouched for that separate reason. Net: zero source deletions in part 2; the deliverable is the keep/remove table + fixture evidence in the task report.
  - **Part 3 (DISC-05 pin):** a retried `session/prompt` (duplicate row, null `streamEventId`, distinct ordinals — the exact DB-layer gap P1-b proved) is **NOT** deduped by `reduceEnvelope`'s `(direction, streamEventId)` check, since that check only fires when `streamEventId != null`. **Pinned: renders as TWO user messages** (`reduce.test.ts`, new `describe`-free test named for DISC-05) — both the incremental `reduceEnvelope` fold and the `projectAcpChatItems` fold-from-scratch selector agree. This is a real user-visible duplicated message on a retried POST today; behavior is pinned, not changed — the fix belongs to DISC-05's own schema decision.
  - Suite 1129→1132/0 (3 new tests, all in `reduce.test.ts`). Typecheck exit 0. `smoke:install` passed. Snapshots unchanged (byte-diff empty). Full report in the task's scratchpad: `sdd/ws3-p2-a-report.md`.
- **WS3-P2-b**: `acp/session.ts` persisted-busy reload recovery (the ~297 doc comment's deferred wedge guard) + bounded `historyOrdinals`/`dedupeKeys` growth.
  - **Part 1 (wedge guard):** bootstrap-from-history already set `turnState.busy` true for an unanswered persisted `session/prompt` (P1-b/earlier hardening work, proven by a pre-existing test — `send() proceeds when busy comes only from persisted state`), and a NEW prompt/cancel already superseded it via `reduce.ts`'s busy-staleness policy — the genuinely missing piece was the DEAD-turn case (harness crashed; neither ever arrives). Chosen guard is **signal-based, not wall-clock**: two connection-lifecycle signals — (a) a live stream reaching terminal `'failed'` (`onStreamState`; always terminal by construction per `client.ts`'s own `AcpTransportError && error.terminal` gate), (b) bootstrap itself failing TERMINALLY (`runBootstrap`'s catch, gated on `toSessionError(...).terminal` — excludes a transient 500 that a retry will clear) — both funnel into a new `reduce.ts` primitive, `clearOpenPrompts` (exported; superseds every open prompt the same way `session/cancel` does, without touching `envelopes`/`chatItems`/`dedupeKeys`), called from `AcpSession.clearStalePersistedBusy`. Deliberately does NOT use plain `'closed'` (fires on a benign self-`close()` too — clearing busy there would wrongly forget a still-open turn across a same-session reconnect). No clock anywhere in the store (`Date.now()` remains ordinal/id-minting-only, never compared against elapsed time), so this stays deterministic-fixture testable. **Residual case, stated honestly:** a harness that dies without the bridge ever reporting either signal (bootstrap succeeds, stream reaches `'open'` and just idles forever) is NOT covered — no protocol signal exists for it short of a heartbeat/timeout, which would require the clock this design avoids. Accepted because the wedge is a soft UI signal only: `send()` already proceeds regardless of persisted-only busy (pre-existing, unchanged), so the user's own next action always breaks the wedge. `send()`'s stale doc comment (which described this as still deferred) updated to match. 6 new tests in `session.test.ts` (bootstrap-busy baseline, terminal-stream dead-turn, terminal-bootstrap dead-turn, transient-bootstrap regression guard, self-close exclusion, normal-response resolution) + 2 in `reduce.test.ts` (`clearOpenPrompts` no-op / clears).
  - **Part 2 (bounded growth):** `historyOrdinals` (`session.ts`, private `Set<number>` of every accepted ordinal) replaced by a single `historyHighWaterMark: number` — O(1), not O(session length). Sound (not just an optimization) because ordinals are `GENERATED ALWAYS AS IDENTITY` (P1-b: strictly increasing, never reused) AND `enqueueHistory` is only ever called with the FULL persisted transcript (no `after` cursor) — a full fetch is exhaustive up to its own point in time, so a genuinely-new ordinal can never be smaller than one already accepted; a smaller re-delivery (bootstrap retry re-fetching the same transcript) can only be a genuine duplicate. Each `enqueueHistory` call fixes its dedupe threshold to the mark's value from BEFORE the call (advances the mark once, at the end) so a single call's own row array never needs to already be sorted. `dedupeKeys` (`reduce.ts`, the `${direction}:${streamEventId}` `Set`) got a DIFFERENT bound — a fixed-size (256) recency WINDOW via `boundedDedupeKeys`, not a bare high-water mark — because unlike `historyOrdinals` it backs a PUBLIC function (`reduceEnvelope`/every `project*` wrapper) any external caller can feed an arbitrarily-ordered `rows` array; a mark-only design would silently misclassify a genuinely-new-but-smaller-id row as a duplicate (proven by a dedicated out-of-order-within-window test). The window's correctness trade, stated honestly: a genuine duplicate re-arriving after aging out (more than 256 distinct keys newer folded since) is no longer recognized — accepted because `client.ts`'s own `event.id <= lastEventId` filter already screens same-connection duplicates before they ever reach `reduceEnvelope`, and Last-Event-ID reconnect replay only ever re-delivers a small bounded tail, never a session's full history. Correctness bar held: every existing arrival-pattern test (in-order, exact duplicate, ordinal-backstop out-of-order, DISC-05) still passes unchanged. New tests: growth (5,000 history rows, `historyHighWaterMark` stays a scalar; 2,560 `dedupeKeys` rows, `size <= 256`), eviction-boundary (`ordinal <= historyHighWaterMark` still dedupes a stale retry), duplicate-within-window, replay-overlap, out-of-order-within-window, eviction-boundary-honesty (aged-out duplicate re-accepted, documented as accepted cost).
  - `clearOpenPrompts` is a new export from `acp/reduce.ts` (barreled through `acp/index.ts`) — additive; both `public-surface.snapshot.json` and `public-type-surface.snapshot.json` re-recorded (one line each, addition only, diffed and reviewed).
  - Suite 1132→1148/0 (16 new tests: 9 in `session.test.ts`, 7 in `reduce.test.ts`). Typecheck exit 0. `smoke:install` passed. `apps/web`'s `acp-session-perf.test.tsx` (the commit-budget gate) reran green, unaffected (its fixture has empty initial history and no stream failures, so neither new code path executes). Full report: `sdd/ws3-p2-b-report.md`.
- **WS3-P3-a**: deprecate + pin + inventory the OpenCode-wire projection stack (retirement PREREQUISITES only — zero deletions, zero host migrations, zero behavior change; the actual removal is WS4-P6, still deferred).
  - **`@deprecated` JSDoc (additive-only):** `transcript.ts` (`formatTranscript`, `TranscriptOptions`, `SessionInfo`, `MessageWithParts`, `DEFAULT_TRANSCRIPT_OPTIONS` — `getTranscriptFilename` deliberately left untagged, it's format-agnostic and still legitimately shared with the ACP export path), `core/turns/classify.ts` (`classifyPart`, `classifyTurn`), `core/turns/view-model.ts` (`toolViewModel`), `core/turns/tool-registry.ts` (`toolInfo`), plus module-doc notes on `core/turns/index.ts` and the corresponding barrel comments in `index.ts`. Also tagged `react/chat/use-chat-turns.ts` (`useChatTurns`, `TurnView`) — a React binding over `classifyTurn` the brief didn't name explicitly but is squarely the same stack; **zero consumers found in apps/web or apps/mobile** (unused export, flagged, not removed).
  - **Golden parity harness (new):** `core/turns/__fixtures__/opencode-wire-mixed.json` (a `{session, messages}` wire fixture exercising all 12 `Part` variants + an `info.error` turn + an empty turn) plus 3 golden outputs generated by running the CURRENT implementation over it (characterization, not hand-computed): `opencode-wire-classified.golden.json` (`classifyTurn` per message), `opencode-wire-tool-views.golden.json` (`toolViewModel` per tool part), `opencode-wire-transcript-body.golden.md` (`formatTranscript` body — header excluded, its Created/Updated lines run through `Date#toLocaleString()`, which is TZ-dependent and unfair to freeze across CI runners). New test: `transcript.golden.test.ts` (4 tests) asserts current output still `toEqual`s the goldens — this is the harness a future removal must satisfy or explicitly break-and-migrate against.
  - **ACP-sole-engine verification:** confirmed `apps/web`'s `acp-*` chat family (`acp-session-chat.tsx` + 8 direct support modules) imports zero OpenCode-wire names — grep-clean, and `acp-session-chat.test.tsx` (772 lines, pre-existing) already builds every fixture via `projectAcpChatItems` and asserts render behavior off `chatItems` alone. Added one small structural pin, `apps/web/src/features/session/acp-engine-exclusivity.test.ts` (9 tests), that source-scans the same file family for the 8 deprecated names so the claim can't quietly go stale. Also found (bonus corroboration): `apps/web`'s transcript EXPORT flow (`export-transcript-modal.tsx`) is *already* ACP-native — a local `formatAcpTranscriptMarkdown` over `getSessionTranscript` (platform REST), not the SDK's deprecated `formatTranscript`; it only still pulls `getTranscriptFilename`/`DEFAULT_TRANSCRIPT_OPTIONS`/`TranscriptOptions` from the deprecated module.
  - **`?oc` deep-link:** sole touchpoint repo-wide is `apps/web/src/features/workspace/project-sidebar/project-session-list.tsx` (`searchParams.get('oc')` — highlights the active sub-session row; unrelated to `formatTranscript`/`classifyPart`). No dedicated test exists for this component or the `oc` param specifically (pre-existing gap, not introduced here); the closest test, `project-session-list-helpers.test.ts` (23 tests, covers the extracted pure helpers), reran green — untouched.
  - **Consumer inventory:** full file-by-file breakdown in the task report (`sdd/ws3-p3-a-report.md`) — apps/web, apps/mobile, apps/whitelabel-demo, and SDK-internal importers of `./transcript`, `./turns`/`core/turns/*`, `react/chat/{use-chat-turns,render-parts}.ts`, and `react/use-runtime-sessions/*`. Headline: **19 files across 3 apps** touch the stack (15 direct importers + 2 mobile shadow-forks + 2 web `?oc` touchpoints). Biggest finding: `apps/mobile/lib/transcript.ts` is a hand-forked, un-synced duplicate of `transcript.ts` — mobile's transcript export never imports the SDK's copy, so this session's freeze/golden-harness work has **zero effect** on it; a future retirement must handle it as a SEPARATE migration, not assume tagging the SDK closes the loop. Second-biggest: apps/mobile's session-turn renderer (`SessionTurn.tsx`, 3568 lines) is the heaviest live `@kortix/sdk/turns` importer — but of `core/turns/parts.ts`/`grouping.ts`/`shell.ts`/`state.ts` (`collectTurnParts`, `getTurnStatus`, `formatCost`, `stripAnsi`, etc.), NOT the 3 files this task's granted scope covered. **Both gaps flagged, not fixed** — see Backlog `B9` and the report's §6.B.
  - Also found: `apps/whitelabel-demo` (the SDK's own third-party-integrator example app, not named in the brief) has a FULL dependency on the deprecated stack (`classifyTurn`/`toolInfo`/`toolViewModel`/`renderParts`) — its two chat-rendering files are the reason `react/chat/{use-chat-turns,render-parts}.ts` got tagged this session (see above); `apps/web/src/ui/{index,types}.ts`'s `QuestionOption` re-export chain (pinned to the deprecated `view-model.ts` by one of the package's documented ambiguity pins) has zero downstream consumers; `packages/sdk/src/react/use-canonical-runtime-session.ts` is dead code whose own doc claims it backs `?oc` deep-links but is disconnected from the real `?oc` read path (`project-session-list.tsx:109` calls `useSearchParams().get('oc')` directly).
  - Suite 1148→1152/0 (4 new SDK tests) + apps/web +9 (`acp-engine-exclusivity.test.ts`). SDK typecheck exit 0, `smoke:install` passed, snapshots byte-unchanged (confirmed no diff on `public-surface.snapshot.json`/`public-type-surface.snapshot.json` — pure JSDoc addition, zero export/rename changes). Full report: `sdd/ws3-p3-a-report.md`.
- **DISC-06 follow-ups**: (1) `acp/session.ts:720` — `priorEnvelopes[priorEnvelopes.length - 1].ordinal` rewritten `noUncheckedIndexedAccess`-safe (hoisted `lastPriorEnvelope`, explicit `!== undefined` check); behavior-neutral, clears `apps/kortix-sandbox-agent-server`'s `bun tsc --noEmit` (1 error → 0). (2) `examples/acp-bridge-quickstart.md` sharpened so scenario 4's outcome reads as intended layering, not an SDK gap: `AcpSession`'s `/transcript`-bootstrap dependency and missing `agent`-injection option are both consequences of it being the platform-endpoint store (durable-transcript grounding is the point), not defects in the bare daemon-bridge `AcpClient` path — full findings in DISC-06's report (`sdd/disc-06-report.md`, "SDK gaps found" items 2-3). Suite unchanged at 1152/0; snapshots byte-unchanged.
- **WS3-P5-a** (docs-only, no code changes): `packages/sdk/src/acp/README.md` — the ACP protocol/transport reference. Covers, in order: the canonical decision (raw ACP envelopes are the durable truth, everything else is a projection — citing the grounding doc `docs/superpowers/specs/2026-07-15-acp-native-multiharness-context.md`); the 3-identity model (`projectSessionId`/`runtimeId`/`acpSessionId`) and its never-overload law as enforced by `apps/api/src/projects/lib/acp-session-identity.ts`'s `AcpSessionIdentityOverloadError`; the session-scoped transport (`/v1/projects/{pid}/sessions/{sid}/acp`) and the daemon bridge contract (lazy single process, 409/202, idempotent DELETE, HMAC gate, bounded `Last-Event-ID` replay) citing the hard-gate commit `8c7d49a64`; the SDK client's endpoint vs. daemon-bridge modes, SSE-via-fetch, backoff, and terminal-status policy; the one shared `sse-core.ts` parser and its three consumers, citing the two latent-defect fixes (`8664eb3f1` proxy CRLF, `667951665` headless poison-kill); the durable envelope log's laws — append-only ordinal order, idempotence, and the **DISC-05 exception stated honestly as an open decision** (client_to_agent retries duplicate, not deduped — citing the pin tests in `cbda547e7`/`2fdc62bc3`); the `AcpSession` store's persisted-busy wedge guard (incl. its honest residual case) and bounded dedupe structures, citing `846d97601`; and the OpenCode-wire deprecation pointer citing `a3dfe0cc2` + its golden parity harness. Also updated `packages/sdk/CHANGELOG.md` (Unreleased: `clearOpenPrompts` addition, the README itself, the OpenCode-wire deprecation entry, the two sse-core consolidation bugfixes, and three Internal entries for the sse-core extraction / wedge guard / bounded structures — all traceable to the commits above, none newly invented). Zero source changes — `git status --porcelain` scoped to the three named files only. Gate: `pnpm --filter @kortix/sdk test` 1152 pass / 0 fail (unchanged from baseline — docs-only). Full report: `sdd/ws3-p5-a-report.md`.
- **WS5-P0-a**: `react/use-model-picker.ts` (new) — `useModelPicker`, the unified model-first picker view-model. The catalog-vs-harness fork (`agentModelPolicy`) is resolved ONLY inside this hook: catalog policy (OpenCode) groups models by provider (parsed from the preset id's `provider/model` shape, falling back to the harness id when bare); harness policy (Claude/Codex/Pi) folds everything — a `kind:'auto'` "Default" item plus every preset — into ONE group named for the harness, so a consuming component never branches on harness. Pure derivation, no new fetches: wraps `useComposerCapabilities` + `useComposerModelCatalog` (its first real consumer — previously unused by any host) + `useHarnessConnections`, plus one local `useState` for the pre-session/non-live pending selection (there is no other owner of that state in this hook's input contract — no gateway-write callback, no `useModelStore` — so `select()` is a local no-op until a live ACP session's own advertised `configOptions` gives it a real write target via `setConfigOption`). Trailing `'not-connected'` group lists every connection compatible with the resolved harness that isn't `ready`, `selectable:false`, with `connectAction` set to the first disconnected connection (today's real connection matrix never has more than one non-native/non-gateway route per harness, so this doesn't lose information in practice — documented as a known simplification if that ever changes). **Stability/`experimental` derivation** — `ComposerCapabilities` does not thread harness stability through from the server (confirmed by reading `apps/api/src/projects/lib/composer-capabilities.ts`: `blocking_reason` is a full sentence, not the `'experimental_harness_disabled'` code sketched as a hypothesis in the task brief); chose to EXTEND `acp/harness-mirror.ts` (additive: new `SDK_HARNESS_STABILITY` export alongside the existing `SDK_HARNESS_IDS`) rather than bury an undocumented local map in the hook, with a new colocated drift-guard assertion in `harness-mirror.drift.test.ts` against `@kortix/shared`'s `HARNESSES[id].stability` (devDependency-only, same pattern as the existing id mirror) — keeps the "what's real" answer both truthful and future-drift-proof instead of hardcoding a value that could silently rot. `findAcpModelConfigOption`'s heuristic (apps/web's `acp-composer-adapters.ts`) is duplicated locally (`findModelConfigOption`) rather than imported — the SDK never depends on a host app — documented inline as an intentional, hand-synced fork. TDD: 5 RED tests (module-not-found) → GREEN, all per the brief's skeleton (catalog grouping+sublabels+trigger, harness default+presets+customEntry+experimental, trailing not-connected+connectAction, live select() routes through `setConfigOption` with a bare (unprefixed) value, `validate()` reason strings). Barrel-exported from `react/index.ts` (`useModelPicker`, `buildModelPickerViewModel` + 5 types). Snapshots re-recorded — additions only (`buildModelPickerViewModel`, `useModelPicker`, `ModelPickerGroup`, `ModelPickerItem`, `ModelPickerLiveSession`, `ModelPickerViewModel`, `UseModelPickerInput`), diffed and reviewed. Note: an existing, unrelated `getProjectModelPicker()`/`kortix.projects.modelPicker` REST catalog fetch (see CHANGELOG) already used the "model picker" name for a different concept (a compact connection-aware catalog response) — no export-name collision (confirmed by a clean barrel build), but worth knowing two "model picker" things now coexist in this package for different jobs. Suite 1152→1158/0 (5 new hook tests + 1 new drift test). Typecheck exit 0. `smoke:install` passed. Full report: `sdd/ws5-p0-a-report.md`.
- **WS5-P0-c**: wired the unified `ModelPicker` (P0-b) into `apps/web`'s composer behind a new `unified_model_picker` experimental flag (`stability: 'beta'`), legacy pickers as the instant flag-off fallback. Flag registered end-to-end mirroring `experimental_harnesses` (commit `8658acde6`): `@kortix/api-contract`'s `ExperimentalFeatureMapSchema` (+contract test), `apps/api/src/experimental/features.ts` (available always, `platformDefault: false` — explicit opt-in, no operator kill switch since it's a pure client-render surface), `apps/api`'s registry unit test. Read client-side via a NEW `useUnifiedModelPickerEnabled(projectId)` hook (`apps/web/src/hooks/projects/use-unified-model-picker-enabled.ts`) mirroring the existing `useReviewCenterEnabled` pattern exactly. **The fork itself**: added an optional `modelPicker` prop to `SessionChatInput` (`session-chat-input.tsx`) — when present, it renders exactly ONE `<ModelPicker>` in place of the `ModelSelector`/`HarnessModelSelector` block (mutual exclusion via an if/else, not an append); `undefined` (the default) leaves that render path byte-identical to before. This one line of branching had to live in `session-chat-input.tsx`, not only `composer-chat-input.tsx` as the task brief's file list implied — the brief's "fork lives in composer-chat-input.tsx" describes where the FORK DECISION (`catalogModelRequired`/`nativeHarness`) already lived, not where the actual `<ModelSelector>`/`<HarnessModelSelector>` JSX is; that JSX has always been in `session-chat-input.tsx`, so rendering `<ModelPicker>` at all requires a slot there. Kept the change minimal (one new optional prop, one ternary) and flagged here rather than silently expanding the brief's stated file list. `composer-chat-input.tsx` builds the `modelPicker` prop from `useModelPicker` (SDK) + `useModelConnectionGate` (existing "where does Connect route to" gate) only when the flag resolves true; both `useModelPicker`'s `projectId`/`agentName` inputs are forced `null` when the flag is off, so its own internal queries stay `enabled:false` — legacy computation (`models`/`harnessModel`/etc.) is completely untouched code, still computed either way (inert when a `modelPicker` prop is present, since `SessionChatInput` ignores it in that branch).
  - **Binding item 1 (`defaultControls` restore-or-cut) — RESOLVED, no cut needed**: grepped `modelDefaultControls`/`ModelDefaultControls` across `apps/web/src` and found it has **zero call sites populating it anywhere in the composer path** — `ComposerChatInput` (confirmed the sole non-test `SessionChatInput` caller via `grep -rln "SessionChatInput" apps/web/src`) never passes `modelDefaultControls`, so the legacy "Set as my/project/agent default" footer was already dead/unreachable in the live composer BEFORE this flag existed (it only ever fires from `ModelSelector`'s OTHER call sites — Customize/schedule/task-config pages — none of which route through this flag or file). Flag ON and flag OFF are therefore both "composer renders zero default-controls footer" — parity, not regression. Did not build a footer slot on `ModelPicker` (nothing to restore). Recorded as B10 RESOLVED + an Open-decisions row in this file, per the brief's explicit instruction to write the decision down rather than resolve it silently.
  - **Binding item 2 (pre-session `select()` persistence) — wired**: `useModelPicker`'s own `select()` has no persistence seam (local `pendingKey` only, per its own doc comment). Added `resolveUnifiedModelPickSelection` (new, pure, exported from `composer-chat-input.tsx`) that translates a picked key back into whichever of the two EXISTING seams the legacy pickers already use for the same job — `local.model.set(ModelKey, {recent:true})` (catalog/OpenCode) or `runtimeModelStore.setRuntimeModel(agentName, bareModelId)` (harness-native) — parsing the key by its DOCUMENTED public shape (`ModelPickerItem.key`'s own JSDoc: `auto` / `${providerId}:${modelId}` / `` `custom:${id}` ``), stripping the item's own `providerId` field rather than blind colon-splitting. `composer-chat-input.tsx`'s `handleUnifiedModelSelect` calls the hook's real `select(key)` first (so the picker's own immediate re-render — checkmark, trigger label — still works, and a LIVE writable session still routes through `setConfigOption` exactly as the hook already does), then calls `resolveUnifiedModelPickSelection` and applies the result — skipped entirely when `live` is set, since the hook already wrote through `live.setConfigOption` in that case. Live-session wiring passes `configOptions`/`setConfigOption` straight through per the brief.
  - **Binding item 3 (`findAcpModelConfigOption` duplication) — verified, left as-is**: the SDK hook's local `findModelConfigOption` is NOT exported from `@kortix/sdk/react`'s public surface (confirmed: absent from `react/index.ts`/`react/runtime.ts` re-exports) — so there is nothing on the public surface for the web side to switch to. Left both hand-synced copies in place exactly as P0-a's own doc comment already says to. Did not export it newly (would be new public SDK surface, outside this task's scope and not requested).
  - **Binding item 4 (apps/web `bun test --isolate`)** — followed throughout; every new/edited web test file passes under `--isolate`.
  - **Discovered, not fixed** (see Discovered-this-session below): the SDK's own `ExperimentalFeatureKey` union was already missing `experimental_harnesses` before this session (pre-existing drift) — added only this task's own `unified_model_picker` key, left the pre-existing gap alone; `apps/api`'s test suite could not be executed in this sandbox (`apps/api/.env.keys` absent, no `dotenvx-armor` session) — substituted `apps/api`'s `tsc --noEmit` (env-free, clean) as the verification for the two `apps/api` files touched, and wrote/reviewed the registry unit test by hand (RED confirmed via the contract-schema test first, then the api registry addition; the api unit test itself is untested-by-execution in this sandbox specifically — same class of gap as e2e).
  - TDD: contract test genuinely RED→GREEN first (`EXPERIMENTAL_FEATURE_KEYS`/`projectFixture` assertions failed before the schema addition, confirmed via `bun test`); the composer's pure `resolveUnifiedModelPickSelection` and the `ComposerChatInput`→`SessionChatInput` prop-wiring tests were written alongside the implementation and then round-tripped RED by deliberately reverting the `vm.select` override and re-running (both persistence-seam tests failed for the right reason — "not called" — before being restored to GREEN), which is the loop this package's CLAUDE.md requires even when a test wasn't authored strictly before its first line of implementation.
  - New tests: 1 contract-schema assertion extension + 1 `unified_model_picker` key-list entry (`packages/api-contract`), 1 `apps/api` registry unit test (`unit-experimental-features.test.ts`, unexecuted here — env-blocked, see above), 8 pure `resolveUnifiedModelPickSelection` tests + 7 render/wiring tests in a new `composer-chat-input.test.tsx` (`apps/web`), 1 new `model-picker.test.tsx` regression lock for the `data-testid="model-picker-trigger"` this task added to `ModelPicker`'s trigger button (previously untested — needed for the composer fork and the e2e spec to key off).
  - `tests/e2e/specs/16-model-picker.spec.ts` (new): written, `playwright test --list` validated (registers as 1 test, no collisions — 31 total across 13 files), NOT run live — same status as spec 15 (dev stack + real harness sandbox unavailable in this environment). Flags a fresh project with both `unified_model_picker` and `experimental_harnesses` via `PATCH /projects/{id}/experimental`, then asserts: exactly one `model-picker-trigger` (zero legacy testids) for the default opencode agent; the same after switching to Claude, plus an `Experimental` badge and a `Not connected` group; picking a model changes the trigger's pill text.
  - Gates: `packages/api-contract` `bun test` 35/35. `apps/api` `tsc --noEmit` exit 0 (test suite env-blocked, see Discovered). `packages/sdk` `bun test --isolate` 1158/1158 (unchanged — the `ExperimentalFeatureKey` union addition is a pure type widening, no new runtime test needed), `tsc --noEmit` + examples exit 0, `smoke:install` passed, snapshots byte-unchanged. `apps/web` `bun test --isolate` 1246/1246 (up from a pre-task baseline this session didn't separately record, but zero failures across all 148 files including `acp-session-perf.test.tsx`), `tsc --noEmit` exit 0. `tests/` (e2e package) `tsc --noEmit` exit 0. Full report: `sdd/ws5-p0-c-report.md`.
