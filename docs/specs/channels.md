# Channels — Slack/Telegram integration design

Status: **draft for review**
Scope: how inbound chat events route to Kortix sessions, how conversation
history is preserved, how multiple projects share a workspace, and how the
in-sandbox CLIs are constrained per project.

---

## 1. Goals / non-goals

**Goals**
- A chat message (Slack `@mention`, thread reply, DM) reliably reaches the
  *correct* Kortix session so conversation history is continuous.
- One Slack workspace can serve multiple Kortix projects.
- Per-project control over what the agent's in-sandbox CLI may do.
- The model generalizes to Telegram and to future in-sandbox CLIs.

**Non-goals (this round)**
- Slack interactivity (buttons / modals firing `block_actions`) beyond the
  one disambiguation prompt described in §6.
- Slash-command routing.
- Cross-Kortix-account workspace sharing (one workspace = one Kortix account).

---

## 2. Entities

| Entity | Key | Notes |
|---|---|---|
| Slack workspace | `team_id` | One bot install per workspace (OAuth) |
| Slack channel | `channel_id` | public / private / im / mpim |
| Slack thread | `thread_ts` | Parent message ts; replies carry it |
| Slack message | `ts` | Unique within channel |
| Kortix project | `project_id` | Owns sessions; has its own sandbox image |
| Kortix session | `session_id` | Runs in one sandbox; holds opencode convo |

Current tables (post-merge):
- `chat_channel_bindings` — `(platform, workspace_id)` UNIQUE → `project_id`
- `chat_threads` — `(platform, workspace_id, thread_id)` UNIQUE → `session_id`

The `chat_channel_bindings` unique key is the multi-project blocker (§6).

---

## 3. Slack event taxonomy

Events the manifest subscribes to, and how we treat each:

| Event | Fires when | Trigger an agent turn? |
|---|---|---|
| `app_mention` | Bot is @mentioned | **Yes** |
| `message.im` | DM to the bot | **Yes** |
| `message.channels/groups/mpim` | Any message in a channel the bot is in | **Only** if `thread_ts` belongs to a bot-owned thread |
| `message` subtype `message_changed` | A message was edited | No (ignore) |
| `message` subtype `message_deleted` | A message was deleted | No |
| `message` subtype `bot_message` / has `bot_id` | A bot posted (incl. us) | No — **echo guard** |
| `reaction_added` / `reaction_removed` | Emoji on a message | No (v1) — see §11.5 |
| `member_joined_channel` | Someone joined | No |
| `file_shared` | A file was shared | No (file arrives attached to a `message`) |
| `url_verification` | Slack endpoint handshake | Reply `challenge` synchronously |
| `app_uninstalled` / `tokens_revoked` | App removed from workspace | Clean up — see §7.L |

**Rule:** an agent turn is triggered only by `app_mention`, a DM, or a
non-subtype message inside a thread we already own. Everything else is
recorded or ignored. This keeps the bot from reacting to every line of
channel chatter.

---

## 4. The routing problem

Inbound event = `(team_id, channel_id, thread_ts?, ts, user, type, text)`.
We must resolve **(project_id, session_id)** before doing anything.

Two sub-problems, independent:
1. **project resolution** — which Kortix project owns this conversation
2. **session resolution** — new session, or deliver to an existing one

---

## 5. Resolution algorithm

```
resolve(event):
  threadKey = event.thread_ts ?? event.ts          # parent ts of the thread
  ackReaction(event)                               # 👀 within ~1s — §8.2

  # ── session resolution: thread already owns a session ───────────────
  row = chat_threads[(platform, team_id, threadKey)]
  if row:
      if sessionAlive(row.session_id):
          deliver_followup(row.session_id, event)   # continuity
          return
      else:
          # sandbox stopped/archived/evicted — resume policy, §7.K
          mark row stale; fall through to spawn

  # ── project resolution ──────────────────────────────────────────────
  project = resolveProject(event)                   # §6
  if project == AMBIGUOUS:
      postProjectPicker(event)                       # §6, one-time
      return
  if project == NONE:
      return                                         # workspace not connected

  # ── spawn ───────────────────────────────────────────────────────────
  session = createProjectSession(project, initialPrompt(event))
  chat_threads.insert((platform, team_id, threadKey) → session.id)
  return
```

