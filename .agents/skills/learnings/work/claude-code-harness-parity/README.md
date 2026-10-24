# RFC: Claude Code harness parity — durable + cloud-first

Status: draft for review (Marko). Authored 2026-10-24 from four parallel
read-only investigations (subagent-as-session, continuation primitives,
spaces-as-channels, rooms deletion). Nothing implemented yet.

## Thesis

**Map every Claude Code concept, strip the ephemerality, make it a durable
cloud session/state.** Claude Code's primitives are ephemeral and local (they
die when the CLI closes, run on your machine). Kortix's job is to offer the
identical concepts but **durable** (survive a sandbox/box death) and
**cloud-first** (run as real Kortix sessions on Platinum, driven by the
server, not a local process).

The headline finding across all four tracks: **this is mostly WIRING EXISTING
PRIMITIVES, not building new ones.** The parent/child session model, the
scheduler, the on-idle hook, and the embed surfaces (SessionThread, Files,
AppPreview) already exist.

## The concept map

| Claude Code (ephemeral/local) | Kortix (durable/cloud) | State |
|---|---|---|
| subagent (in-process child) | **real cloud Kortix session** | reroute, not rebuild |
| /loop + reminders | **Loop** (one durable primitive) | Reminders renamed |
| /goal | **Goal** (durable outcome engine) | engine exists; promote to harness primitive |
| cron / webhook | **Trigger** (durable event) | unchanged |
| agent view | board over `?parent=<id>` sessions | nearly free |
| dynamic workflows | Workflow tool / `goal.ts` | exists |
| stop hook | the `on-idle` hook | exists |
| — | **Space = configurable channel (chat/artifact/app tabs)** | new surface over existing embeds |
| agent_rooms | **DELETE** | — |

---

## Pillar 1 — Subagent = real cloud session (the keystone)

**Today:** pi's `task` tool mints an in-process `ChildSession` inside the same
daemon (no sandbox, no DB row). `apps/kortix-sandbox-agent-server/src/harness/pi/runtime.ts`
(`spawnSession`, `ChildSession` 234-253, 1486-1602), `.../pi/extensions/subagents.ts`.

**Key reuse:** a real parent/child session model **already exists** —
`projectSessions.parentSessionId`, set at create from the caller's
session-bound `KORTIX_TOKEN` (`session-create.ts:262-283,1150`), listed via
`?parent=<id>` (`session-list.ts:173-194`). The factory workers already use it,
and the whole child-session UI already renders it (`TaskTool`,
`SubSessionModal`, `useSubAgentThread`, sidebar child rows). `getChildSessionId`
reads `metadata.sessionId`.

**Change:** `task` stops minting an in-process child; it does what a factory
worker already does — `POST /v1/projects/:id/sessions` (auto-linked as a child),
which provisions the child's own sandbox + pi, drives the prompt, waits for
turn-end, returns the final message as `<task_result>`. **The tool keeps its
exact contract, so the web renderers need ZERO change** — the id now names a
real session. The **agent view** is a board over the existing parent-filtered
session list.

**Hard tradeoff / guardrails (must be in scope):**
- Cost/latency: real session = sandbox provision + pi boot *per `task`* (vs ~0
  today). Idle-reap the child box right after the summary; warm-pool for
  read-only `explore`.
- **Per-parent concurrency cap** (parallel `task` = N sandboxes); decide if
  subagents count against the account session quota (`enforceAdmission`).
- **Nesting policy**: a real child runs its own pi → can spawn its own
  subagents. Gate `permission.task` by default. (`delegation_depth` already in
  audit.)
- Billing: confirm child sandbox cost rolls up to the parent via
  `parent_session_id` (`session-costs.ts:974,1016`). Ties to the
  **"name the account before spending"** learning.

Files: `pi/extensions/subagents.ts`, `pi/runtime.ts`, `pi/surface.ts:135-153`;
`apps/api/src/projects/session-open/`, `lib/session-create.ts`,
`lib/session-list.ts`, `routes/project-sessions.ts:188`.

---

## Pillar 2 — Continuation: Loop / Goal / Trigger (one engine)

All three are the same mechanism — a `project_trigger_runtime` row + the
scheduler + the `on-idle` hook — differing only in **what starts the next
turn**: an interval (Loop), an outcome verdict (Goal), an external event
(Trigger).

- **LOOP = Reminders renamed.** A reminder *is already* a session-scoped,
  durable, server-scheduled trigger (`sessionMode='pinned'`,
  `scheduleSpec.reminder`, survives sandbox death via `repinSessionReminder`).
  There is no ephemeral loop. ~95% reuse: rename the surface + redirects.
  **Keep the `reminders` feature-flag key** (Goals depends on it) or alias it
  atomically. Storage: DB (correct — ad-hoc, not reviewed).
- **GOAL = durable outcome engine, promoted to a harness primitive.** Exists
  today as a Files folder (`Goals/<slug>/goal.json`), a CLI state machine, a
  heartbeat Loop, and the `on-idle` goal check. Net-new: the **daemon arms
  the continuation**, not the model (today the model must run `kortix goals
  new`, and a fallback exists *because the model skips it*). Keep goal body in
  Files, heartbeat in DB. Optional: read/transition API routes (SDK already
  models the shape read-only).
- **TRIGGER = cron/webhook, unchanged.** Project-scoped sibling of Loop
  (project interval vs session interval, same table/scheduler).

**Framing:** three shapes, one scheduler + one `on-idle` hook. Mostly
consolidation + a rename + a daemon-armed Goal entry.

