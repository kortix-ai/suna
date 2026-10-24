# RFC: Claude Code harness parity — durable + cloud-first

Status: draft for review (Marko). Authored 2026-10-24 from four parallel
read-only investigations (subagent-as-session, continuation primitives,
spaces-as-channels, rooms deletion). Implemented so far: the Pillar 2
user-facing rename Reminders → Loops (presentation only; see Pillar 2).
Everything else is unbuilt.

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
| /loop + reminders | **Loop** (one durable primitive) | Reminders renamed (UI/CLI/flag copy done 2026-10-24; backend term kept) |
| /goal | **Goal** (durable outcome engine) | engine exists; promote to harness primitive |
| cron / webhook | **Trigger** (durable event) | unchanged |
| agent view | board over `?parent=<id>` sessions | nearly free |
| dynamic workflows | Workflow tool / `goal.ts` | exists |
| stop hook | the `on-idle` hook | exists |
| — | **Space = configurable channel (chat/artifact/app tabs)** | new surface over existing embeds |
| p2p (prime: agents discover/message/steer) | **`agent_rooms` + `session.steer`** | keep + rework, not delete |
| inline subagent (prime `rlm.spawn`) | ephemeral `task` spec, promotable | new in Pillar 1 |

---

## Foundations (apply to every pillar)

### F1 — Persisted vs ephemeral: two lifecycles of EVERY config shape

Every yaml config entity (agent, trigger, and the rest) has **two forms**:
- **Persisted** = declared in the main-branch `kortix.yaml`. Durable, versioned,
  reviewed. The source of truth.
- **Ephemeral** = created at runtime with overrides, living in session/DB state,
  **not committed to main**. Created on the fly (by the Meta Agent / the `agent`
  tool / a running session). **Promotable** to persisted (write to yaml + a CR).

This is not new — **Kortix already does it for triggers:** a Trigger is
persisted (yaml), a Reminder/Loop is its ephemeral runtime form (DB row,
overrides, uncommitted). The RFC **generalizes that one pattern to agents and
everything else.** An ephemeral agent = an inline spec (prompt + tools + model +
overrides) that spawns a real session but isn't in yaml. So "ephemeral vs
persisted" stops being two systems and becomes **two lifecycles of the same
shape** — an overlay on the persisted base.

Implication: the `agent` tool (Pillar 1) **chooses an existing (persisted)
definition OR spawns a new ephemeral agent** (inline + overrides), and good
ephemeral ones promote to persisted. Same for Loop/Goal/Trigger: ephemeral at
runtime, promotable to yaml.

### F2 — The Meta Agent (the default cloud agent)

**Already seeded in Kortix:** `apps/api/src/projects/lib/platform-meta-agent.ts`
(a `platform: true` agent the API injects), flag `meta_agent`,
`isMetaAgentName`, with routing hooks already in `session-create.ts`
(caller-session aware). This RFC **elevates it to the default experience.**

The Meta Agent is the one "giga" cloud agent optimal at using this harness,
acting **on behalf of the user with the user's own rights** (not a scoped grant
— inherits the launching user's permissions, the act-as model). **By default a
user only ever talks to the Meta Agent.** Under the hood it:
- **routes** to the perfect specialized agent via the `agent` tool (existing
  persisted agent or a new ephemeral one),
- **binds outcomes** (creates Goals), sets Loops/Triggers,
- uses the whole harness (Drive, Channels, all builtin tools),
- is the embodiment of the two-primitive system (Agent + Goal/Loop/Trigger).

Specialized agents become things the Meta Agent routes to, not things the user
picks first. (Pairs with the Spaces work: a space scopes which agents the Meta
Agent can route to.)

### F3 — Builtin tools, enable/disable