Key invariant: **`chat_threads` is keyed by the thread's parent ts**, so the
first message and every later reply in that thread compute the same
`threadKey` and resolve to the same session. This is the "associate in our
db" requirement.

---

## 6. Multi-project per workspace

### The problem
`chat_channel_bindings` today is `(platform, workspace_id)` UNIQUE — one
workspace → one project. A second project's OAuth install **overwrites** the
row and silently orphans the first.

### The model
- **OAuth install is workspace-wide** and happens once. It does not by
  itself bind any project to any conversation.
- **`chat_installs`** (new) records `(workspace_id, project_id)` — every
  project that connected this workspace. Answers "how many projects could
  this event belong to."
- **`chat_channel_bindings`** is re-keyed to `(platform, workspace_id,
  channel_id)` → `project_id` and is populated **lazily** — by first use,
  not by an upfront picker.

### `resolveProject(event)`
```
binding = chat_channel_bindings[(platform, team_id, channel_id)]
if binding and binding.project_id:  return binding.project_id
if binding and not binding.project_id: return PENDING   # picker already up

installs = chat_installs[workspace_id]
if installs.length == 0: return NONE          # workspace not connected
if installs.length == 1:
    # unambiguous — bind the channel lazily, no user friction
    chat_channel_bindings.insert((..., channel_id) → installs[0])
    return installs[0]
# 2+ projects, fresh channel → genuinely ambiguous
return AMBIGUOUS
```

### The AMBIGUOUS case — **decided: Block Kit picker**
The bot posts a Block Kit message in-thread: *"Which project should
#channel-name use?"* with one button per installed project. The button
click (`block_actions`) writes the `chat_channel_bindings` row and then
re-dispatches the original event. Asked **once per channel**, ever.

This is the one place we use Slack interactivity. It requires an
`interactivity request_url` in the manifest (`/v1/webhooks/slack/interactivity`)
+ a `block_actions` handler in apps/api. Each button `value` carries the
chosen `project_id` plus a `picker_id`; the triggering event itself is
parked server-side (in memory) under that `picker_id`, so on click the
handler binds the channel and resumes the parked event on the chosen
project. The picker message is edited to a confirmation once a choice is
made.

**Picker-pending state.** When the picker is posted, a `chat_channel_bindings`
row is written immediately with `project_id = NULL` + the picker message
`ts`. `resolveProject` returns `PENDING` for that channel, so concurrent
@mentions are absorbed silently — no duplicate pickers (edge V). The
`block_actions` handler fills in `project_id`, flipping `PENDING` → bound.

### Token storage — **decided: project_secrets + fan-out**
The bot token stays in `project_secrets` (where it already lives) — sandbox
env injection already works, no new code. Slack issues one token per (app,
workspace) and a re-auth rotates it, so on every OAuth install the callback
**fans the fresh token out** to every project on that workspace, keeping all
copies current. `chat_installs` is the membership index that makes the
fan-out target list computable.

The Slack **signing secret** is a separate matter: the master one (OAuth
mode) stays in `apps/api` config and is never persisted per-project; a BYO
per-project signing secret may sit in `project_secrets` but is **stripped
from the sandbox env** at injection — the agent never needs it, only the
webhook verifier does.

(Rejected: a dedicated workspace-scoped `chat_workspaces` token table — one
fewer copy, but a 2nd new table + a new encryption scope + explicit
injection code, for a token that essentially never rotates.)

---

## 7. Edge cases