Files: `apps/api/src/projects/trigger-types.ts`, `lib/session-reminders.ts`,
`trigger-execution-store.ts`, `apps/kortix-sandbox-agent-server/src/harness/shared/on-idle-hook.ts`,
`apps/cli/src/commands/goals.ts`, `packages/sdk/.../goals.ts`.

**Open decisions:** rename Reminders→Loops without breaking the `reminders`
flag (Goals coupling); whether `goal()` is a tool call or auto-registers the
continuation server-side; Goal heartbeats vs the 200/project reminder cap.

---

## Pillar 3 — Spaces = configurable MS-Teams channels

**Today:** a space = one display group of agents (`groupByDomain`), chosen
per-viewer (`active-domain-store`, localStorage, never `kortix.yaml`), scoping
the composer + Customize + the space-aware home. No tabs, no per-space layout.

**Design:** a space gains an ordered **tab list**, each tab one of:
`chat` (a durable room session), `artifact` (a Files/Drive path — doc or HTML
page), `app` (a Kortix App). Config is a **declarative reference** (agent slug /
file path / app id), never a transient handle, so layout survives restarts.

**Storage — hybrid (recommended):**
- Space *existence + label/description/order* → manifest `domains.<slug>`
  (already there, validated, reviewed).
- Tab *layout* (ordered typed references) → **mutable DB table**
  (`project_spaces` / `space_tabs`), edited via a new SDK resource
  `kortix.project(pid).space(slug).tabs.{list,add,update,reorder,remove}` →
  API route. Instant "Edit tabs" with no commit; honors the active-space rule
  that space/instance state is not `kortix.yaml`.

**Embeds (build nothing new):**
- chat → `useSession(pid, sid)` + `<SessionThread hideHeader>`.
- artifact → `FilePreviewHost`/`file-content-renderer`/`html-preview` (HTML via
  `ARTIFACT_CONTENT_URL` sandboxed iframe).
- app → `<AppPreview>` + the keep-alive frame pool (signed `apps.access.session`).
- tab chrome → clone `capability-tabs.tsx`.

**Required behavior change:** `groupByDomain` omits a declared domain with zero
agents; a channel-first space must exist with only tabs and no agents. Fix the
grouping + source the sidebar from declared domains, not only agent-derived
groups.

**Biggest open decision — chat-room semantics:** is a `chat` tab ONE shared
persistent session (every space member posts into the same thread — true Teams
behavior; needs participants + concurrency, pi `session.steer`) or per-viewer?
Decide before building. (Note: this overlaps the deleted `agent_rooms` concept —
reconcile.)

Gate the whole feature behind a flag (per "a flag gates every surface") until
`ARTIFACT_CONTENT_URL` + the Apps edge are in prod.

---

## Pillar 4 — Delete `agent_rooms`

~50 files: DB (`rooms`, `room_messages`, `room_members`, `session_idle_watches`
+ notification `room_id`/`room_thread_seq`/`message` kind), API
(`projects/rooms/`, `routes/rooms.ts`, the `fireIdleWatches` turn-end hook),
UI (sidebar nav, room-message rendering), **SDK public exports** (`useRooms`
et al. — semver-breaking removal, follow the sdk skill), IAM leaves, the
`kortix-rooms` skill, tests. Ordered removal: web → UI → SDK → API → shared →
**DB DROP migration last** → tests; regenerate `embedded.generated.json`,
`routes.generated.json`, `audit-http-routes.generated.ts` + fix the IAM
parity test.

**`kortix-teams` is the Microsoft Teams channel connector — KEEP.** Zero
relation to Rooms.

Low-risk (off by default, no prod data expected); wide but bounded. Good first
PR to clear the deck.

---

## Parked — Drive / volume ↔ git

Shelved until the git-parity question is clear. Direction captured: one project
"Kortix Drive" (persistent project volume), the Drive is the working tree, git
versions the tracked paths (binaries/caches/logs = volume-only), per-agent
**folder scoping** is the hard access boundary. Spaces align optionally to Drive
folders; `domain` stays soft/optional. **Not** a continuous bidirectional mirror.
Revisit after the harness + spaces tracks land.

---

## Sequencing (parallelizable)

1. **Delete `agent_rooms`** — bounded, clears the deck, removes a concept that
   overlaps chat-room tabs. (1 focused PR.)
2. **Subagent = real session** — the keystone; unlocks agent view + real
   delegation. Build with the concurrency/cost/nesting guardrails. (Harness +
   API.)
3. **Loop/Goal/Trigger consolidation** — rename Reminders→Loops (keep flag),
   make Goal a daemon-armed harness primitive. (API + CLI + UI, mostly rename.)
4. **Spaces as channels** — the tab model + DB store + the three embeds + the
   empty-domain fix. (Largest; needs the chat-room-semantics decision first.)
5. **Agent view** — the board, on top of (2).
6. **Drive/volume** — after the above, once the git question is settled.

## Decisions needed from Marko before building

1. **Subagent cost:** accept sandbox-per-subagent + a concurrency cap, with a
   warm-pool for `explore`? Do subagents count against the session quota?
2. **Nesting:** allow a subagent-session to spawn its own subagents (gated), or
   deny by default?
3. **Reminders→Loops rename:** go ahead (surface rename, keep the flag key)?
4. **Goal as harness primitive:** a `goal()` tool the agent calls, or any goal
   auto-registers the server-side continuation?
5. **Chat-room tab:** one shared persistent session per channel, or per-viewer?
   (This is the pivotal spaces decision.)
6. **Tab storage:** hybrid (manifest for existence, DB for tab layout) — OK?
