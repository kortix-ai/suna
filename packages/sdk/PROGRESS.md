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