| # | Case | Resolution |
|---|---|---|
| A | Single project on workspace | `resolveProject` auto-binds; zero friction |
| B | 2+ projects, fresh channel | AMBIGUOUS → one-time Block Kit picker (§6) |
| C | Thread reply, session alive | `chat_threads` hit → deliver follow-up to same sandbox |
| D | DM to the bot | No channel→project mapping possible. Resolve by: 1 install → use it; N installs → picker in the DM. Bind `(workspace, dm_channel_id)` like any channel. |
| E | Non-mention message in a bot channel | Ignored unless `thread_ts` matches a `chat_threads` row we own |
| F | Bot's own message echoes back | `event.bot_id` set OR `event.user == our bot_user_id` → drop immediately |
| G | Slack retry (no 200 within 3s) | Webhook returns 200 **immediately**, processes async. Dedup on `event_id` (Slack sends a stable `event_id`) — keep a short-TTL seen-set. |
| H | Two events, same new thread, ~same ms | Race on session create. `chat_threads` UNIQUE`(platform,workspace,thread)` — loser of the insert race re-reads the row and delivers a follow-up instead. |
| I | Event ordering not guaranteed | Reply may arrive before parent's session is `running`. `deliver_followup` treats "sandbox provisioning" as **transient** — retry/skip, never spawn a duplicate (already implemented). |
| J | Session sandbox stopped/archived | `chat_threads` row points at a dead session. **Decided: spawn clean** — mark the old row stale, create a fresh session with an empty opencode convo, update the `chat_threads` row to the new session. The agent restarts cold for that thread (the inbound message text is its only context). No transcript replay. |
| K | Workspace uninstalled (`app_uninstalled`) | Delete `chat_installs` + `chat_channel_bindings` + workspace token. Leave `chat_threads` (FK-cascades when sessions are cleaned). |
| L | Bot removed from a channel | `member_left_channel` for our bot → mark that channel's binding inactive; next mention re-binds. |
| M | Slack rate limits (429) | `slack` CLI honors `Retry-After`; webhook side is read-only so unaffected. |
| N | Agent runs a disabled CLI command | CLI checks the allow-list env var, returns `{ok:false, error}` exit 1 (§9). |
| O | Prompt injection via a Slack message | Out of full scope; mitigations: system-prompt guardrail, never echo env, channel = trust boundary. Tracked separately. |
| P | Same parent ts across two workspaces | `chat_threads` is keyed by `(platform, workspace_id, thread_id)` — workspace-scoped, no collision. |
| Q | OAuth re-install of an already-connected workspace | Upsert `chat_installs`; refresh token. Existing channel bindings untouched. |
| R | Project deleted while a thread is bound | FK `ON DELETE CASCADE` from `chat_threads`/`chat_channel_bindings` → rows vanish; next mention in that channel re-resolves. |
| S | `message_changed` / `message_deleted` | Ignored — we act on original posts only. |
| T | Thread reply in a channel whose binding points at a now-uninstalled project | Treat as stale; re-run `resolveProject`. |
| U | Empty / whitespace-only mention (just "@Kortix") | No session spawned. Bot replies with a canned greeting (§8.10). Saves a sandbox + cost. |
| V | Picker already pending for a channel | `chat_channel_bindings` row exists with `project_id = NULL` → `resolveProject` returns `PENDING` → drop the event, do not post a second picker (§6). |
| W | Mention carries file attachments | `event.files[]` is surfaced in the initial prompt; the agent may `file-info` / `download` if those commands are allowed. |
| X | Bot @mentioned in a channel it isn't a member of | We cannot post or react. Slack's own UI nudges the user to invite the bot; no retry on our side. |
| Y | Picker button clicked after the workspace changed (project uninstalled between post and click) | `block_actions` handler re-validates the project is still in `chat_installs`; if gone, edit the picker to "that project was removed" and re-post a fresh picker. |

---

## 8. User experience

§3–§7 are the mechanics. This section walks every scenario as the *person
in Slack* actually experiences it — what they see, do, and wait on. UX is a
first-class goal, not an afterthought.

### 8.1 UX principles

