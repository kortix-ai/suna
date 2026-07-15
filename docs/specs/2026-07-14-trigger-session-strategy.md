# Trigger Session Strategy — recurring schedules bound to a session

Date: 2026-07-14
Status: SCOPE (build next session — not yet implemented)

## Goal

Let a scheduled/webhook trigger declare **how it uses sessions across runs**, as a
first-class, user-selectable strategy:

| Strategy | Meaning | Today |
| --- | --- | --- |
| **`fresh`** | Every fire spawns a brand-new session (new sandbox/branch). | ✅ backend exists |
| **`reuse`** | Every fire re-prompts the trigger's *own* looping session (resume its sandbox); create one on first run. | ✅ backend exists (System A) |
| **`pinned`** | Every fire re-prompts **a specific session the user chose** (by id), kept in a loop. | ❌ does not exist anywhere |

Plus: make all of this **actually reachable in the UI on the canonical backend**,
which today it is not.

## Ground truth (why this isn't just "add a dropdown")

Investigated 2026-07-14 (two codebase sweeps). There are **3 trigger UIs backed by 2
disconnected systems**:

- **System A — git-manifest** (`apps/api` `/v1/projects/:id/triggers`; config lives in
  the repo `kortix.yaml`/`.toml` manifest, runtime state in `project_trigger_runtime`).
  This is the robust, platform-level, CR-gated system. It **already implements
  `sessionMode: 'fresh'|'reuse'`** end-to-end at the API/fire layer
  (`apps/api/src/projects/lib/triggers.ts:674-797`, reuse lookup `:648-666`).
  Frontend surface: `apps/web/src/components/projects/schedule-view.tsx` (Customize →
  Schedules/Webhooks). **But this surface exposes NO session-mode control** — the SDK
  client types (`packages/sdk/src/core/rest/projects-client/triggers.ts:64-100`) don't
  even carry `session_mode`, so every trigger created here is locked to the `fresh`
  default despite the backend supporting `reuse`.
- **System B — sandbox daemon** (`${sandbox}/kortix/triggers`; per-sandbox, daemon
  source not in this repo). Frontend surfaces: the global `/scheduled-tasks` page
  (`scheduled-tasks-page.tsx`) and the project-settings **Triggers tab**
  (`triggers-tab.tsx`), both via `use-scheduled-tasks.ts`. These **do render a working
  `new|reuse` Select** (`task-config-dialog.tsx:538-564`, gated to `actionType ==='prompt'`)
  — but against the thinner daemon backend, with different trigger identity (`triggerId`
  GUID vs System A `slug`).

Consequences:
1. The good backend (A) has no session-mode UI; the reachable UI (B) is the weaker backend.
2. A trigger created in one system is invisible to the other — fragmented mental model.
3. "reuse" is a boolean everywhere — **no session picker** exists in any surface.
4. `triggers-tab.tsx` (System B) has **no RBAC gate** (unlike `schedule-view.tsx`, which
   checks `PROJECT_TRIGGER_CREATE`). Security bug to fix in passing.

## Decision: consolidate on System A (git-manifest) as canonical

System A is the right home: it is git-tracked + change-request-gated, it already models
`session_mode`, and `pinned` needs a real FK to `project_sessions` (a platform table A
owns, not a per-sandbox daemon concept). Plan:

- Make **System A the canonical** trigger + session-strategy surface. Add the missing
  `session_mode` (and new `pinned`) support through A's SDK client + `schedule-view.tsx`.
- **Deprecate System B's session-mode divergence**: either (a) point the
  `/scheduled-tasks` + project Triggers-tab UIs at System A too, or (b) keep B for its
  distinct board/ticket use but stop presenting a *second, different* session-mode
  semantics. Exact bridge is an open question (§ Open questions) — but the feature
  itself is built on A.

## The three strategies — precise semantics

- **`fresh`** (default): `createSession` per fire. Unchanged.
- **`reuse`**: the trigger loops **its own** session. First fire creates + tags it
  (`metadata.trigger_slug`); subsequent fires `continueSession` on the newest non-failed
  session with that tag (`findReusableTriggerSession`). Already implemented; just needs UI.
