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
| p2p (prime: agents discover/message/steer) | **`agent_rooms` + `session.steer`** | keep + rework, not delete |
| inline subagent (prime `rlm.spawn`) | ephemeral `task` spec, promotable | new in Pillar 1 |

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

**Ephemeral / inline subagents (gap vs prime-agent `rlm.spawn` + Claude Code
inline `task`).** Today `subagent_type` must resolve to a declared yaml agent
(or built-in `general`/`explore`) — "everything in yaml" is the pain point. Add:
`task` accepts an **inline spec** (`prompt`, a tool/permission set, a model) and
spawns a real session from it with no yaml declaration. A good inline subagent
is **promotable** to a durable "retained subagent" spec (prime's
subagent-spec-as-durable-state) — written to `kortix.yaml` agents or a durable
subagent store. So subagents come in two forms: **inline/ephemeral** (on the
fly) and **declared/retained** (reusable). Both spawn a real cloud session.

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

## Pillar 4 — `agent_rooms` = the p2p substrate (KEEP, requalify)

**Reversed from "delete" (2026-10-24):** `agent_rooms` (channels / threads /
members / `session_idle_watches`) is the obvious substrate for the **p2p
system** prime-agent describes — *running agents discover one another, exchange
messages, orchestrate and **steer** each other without routing through the
user.* Do NOT delete it. Requalify as: the durable, cloud, server-side
inter-agent + human messaging layer.

Pair it with pi's existing **`session.steer`** capability (steer active work)
and the real-session subagents from Pillar 1 (children discover/message each
other via parent/child + rooms). This is the cloud-first p2p: durable
server-side messaging, not local IPC.

**Work here is evaluation + rework, not removal:** does the current rooms model
(channels-only, Slack-thread shaped, under More) match the p2p we want (agent
discovery, direct agent↔agent messages, steer)? Gaps to close vs prime-agent:
agent-initiated messages to another running agent, discovery of running
agents, and steer. The inventory (DB/API/UI/SDK surface) from the deletion
pass is now the **map of what to build on**, not what to tear out.

**`kortix-teams` is the Microsoft Teams channel connector — KEEP.** Unrelated.

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

1. **Subagent = real session, + inline/ephemeral spec** — the keystone; unlocks
   agent view, real delegation, and on-the-fly subagents (the yaml pain). Build
   with the concurrency/cost/nesting guardrails. (Harness + API.)
2. **Loop/Goal/Trigger consolidation** — rename Reminders→Loops (keep flag),
   make Goal a daemon-armed harness primitive; add `/autonomous`-style budgets.
   (API + CLI + UI, mostly rename.)
3. **p2p on `agent_rooms` + `session.steer`** — rework rooms into the agent
   discovery + direct messaging + steer layer (not a deletion).
4. **Spaces as channels** — the tab model + DB store + the three embeds + the
   empty-domain fix. Its chat-room tab reuses the p2p/rooms session model, so
   it follows (3). (Largest; needs the chat-room-semantics decision.)
5. **Agent view** — the board, on top of (1).
6. **Drive/volume** — after the above, once the git question is settled.

## Prime-agent (PrimeIntellect) — what we take, what we already beat

Prime-agent is **local, terminal-first, not a sandbox** (model code runs with
the user's permissions, work is local). Its strong ideas and our stance:
- **RLM** (context-as-variables + programmatic subagent calls in a Python REPL)
  → our `codemode` + Workflow tool; adopt the principle, cloud-first (the REPL
  is a sandbox, subagents are real sessions).
- **`rlm.spawn` ephemeral subagents** → Pillar 1 inline-spec subagents.
- **Retained subagent specs** → promotion target for inline subagents.
- **Continual Harness / `/refine`** → we already have `harness-reflector` +
  `kortix-harness-refinement` + memory, and ours is *stronger* (git/CR,
  reviewable) than prime's local snapshots; borrow only the granularity.
- **Agents discover/message/steer** → Pillar 4 p2p (`agent_rooms` +
  `session.steer`).
- **`/heartbeat` `/goal` `schedule` `/autonomous`** → Pillar 2 Loop/Goal/Trigger.

**The moat:** we build prime's concepts on a cloud-native, durable,
multi-tenant substrate (isolated sandboxes, IAM, UI, connectors, billing).
Durable + cloud-first is the differentiator, not a feature.

## Decisions needed from Marko before building

1. **Subagent cost:** accept sandbox-per-subagent + a concurrency cap, with a
   warm-pool for `explore`? Do subagents count against the session quota?
2. **Nesting:** allow a subagent-session to spawn its own subagents (gated), or
   deny by default?
3. **Reminders→Loops rename:** go ahead (surface rename, keep the flag key)?
4. **Goal as harness primitive:** a `goal()` tool the agent calls, or any goal
   auto-registers the server-side continuation?
5. **Chat-room tab + p2p:** one shared persistent session per channel, or
   per-viewer? This is now the SAME decision as the p2p model — a channel is a
   shared durable session where humans + agents post and steer. (Pivotal.)
6. **Tab storage:** hybrid (manifest for existence, DB for tab layout) — OK?
7. **Inline/ephemeral subagents:** allow `task` to take an inline spec
   (prompt+tools+model, no yaml) and promote good ones to retained specs?
8. **p2p on rooms:** rework the existing `agent_rooms` into the agent
   discovery + direct-message + `session.steer` layer, rather than a fresh
   build?