1. **Acknowledge in under a second.** The webhook posts a "working"
   placeholder *before* any slow work (sandbox spawn). The user always knows
   they were heard.
2. **One answer per turn.** The agent posts its result as a single threaded
   reply — not a stream of partial messages. Only genuinely long tasks add
   explicit progress lines (8.12). No channel noise.
3. **Stay in the thread.** Every bot reply is threaded under the message
   that triggered it. The channel's top level stays clean; each task is its
   own thread = its own session.
4. **No upfront configuration.** No "pick your channels" wizard. Invite the
   bot, @mention it, it works. Binding happens lazily and invisibly whenever
   it can.
5. **Be honest about limits.** If context was lost (a revived dead thread)
   or an action is disabled, the bot says so plainly instead of acting
   confused.

### 8.2 Acknowledgement & feedback model

The acknowledgement is a **working indicator** — two signals, owned by
`apps/api` (it holds the workspace token). Slack has no real typing
indicator for channel bots and message text can't animate, so this is the
closest honest equivalent:

| Moment | Signal | Owner |
|---|---|---|
| Event received, will trigger a turn | ⏳ `hourglass_flowing_sand` reaction on the user's message **+** a threaded *"⏳ Kortix is working on it…"* placeholder | webhook, instant |
| Agent posts its reply in-thread | reaction removed **+** placeholder deleted | webhook |
| Disambiguation needed | the picker message instead (8.6) | webhook |

The placeholder is the contract: it lands within ~1 s of the @mention, long
before the sandbox is ready, and reads as a live "bot is working" cue. It is
**deleted** when the agent posts its reply — needing no `kortix-agent` ping:
the webhook already *receives* the bot's own reply as a `message` event, so a
bot message in a thread with a pending placeholder is the completion signal.
The webhook remembers the placeholder ts (keyed by thread) so the reply
event — which only carries `thread_ts` — finds and removes it. The
placeholder's own post echoes back as a bot message; that is skipped by ts
match so it doesn't delete itself. Net result: one transient message, gone
once the answer lands — no clutter.

DMs use the same model. If we later register the bot as a Slack Assistant,
DMs gain a native "is typing…" status; until then the placeholder applies
there too.

> Throughout the §8 walkthroughs, "👀" is shorthand for this working
> placeholder — the mechanism is the placeholder message described here.

### 8.3 Connecting Slack — first project on a workspace

1. In the Kortix dashboard, the user opens a project → **Channels** →
   **Connect Slack**.
2. Redirect to Slack's OAuth consent screen ("Kortix is requesting
   permission to…"). The user picks the workspace and approves.
3. Redirect back to the dashboard. The Channels dialog shows **Slack ·
   connected** plus one line: *"Invite @Kortix to any channel and @mention
   it, or DM it directly."*
4. Behind the scenes: a `chat_installs(workspace, project)` row; the
   encrypted workspace bot token stored on it. **No channel is bound yet.**

No channel picker. The user does not choose channels up front.

### 8.4 Connecting a second project to the same workspace

1. From a *different* project's Channels dialog, the user clicks **Connect
   Slack** and approves the same workspace again.
2. Dashboard shows **Slack · connected**, with an added note: *"This
   workspace already serves <project-alpha>. New channels will ask which
   project to use the first time you @mention the bot there."*
3. Behind the scenes: a second `chat_installs` row. The workspace now serves
   2 projects. Existing channel bindings are untouched.

### 8.5 First @mention — single project (the common path)

1. User invites @Kortix to `#support`, then posts *"@Kortix summarise
   today's incidents."*
2. Within ~1 s the message gets a 👀 reaction — the user knows it landed.
3. `resolveProject` finds exactly one project on the workspace → binds
   `#support → project-alpha` **silently**, no prompt.
4. A session spins up; the agent works.
5. The agent posts its answer as a threaded reply under the user's message;
   the 👀 is removed.
6. Every later message in that thread continues the same session (8.7).