The model tools (`read/write/edit/bash/glob/grep/agent/question/web_search/
scrape_webpage/image_search/memory/show/skill/codemode`) are **builtins with a
per-agent enable/disable toggle.** The grant model already exists:
`AgentToolsV2 = 'all' | 'none' | string[] | { exclude } | Record<string,boolean>`
(`manifest-schema/index.v2.ts:184`). Net-new is a clean UI toggle + treating the
model tools (not only registered `kortix:` tools) as first-class toggleable
builtins. The Meta Agent has all enabled by default.

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
  - **Status 2026-10-24 — the user-facing rename landed (presentation only).**
    "Loop" is now the one user-facing name for the durable session-scoped
    continuation, surfaced consistently:
    - Web: the whole `reminders` i18n namespace in
      `apps/web/translations/en.json` (title, page, chip, calendar, bulk,
      gate), the feature-flag display name, the account Automations copy, the
      notification labels, and the `@kortix/ui` capability-tab label all read
      "Loop(s)". `packages/ui/src/i18n/en.ts` is regenerated from the catalog.
    - CLI: `kortix loops` / `kortix loop` are the primary commands; help,
      examples and output strings say "Loop". `reminders` / `remind` stay as
      aliases.
    - API: the feature-flag display name + description in
      `apps/api/src/feature-flags/registry.ts` and the notification-email CTA
      say "Loops".
    - **Unchanged, on purpose (backend/wire term stays `reminder`):** the HTTP
      routes (`/sessions/:id/reminders`), DB rows, the `reminders` feature-flag
      KEY (Goals depends on it), the `@kortix/sdk` exported names (they mirror
      the wire contract one-to-one — a rename would be a breaking public-API
      change for zero user-facing gain), and the audit-event titles.
    - **Not done:** the 8 non-English catalogs still carry the old translated
      word (English `en.json` is the canonical source; a translation pass is a
      follow-up). The server-armed Goal entry and the on-idle engine are a
      separate track, untouched here.
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

**Today (2026-10-24, branch `project-admin`):** a space is a channel:
`spaces.<slug>` in `kortix.yaml` with `header` and ordered typed `tabs`
(goals, apps, artifacts, files, board, app, artifact, link) after the room
tab, at `/projects/<id>/spaces/<slug>`. The tab layout lives in the manifest,
not in a DB table (Marko: tabs are git-backed, the same edit My Kortix makes).
The per-viewer active space (`active-space-store`) still scopes the composer
and Customize. The design below is the earlier proposal.

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

## Reference: prime-agent (PrimeIntellect) RLM — full map

MIT, Rust workspace (`pa-*` crates), a persistent **IPython kernel** as the
model's control surface. arXiv:2608.23552 ("self-improving RLM harness").

- **RLM:** model output is **Python**; context is held as **variables**
  ("prompt-as-a-variable"); every tool/subagent/harness op is a **function call
  in code** (`rlm.spawn`, `goal`, `refine`, `agent_message.send`, `compact`,
  harness CRUD). Raw tools under it: `bash`, `edit`, `python_repl`. A GC
  subagent compacts kernel memory.
- **Continual Harness `H=(ρ,G,K,M)`** = prompt / subagents / skills / memory,
  written to disk on every change (durable across restarts/sessions). CRUD:
  `create_/update_/delete_{prompt_note,memory,skill,subagent}`. **`/refine`**
  applies the smallest CRUD edit (plan in background, apply at turn boundary),
  never edits the immutable base prompt, **rollback by refinement ID**, local to
  the session by default.
- **Subagents:** `rlm.spawn` = a full prime-agent instance (own model/kernel/
  session), **async, returns a handle at admission**. **Retained** subagents
  persist (recover via `list_subagents`, `mode="follow_up"`, address by session
  id); **Inactive unloads after 30 min, reloads from disk**. Steer a live child
  via `agent_message.send(receiver_role="child")`.
