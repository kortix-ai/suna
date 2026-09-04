# Monitoring (session stage board + trigger runs)

Status: implementation contract, 2026-09-04. Feature flag `monitoring`.

## Problem

A user running many agent sessions cannot see, in one place, where each
session is in its work: still planning, waiting for a human go-ahead, working,
awaiting review, or done. The runtime `status` (`queued|running|stopped|…`)
says whether a sandbox is alive, not whether the agent is blocked on a person.
Trigger-created sessions have no per-trigger view of their runs at all.

## Solution

One project page, `/projects/:id/monitoring`, behind the per-project feature
flag `monitoring` (experimental, default off, `enforcement: 'routes'`).

1. **Stage board** — a kanban with six fixed columns. Every session visible to
   the caller is exactly one card. The agent moves its own card from inside
   the sandbox with the CLI; a human moves any visible card from the page.
2. **Trigger runs** — one section per trigger (`GET /triggers`) listing the
   sessions that trigger created (`metadata.trigger_slug`), newest first, with
   runtime `status`, stage, and timestamps. Not a kanban.

## Data model

No migration. One server-managed key on `project_sessions.metadata`:

```jsonc
"stage": {
  "value": "ready",              // SessionStage (below)
  "needs_approval": true,        // only meaningful in "ready"
  "note": "Plan in PLAN.md",     // ≤ 500 chars, optional
  "updated_at": "2026-09-04T10:00:00.000Z",
  "updated_by": "agent" | "<user uuid>"
}
```

`SessionStage` = `backlog | planning | ready | in_progress | review | done`.
The column order is that list. A session with no `stage` key renders in
**Backlog**. `stage` joins `PATCH_SERVER_MANAGED_SESSION_METADATA_KEYS`, so
`PATCH /sessions/:id {metadata:{stage}}` → 400; only the route below writes it.

Column labels: Backlog, Planning, Ready, In progress, Review, Done.

## API

`PUT /v1/projects/:projectId/sessions/:sessionId/stage`

- Body `{ stage: SessionStage, needs_approval?: boolean, note?: string | null }`.
- Order: uuid check → project `session` action (membership authz) →
  `requireFeatureFlag(c, loaded.row.metadata, 'monitoring')` → 403
  `feature_disabled` → body validation (400) → `loadVisibleSession` (404 when
  invisible) → agent-own-session check → write. The flag and validation run
  before the session lookup, so MON-2..5 need no real session.
- A session-bound caller (`callerKortixSessionId(c)` non-null) may only set the
  stage of **its own** session → otherwise 403 `{ error: 'An agent can only move its own session' }`.
- Invalid `stage` → 400 `{ error: 'Invalid stage' }`. `note` longer than 500
  chars → 400. `needs_approval` non-boolean → 400.
- Writes `metadata.stage` (whole object replaced), bumps `updated_at`.
  `updated_by` is `'agent'` for a session-bound caller, else the user id.
- Returns 200 with the serialized session (same shape as `GET /sessions/:id`).

Serializer: `ProjectSession.stage` is exposed top-level as the object above or
`null`. `metadata.stage` is also still in `metadata` (it is not a heavy key).

## SDK (`@kortix/sdk`)

- Types: `SessionStage`, `SESSION_STAGES` (ordered tuple), `SessionStageState`
  (`{ value, needs_approval, note, updated_at, updated_by }`),
  `SetSessionStageInput` (`{ stage, needs_approval?, note? }`).
- `ProjectSession.stage: SessionStageState | null`.
- `setProjectSessionStage(projectId, sessionId, input): Promise<ProjectSession>`.
- `sessionTriggerSlug(session): string | null` — reads `metadata.trigger_slug`.
- React: `useSetSessionStage(projectId)` mutation that invalidates the project
  session list query key.
- Flag key `monitoring` added to `FeatureFlagKey` union + `FEATURE_FLAG_KEYS`.

## CLI

`kortix sessions stage [<session-id>] <stage> [--needs-approval] [--note "<text>"] [--json]`

- `<session-id>` defaults to `$KORTIX_SESSION_ID` (set inside every sandbox).
  Neither → usage error, exit 1.
- `kortix sessions stage [<session-id>]` with no `<stage>` prints the current
  stage (`--json` prints the `stage` object).
- Stage aliases accepted: `in-progress`, `inprogress`, `progress` → `in_progress`;
  `plan` → `planning`; `todo` → `backlog`.
- 403 `feature_disabled` → prints the server message and exits 1.

## Approval loop

1. Agent finishes planning and runs
   `kortix sessions stage ready --needs-approval --note "Plan: …"`. Its turn ends.
2. The card sits in **Ready** with an "Approve" / "Send back" control.
3. Approve = `PUT …/stage {stage:'in_progress'}` then a durable prompt
   (`createSessionPrompt`) with text `Approved. Proceed with the plan.` plus the
   optional reviewer note. Send back = `PUT …/stage {stage:'planning'}` then a
   prompt with the reviewer's feedback.
4. Without `--needs-approval` the agent moves itself straight on:
   `kortix sessions stage in_progress`, later `review`, then `done`.

## Web

- Route `apps/web/src/app/(app)/projects/[id]/monitoring/page.tsx` (top-level like
  Apps — the capability tab bar is manager-tier `customize`, this page is for
  anyone who runs a session).
- Feature folder `apps/web/src/features/workspace/capabilities/monitoring/`.
- Sidebar row `ProjectMonitoringNavItem` (flag-gated, beside Apps).
- Menu-registry row `proj-monitoring` with `requiresFlag: 'monitoring'`.
- Data: the sidebar's session query (`qk.project.sessions(projectId)` +
  `listProjectSessions`, same refetch interval) + `useProjectTriggers`. No new
  transport.

## Tests

- REST flows `MON-1..MON-5` in `tests/src/flows/monitoring.flow.ts`, spec
  section `## 11c. Monitoring` in `tests/spec/end-to-end.md`.
- SDK unit tests beside `sessions.ts`; CLI unit test for arg parsing.
- Web contract tests for the sidebar/menu/tab gating.