Zero configuration, zero prompts — the experience signed off on: *"invite
them into any channel & it just works when you tag him."*

### 8.6 First @mention — multiple projects (the picker)

1. User @mentions the bot in a fresh `#general`; the workspace serves
   project-alpha **and** project-beta.
2. 👀 reaction appears instantly.
3. `resolveProject` returns AMBIGUOUS. The bot posts a **threaded** Block
   Kit message (channel top level stays clean):

   > **Which project should #general use?**
   > Asked once — I'll remember it for this channel.
   > `[ project-alpha ]`  `[ project-beta ]`

4. Anyone in the channel can click. On click:
   - the binding `#general → chosen project` is written,
   - the picker message is edited to *"✓ #general is linked to
     **project-beta**."*,
   - the **original** @mention is replayed → session spawns → answer posted
     in that same thread.
5. The user experiences one extra click, once per channel, ever.
   Subsequent @mentions go straight to 8.5 step 4.

While a picker is pending, further @mentions in that channel are absorbed
silently — no duplicate pickers (edge V).

### 8.7 Thread reply — continuity

1. The user (or a teammate) replies inside a thread the bot already answered
   in.
2. 👀 on the reply.
3. `chat_threads[(slack, workspace, thread_ts)]` hits → the message is
   relayed to the *same running session* via `/kortix/prompt`. No new
   sandbox.
4. The agent answers in the same thread with full memory of the
   conversation.

The thread — not the person — is the unit of conversation: a teammate
jumping into the thread talks to the same session.

### 8.8 DM to the bot

1. User opens a DM with @Kortix and sends a task.
2. 👀 on the message.
3. A DM has no channel→project mapping. Resolution:
   - workspace serves 1 project → use it,
   - workspace serves N → the bot posts the same Block Kit picker, in the
     DM.
4. The DM is then bound like any channel (`(workspace, dm_channel_id)`); the
   whole DM behaves as one long-lived thread/session.

### 8.9 Reviving a thread whose session is gone

Sandboxes are ephemeral — a thread the user revisits hours later may have a
dead session.

1. User replies in an old thread.
2. 👀 on the reply.
3. The `chat_threads` row is found but the session is dead → **spawn clean**
   (§7.J): a fresh session, no transcript.
4. Because context was lost, the agent's first reply opens with a short,
   honest note:
   > *Picking this thread back up — heads up, I don't have the earlier
   > context from before. Quick recap of what you need?*

   This is injected via the initial prompt, so the agent never pretends to
   remember.
5. From there the revived thread behaves normally.

### 8.10 Error & empty paths

| What happened | What the user sees |
|---|---|
| Sandbox spawn fails | The 👀 stays (no reply came) and the error is logged server-side. A user-facing error reply is a planned improvement — not yet built. |
| Agent crashes mid-turn | Same — 👀 stays, error logged. Planned: a short threaded error reply. |
| Bot @mentioned in a channel it isn't in | Slack itself prompts the user to invite the bot; we can't post until invited (edge X) |
| Workspace has no linked project (stale install) | Silent drop — a workspace with 0 linked projects has no bot token, so there is nothing to reply with. |
| Empty mention (just "@Kortix", no task) | Bot replies *"Hi! @mention me with a task and I'll get on it."* — **no session spawned** (edge U) |
| Agent attempts a disabled CLI command | Internal: the CLI returns an error to the agent; the agent tells the user plainly (*"I'm not allowed to join channels on my own here."*) |

### 8.11 Re-binding a channel to a different project

A channel can end up bound to the wrong project (wrong picker button).