- **Continuation:** `/goal` (persistent objective + token budget, ends on
  `goal.complete()`, priority over queue/compaction); `/heartbeat` +
  `rlm_heartbeat` (fixed-interval re-entry); `prime-agent schedule` (specific
  time, file-backed, re-armed at boot); `/autonomous` (AutonomousDriver after
  every settled turn; `--autonomous-max-turns/-tokens/-timeout-ms`;
  `--autonomous-gate` must pass, bounded failure fed back, not rerun if
  workspace unchanged).
- **A2A / p2p:** all messaging via the daemon over a local socket; any session
  → any session, **scoped to the "nuclear family" (parent/sibling/child)**.
  `agent_message.send` / `agent_observe`. **Agents View** (Left Arrow on empty
  prompt): Running/Idle/Inactive sessions, steer or queue into any.
- **Skills** = importable Python packages (+ md), skill creator. **MCP**
  kernel-side (`/mcp login`, `mcp.list_tools`). Slack = hosted MCP over HTTP.
- **Process:** `pa-daemon` supervisor (owns sessions, failover, A2A routing,
  survives client detach), one worker/session (crash-recovers from JSONL +
  kernel snapshot), kernel process, append-only JSONL storage, CLI lifecycle
  (`attach/status/doctor/shutdown/schedule/incident`). **Not a sandbox** — runs
  model Python with user permissions.
- **Config:** `models.json` (`modelOverrides.<id>.contextWindow`), `/settings`
  (compaction `thresholdPercent`, default 95%, project overrides global),
  `/login` providers.

**Cloud-first implications for us:**
1. **Kernel-as-surface → `codemode` as the primary control surface** (decision):
   `agent()/goal()/loop()` as in-sandbox functions, not just tool calls.
2. **Refine loop is a reward-hacking risk** when self-edits are unreviewed — our
   **CR/git-reviewed** `harness-reflector` is the safer design; keep the gate.
3. **A2A family+membership scoping** for the p2p on `agent_rooms`, routable
   server-side transport (not a local socket).
4. **Retained-subagent 30-min unload = Kortix idle-volume hibernation** — parity
   for free.
5. **Whole-session snapshots:** prime has none (only per-refine revert) — a
   cloud design may want true session snapshots (we have git checkpoints).

## Reference: Claude Code harness — full map

Source: `code.claude.com/docs/en`, fetched 2026-10-24.

- **Everything is a session** (one context window, owns tool-permissions +
  memory + spawns workers). A **turn** ends when the model stops calling tools;
  hooks fire at turn/tool boundaries.