- **`pinned`** (NEW): the trigger loops **a specific `session_id` the user selected**.
  Every fire `continueSession` on exactly that id. Robust behavior:
  - Persisted, not re-derived — survives API restarts and unrelated session churn.
  - **FK → `project_sessions.session_id`, `onDelete: 'set null'`** — if the pinned
    session is deleted, the pin clears; the trigger then **falls back to `reuse`**
    behavior (or errors, configurable) rather than silently losing the loop.
  - Validated at write time: the id must exist, belong to the trigger's project, and be
    resumable (not `failed`/terminal).
  - Concurrency: if a pinned session is shared (a trigger + a human both prompting it),
    fires must serialize on the session lease so a fire can't interleave mid-turn.

## Change-list (mapped, per layer)

1. **DB** — add `session_id text` (nullable, FK `project_sessions.session_id`
   `onDelete set null`) to `project_trigger_runtime`
   (`packages/db/src/schema/kortix.ts:683-713`) + a `packages/db/migrations` migration
   (use the `migration` skill). This row is already keyed `(project_id, slug)` → natural
   home for the pin.
2. **DSL / manifest** — extend `GitTriggerSpec.sessionMode` to `'fresh'|'reuse'|'pinned'`
   and add `pinnedSessionId` (`apps/api/src/projects/triggers.ts:124-140`); update
   `parseTriggerDraft`/`draftToSpec`/`specToBody`/`triggerSpecToTomlEntry`.
3. **Fire logic** — in `fireGitTrigger` (`apps/api/src/projects/lib/triggers.ts:674-797`)
   branch `pinned` → `continueSession` against the stored `session_id` (skip the
   `findReusableTriggerSession` derived query); handle cleared-pin fallback.
4. **API contract + routes** — add `session_id` to `TriggerSchema`/`TriggerDraft`
   (`packages/api-contract/src/index.ts:441-462`) and accept/validate it in
   `POST`/`PATCH /{projectId}/triggers[/{slug}]` (`r4.ts:440-622`): existence +
   project-ownership + resumable checks.
5. **Manifest-schema gate** — add the new mode/field to
   `packages/manifest-schema/src/index.ts:855-866` + `json-schema.ts:327-328` (the
   CR-merge validation gate).
6. **SDK client (System A)** — add `session_mode` + `session_id` to
   `CreateProjectTriggerInput`/`UpdateProjectTriggerInput`
   (`packages/sdk/src/core/rest/projects-client/triggers.ts:64-100`). This alone unblocks
   `reuse` in the UI.
7. **UI** — in `schedule-view.tsx` `CreateTriggerModal` + edit sheet: add a **Session
   Strategy** control (`fresh | reuse | pinned`) and, when `pinned`, a **session picker**
   (search/select over the project's `project_sessions`). Reuse `AgentSelector`/
   `ModelSelector` patterns for the picker. Surface `session_mode`/`session_id` in the
   list + detail views.
8. **Fix RBAC** — add the `PROJECT_TRIGGER_CREATE` gate to `triggers-tab.tsx` to match
   `schedule-view.tsx`.

## Robustness checklist ("most robust in any aspect")

- Pinned id is a real FK with `set null` → no dangling pins; graceful fallback.
- Write-time validation (exists + owned + resumable) → no pinning a bogus/foreign session.
- Fires serialize on the session lease → no mid-turn interleave on a shared session.
- Manifest is the source of truth + CR-gated → strategy changes are auditable/reviewable.
- Survives restarts (persisted pin, not derived) → the loop is stable across deploys.
- Clear per-fire attribution (`created_by` = agent service account) preserved on all modes.
- Observability: record which session each fire used + the resolved mode in
  `project_trigger_runtime`/execution history so a user can see the loop working.

## Open questions

- **System B fate**: bridge the `/scheduled-tasks` + Triggers-tab UIs onto System A, or
  keep B for board/tickets and only unify the session-strategy semantics? (Biggest call.)
- **Cleared-pin behavior**: fall back to `reuse`, fall back to `fresh`, or hard-error and
  pause the trigger? (Lean: fall back to `reuse` + surface a warning.)
- **Cross-trigger pinning**: allow two triggers to pin the same session? (Lean: yes, but
  serialize; document the shared-loop semantics.)
- **Prompt-only gating**: should session strategy apply beyond `prompt` action types?

## Phased plan

1. **Unblock `reuse` on the canonical surface** (low risk, high value): SDK client +
   `schedule-view.tsx` control for the *already-implemented* `fresh|reuse`. Ships the
   loop-your-own-session strategy users can't currently pick.
2. **Add `pinned`**: DB migration → DSL/manifest → fire-logic → API/contract → schema gate.
3. **Session picker UI** + list/detail surfacing + RBAC fix.
4. **Decide + execute System B consolidation** (open question) so there's one coherent
   trigger + session-strategy story.