- **v1:** the dashboard's Channels view lists every bound channel (`#general
  → project-beta`) with a dropdown to reassign. When a binding is created we
  store the channel name (one `conversations.info` call) so the dashboard
  shows human names, not IDs.
- In-Slack re-bind (e.g. `@Kortix switch project`) is **deferred** — it
  needs reliable intent detection or a slash command, both out of v1 scope.

### 8.12 Latency & expectation-setting

| Phase | Typical | What covers the wait |
|---|---|---|
| @mention → 👀 | < 1 s | the reaction itself |
| 👀 → reply, warm path (reply into a live thread) | a few seconds | 👀 |
| 👀 → reply, cold path (new session, sandbox boot) | seconds | 👀; if the real answer isn't quick the agent posts one interim line — *"On it — give me a moment."* |
| Long task (minutes) | — | the agent posts explicit progress updates in-thread |

We deliberately do **not** post a "spinning up" message for every mention —
the 👀 carries short waits, and placeholder + answer would be two messages.
Only genuinely slow turns get an interim line, posted by the agent.

### 8.13 Concurrency, as the user feels it

- Two threads in the same channel, both with the bot → two independent
  sessions, two sandboxes. Each thread is its own conversation; they never
  cross.
- Two people @mention the bot in different channels at once → fully
  independent, no contention.
- A user fires three messages into one thread rapidly → all three relay to
  the one session; the agent reads them in order and answers once it has
  worked through them. No duplicate sandboxes — guaranteed by the
  `chat_threads` unique key and transient-retry handling (§7.H, §7.I).

### 8.14 Telegram

Telegram maps onto the same model with platform-specific surfaces: no emoji
reactions, so the ack is a quick *"✓ on it"* message (later edited to the
answer) instead of a 👀; Telegram's `reply_to_message_id` plays the role of
`thread_ts`; group chats are channels, private chats are DMs. Routing,
multi-project resolution, and CLI constraints are identical.

### 8.15 Agent model

Slack-triggered turns pin a specific model — `anthropic/claude-sonnet-4-6`.
The webhook passes `opencode_model` into `createProjectSession`; it rides as
the `KORTIX_OPENCODE_MODEL` env var on that session's sandbox, and the
sandbox agent sets it on every opencode prompt call (initial @mention via
`maybeDeliverInitialPrompt`, thread replies via `/kortix/prompt`). Scoped to
the sandbox env, so only Slack sessions are affected — other sessions keep
opencode's configured default. The session also records `opencode_model` in
its metadata so a sandbox restart re-applies it.

---

## 9. In-sandbox CLI action constraints

### Motivation
The agent gets a `slack` CLI on PATH. A project may want to forbid certain
actions — e.g. `join` so the bot can't self-join channels.

### Config — `[[channels]]` in `kortix.toml` (config only; secrets stay in `project_secrets`)
```toml
[[channels]]
platform = "slack"
# Allow-list. Omit the key entirely = every command enabled (default-open).
# Listed = ONLY these commands may run.
commands = [
  "send", "edit", "delete", "react", "typing", "history",
  "thread", "channel-info", "users", "user", "me", "search",
  "file-info", "download",
]
# "join", "channels", "manifest" omitted → blocked
```

Full command enum (slack): `send, edit, delete, react, typing, history,
thread, channels, channel-info, join, users, user, me, search, file-info,
download, manifest`. This list is expected to grow; new commands are
**enabled by default** (default-open) unless a project ships an allow-list.

### Enforcement path
1. Session spawn → apps/api reads `[[channels]]` from the project's
   `kortix.toml` → for each platform computes the allowed set.
2. Injects `KORTIX_SLACK_COMMANDS=send,edit,react,…` into the sandbox env
   (omitted entirely when no allow-list → default-open).
3. The `slack` CLI, in its dispatch switch, calls a shared
   `guardCommand("slack", command)` from `agent-cli/lib`. It reads
   `KORTIX_SLACK_COMMANDS`; if set and `command` ∉ set →
   `{ok:false, error:"command 'join' disabled by project config"}`, exit 1.

### Generalization
`guardCommand(cliName, command)` reads `KORTIX_<CLINAME>_COMMANDS`. Every
future in-sandbox CLI (e.g. `executor`) imports it and gets per-project
gating for free. `[[channels]]` constrains comms CLIs; a parallel
`[[tools]]` (or similar) section can constrain non-channel CLIs later — the
enforcement primitive is identical.

### Deferred — inbound event constraints
Gating **inbound** event types per project (e.g. "this project never spawns
a session from a DM") via a separate `events` allow-list on `[[channels]]`
is **deferred** (§11). v1: every event type in §3 always applies; only the
outbound `commands` allow-list is configurable.

---

## 10. Data-model changes

```
NEW   chat_installs            (platform, workspace_id, project_id) UNIQUE
                               + connected_at  — membership only, no secrets