- **Subagent** = the **`Agent` tool** (**renamed from `Task` in v2.1.63**; Task
  is an alias). A delegated worker, own context + system prompt, returns only a
  summary. Defined as **md + YAML frontmatter** (`name`, `description`, `tools`,
  `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `skills`,
  `mcpServers`, `hooks`, `memory`, `isolation: worktree`, `effort`,
  `background`). Spawn: auto-delegation on `description`, or explicit. **Cap 20
  concurrent, nesting depth 3.** Built-ins: Explore, Plan, general-purpose.
  `/subtask` + `/fork` = forked subagent inheriting the full parent context.
- **Five parallel-work approaches** on two axes — *who coordinates* × *where it
  runs*: Subagents (in-session, ephemeral), **Agent view** (`claude agents`,
  supervised background, survives shell close, 48h resume, research preview),
  **Agent teams** (lead + teammates + **shared task list + mailbox
  SendMessage**; experimental, off by default; a teammate = the Agent tool with
  a `name`), **Projects** (cloud threads, project instructions ≤16k, MEMORY.md,
  overview pane, 200 threads/day; public beta), **Dynamic workflows** (JS script
  via the **Workflow** tool: `agent()/pipeline()/parallel()/phase()`, 16
  concurrent, 1000/run).
- **Continuation:** **`/goal`** = a **session-scoped prompt Stop-hook** + a
  fresh **haiku** evaluator returning met/not-met/impossible after each turn;
  check-ins after 30 min idle. **`/loop`** = cron interval (CronCreate/
  CronList/CronDelete, or self-paced via ScheduleWakeup), 7-day expiry.
  **Stop hook** = the deterministic primitive `/goal` wraps (exit 2 = don't
  stop).
- **Built-in tools** (identity strings used everywhere): `Agent`, `Bash`,
  `Read/Edit/Write/NotebookEdit`, `Glob/Grep/LSP`, `WebFetch/WebSearch`,
  `Monitor`, `Task*` (shared task list), `SendMessage/ListAgents`, `Skill`,
  `Workflow`, plan/worktree tools, `Cron*`, `ScheduleWakeup`, `RemoteTrigger`,
  `Artifact`, MCP plumbing. **Permissioning:** `ToolName(specifier)` in
  allow/deny (`Bash(npm run *)`, `Read(~/secrets/**)`, `Agent(Explore)`,
  `WebFetch(domain:…)`); **modes** default/acceptEdits/auto/dontAsk/
  bypassPermissions/plan.
- **Hooks** (33 events incl. `Stop`, `SubagentStop`, `PreToolUse`,
  `TeammateIdle`, `PreCompact`…), **slash commands** (built-in + bundled skills
  + custom `.claude/skills/*`), **output styles**, **skills** (SKILL.md, the
  Agent Skills standard), **MCP** (`mcp__server__tool`), **settings.json**
  (precedence user→project→local→managed), **Agent SDK** (TS/Python) + headless
  `claude -p`.

**Takeaways:** two axes = *who coordinates* × *where it runs*; cloud-first =
coordinator is the Meta Agent/service, runtime is always cloud sandboxes.
Continuation = an evaluator separate from the doer, after every turn. Isolation
= worktree (cloud = per-thread clone). Non-Claude tools = MCP.

## Three-system synthesis (the money table)

| Concept | Claude Code | prime-agent | Kortix today | Kortix target |
|---|---|---|---|---|
| spawn worker | `Agent` tool (md+frontmatter) | `rlm.spawn` (code) | pi `task` (in-process) | **`agent` tool → real session**, inline or declared |
| control surface | tool-call protocol | **Python kernel (code)** | tool calls + `codemode` | adopt codemode as 1st-class |
| outcome loop | `/goal` (Stop-hook + evaluator) | `/goal` + `goal.complete()` | Goals (Files + on-idle) | **Goal** primitive, daemon-armed |
| interval loop | `/loop` (cron) | `/heartbeat` + `schedule` | **Reminders (= Loop)** + Triggers | **Loop** (durable) |
| event | — | — | Triggers (cron/webhook) | **Trigger** |
| autonomous | `/effort ultracode` | `/autonomous` + gates | Workflow budgets | Goal + budgets/gates |
| monitor board | Agent view | Agents View | sidebar child sessions | **Agent view** (free) |
| teams | Agent teams (lead+tasklist+mailbox) | A2A (family-scoped) | `agent_rooms` | **p2p on rooms + steer** |
| projects/threads | Projects (cloud) | sessions | **projects + sessions** | = (already cloud) |
| workflows | Dynamic workflows | GC subagent / code | **Workflow tool** | = |
| self-improve | — | Continual Harness `/refine` | harness-reflector (CR) | keep CR-gated (safer) |
| persisted vs ephemeral | files vs inline | retained vs spawn | **yaml vs DB (triggers)** | **generalize to all** |
| tools on/off | `ToolName()` perms | kernel imports | AgentToolsV2 grant | **builtin toggles + UI** |
| default agent | main session | the agent | `kortix` agent | **Meta Agent (user rights)** |
| non-native tools | MCP | MCP (kernel) | MCP | MCP |
| isolation | worktree | session dir | sandbox/session | sandbox (already) |

**The headline:** on nearly every row Kortix is already at parity or ahead —
because our sessions are already cloud, durable, isolated, and permissioned.
The net-new is small and concentrated: `agent`-tool reroute + inline specs,
Loop/Goal consolidation, p2p-on-rooms, and the Meta Agent as default.

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