ALTER chat_channel_bindings    unique key → (platform, workspace_id, channel_id)
                               project_id   → now NULLABLE (NULL = picker pending)
                               + channel_name   varchar  (for the dashboard)
                               + channel_type   varchar  (channel|group|im|mpim)
                               + picker_ts      varchar  (ts of the pending picker msg)
KEEP  chat_threads             unchanged — already (platform, workspace_id, thread_id)
KEEP  project_secrets          still holds the bot token, fanned out to every
                               project on the workspace; SLACK_SIGNING_SECRET
                               is stripped from the sandbox env at injection
```

`chat_installs` is the workspace↔project membership index; `chat_channel_bindings`
is the per-channel routing row (a NULL `project_id` means a picker is up and
awaiting a click); `chat_threads` stays the per-thread session map.

---

## 11. Decisions

**Resolved (2026-05-22):**
1. **Picker** — Block Kit picker with a `block_actions` handler. No text
   fallback. Manifest gains an `interactivity request_url`. (§6)
2. **Dead-session policy** — spawn **clean**, no transcript replay. (§7.J)
3. **Token storage** — bot token stays in `project_secrets`, fanned out to
   every project on the workspace on each install; `chat_installs` is the
   membership index. Signing secret never reaches a sandbox. (§6)
4. **Acknowledgement model** — `apps/api` reacts 👀 to the triggering
   message within ~1 s and removes it when the agent's reply lands. The
   webhook detects the reply by observing the bot's own `message` event in
   that thread — no `kortix-agent` ping needed. No per-mention "spinning up"
   message. (§8.2)

**Deferred to a later round:**
4. **Inbound event allow-list** — per-project `events` allow-list on
   `[[channels]]`. v1: all §3 event types always apply.
5. **Reaction triggers** — `reaction_added` stays inert in v1; it never
   triggers an agent turn.

---

## 12. Implementation order

1. ✅ `chat_installs` table + migration; re-key `chat_channel_bindings` to
   `(platform, workspace_id, channel_id)`, make `project_id` nullable, add
   `channel_name` / `channel_type` / `picker_ts`.
2. ✅ OAuth callback writes a `chat_installs` membership row (not an
   overwrite) and fans the bot token + workspace metadata out to every
   project on the workspace.
3. ✅ Strip `SLACK_SIGNING_SECRET` from the sandbox env at injection.
4. Webhook: full resolution algorithm (§5) + project resolution (§6) +
   dead-session spawn-clean (§7.J) + instant 👀 ack (§8.2).
4. ✅ Webhook: resolution algorithm (§5) + project resolution (§6) +
   dead-session spawn-clean (§7.J) + instant 👀 ack, lifted on reply (§8.2).
5. ✅ All event types handled per §3 + echo guard + `event_id` dedupe +
   empty-mention canned reply (§8.10). (Not-connected reply is a no-op — a
   workspace with 0 linked projects has no bot token to reply with.)
6. ✅ Block Kit project picker + `block_actions` handler + picker-pending row +
   `channel_name` capture; manifest gains `interactivity request_url`.
7. `[[channels]]` parser (config-only) + `KORTIX_SLACK_COMMANDS` injection.
8. `guardCommand` in `agent-cli/lib`; wire into `slack` CLI dispatch.
9. Dashboard Channels view: list bound channels + reassign dropdown (§8.11).
10. Strip leftover diagnostic `console.log` lines (done in Phase 2 rewrite).
