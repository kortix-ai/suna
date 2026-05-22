# Slack streaming — live plan checkpoints

Status: **draft for review**
Scope: replace the static "⏳ working" placeholder with a **live plan block** —
the agent narrates a handful of human checkpoints (*"Reading the incident
logs… → Drafting the summary…"*) while it works, then the answer lands in the
same message. Channel @mention surface only; builds on the routing in
[`channels.md`](./channels.md).

---

## 1. Goal

Today a turn is a black box: @mention → ⏳ → silence → a wall of markdown. The
fix is a **plan block** that fills in as the agent works — not a raw tool log
(noise), not a bare spinner (no information), but a few meaningful,
agent-narrated checkpoints. The answer arrives at the end, in the same message.

**Explicitly out of scope:** token-by-token streaming of the answer text. The
checkpoints + a clean final answer already deliver the "colleague keeping you
posted" feel; live-token response streaming is a later enhancement.

---

## 2. Slack primitives

`chat.startStream` / `chat.appendStream` / `chat.stopStream` — they work in
**channel threads** (`recipient_user_id` + `recipient_team_id` are *required
when streaming to channels*).

- **`chat.startStream`** — `{ channel, thread_ts, recipient_user_id,
  recipient_team_id, task_display_mode: 'plan', chunks? }` → returns a message
  `ts`.
- **`chat.appendStream`** — `{ channel, ts, chunks }`.
- **`chat.stopStream`** — `{ channel, ts, chunks?, markdown_text?, blocks? }` —
  finalizes the message.

Chunks we use:
- `task_update` — `{ type:'task_update', id, title, status }` — one checkpoint.
  `status ∈ pending|in_progress|complete|error`.
- `markdown_text` — the final answer body, sent on `stopStream`.

`task_display_mode: 'plan'` renders the `task_update`s as the collapsible plan
block. Net result: **one streamed message** — a live plan that fills in, then
the answer as the body.

---

## 3. Architecture — split ownership

A turn has two phases: **pre-sandbox** (@mention → session → sandbox → opencode
ready) and **agent** (opencode runs). Ownership:

| Concern | Owner |
|---|---|
| Stream object — `startStream`, the `ts` | **apps/api** |
| Pre-sandbox checkpoint(s) — *"Spinning up a sandbox"* | **apps/api** |
| Agent-phase checkpoints — what the agent narrates | **agent**, via the agent-cli |
| The final answer | **agent**, via the agent-cli — *the agent decides what to send* |
| `stopStream` (finalize) | agent-cli on a normal finish; **apps/api** watchdog otherwise |

**apps/api** receives the @mention, `startStream`s, posts the pre-sandbox
checkpoint, and hands the stream handle (`ts` + channel + recipient) to the
sandbox. **The agent**, through the agent-cli, appends its own checkpoints and
the final answer to that same stream.

No token-streaming, no SSE subscription — checkpoints are discrete
`task_update` calls the agent makes deliberately. This needs an agent-cli
change (a `step` command + a stream-aware `send`) → **one sandbox rebuild**.

---

## 4. The turn, end to end

### 4.1 Cold turn (new @mention)

```
@mention
  → chat.startStream(channel, thread_ts, recipient=mentioner, mode='plan',
        chunks=[ task_update id=boot "Spinning up a sandbox" in_progress ])
  → keep the stream ts; inject it (+ channel) into the sandbox env
  → createProjectSession(...) as today
  → opencode ready → apps/api appends task_update id=boot status=complete
  → the agent works; each milestone it runs:
        slack step "Reading the incident logs"
          → completes the previous checkpoint, appends this one in_progress
  → the agent finishes:
        slack send "<final answer>"
          → chat.stopStream: last checkpoint → complete,
             markdown_text = the answer
```

### 4.2 Warm turn (thread reply, sandbox already up)

`apps/api` `startStream`s, relays the message + the new stream handle via
`/kortix/prompt`; no pre-sandbox checkpoint. The agent narrates + answers the
same way.

### 4.3 What the user sees

```
@user: @Kortix summarise today's incidents
  └ Kortix  ▸ Working…                       ← streamed message, instant
      ✓ Spinning up a sandbox
      ✓ Reading the incident logs
      ⟳ Drafting the summary
  └ (finalized: plan collapses, the summary is the message body)
```

One message. The plan is collapsible; the answer is the body.

---

## 5. The agent-cli surface

The agent drives its half of the stream with two commands. Both no-op
gracefully when there is no active stream (e.g. a non-Slack session):

- **`slack step "<text>"`** — completes the current checkpoint and appends a
  new one as `in_progress`. The agent calls this a handful of times per turn.
- **`slack send "<text>"`** — becomes stream-aware: with an active turn stream
  it `stopStream`s (last checkpoint → `complete`, text → the answer body)
  rather than posting a new message. Without one, it posts as it does today.

**Relay, not direct.** The agent-cli does not call Slack itself for the
stream — it relays to apps/api: `POST /v1/projects/:projectId/turn-stream`
`{ session_id, kind:'step'|'answer', text }`, authed by the session CLI token
(already in the sandbox env). apps/api keys its `activeStreams` map by
`session_id`, so the agent-cli only needs `KORTIX_SESSION_ID` — no stream
handle, no env injection, no handle file, and warm follow-ups just work (apps/api
updates the map per turn). apps/api stays the sole owner of the Slack stream.

If `chat.startStream` is unavailable, apps/api falls back to a plain
placeholder message; `slack step` no-ops and `slack send` edits the
placeholder into the answer — so a streaming-API problem never breaks replies.

The agent is **prompted** to narrate: a few checkpoints, human phrasing, then
one `slack send` with the answer. Over/under-narration is a prompt-tuning
concern, not a correctness one.

---

## 6. What changes

- **The placeholder is replaced.** `startWorkingIndicator` /
  `clearWorkingIndicator` (the ⏳ message) → the streamed message. The ⏳
  **reaction** on the user's message stays — apps/api adds it on `startStream`,
  removes it on finalize.
- **`renderAgentPrompt` changes.** It instructs the agent to narrate progress
  with `slack step` and deliver the final answer with `slack send` — and that
  `send` now finalizes the streamed message.
- **agent-cli change** → one sandbox rebuild (+ snapshot bust). The only
  rebuild this feature needs.

---

## 7. Edge cases

| # | Case | Handling |
|---|---|---|
| A | Sandbox spawn fails | apps/api `stopStream`s — boot checkpoint → `error`, body *"I couldn't start up — try again in a moment."* |
| B | Agent finishes without calling `slack send` | apps/api watchdog: opencode turn ended + stream still open → `stopStream` with whatever checkpoints exist + a short note |
| C | opencode crashes mid-turn | Same watchdog → `stopStream` *"the run stopped unexpectedly."* **Fixes the stuck-"Working…" bug** |
| D | Slack stream rate limit (Tier 2) | a turn fires only a few `step` relays — naturally paced, well under the limit; no coalescing needed |
| E | Agent over-narrates (20 checkpoints) | tolerable — the plan block collapses; tighten via the prompt |
| F | Agent never narrates a single step | plan shows just the boot checkpoint, then the answer — still fine, no worse than today |
| G | Long answer (>12 000 chars) | split into multiple `markdown_text` chunks on `stopStream` |
| H | Concurrent turns | one stream per turn, keyed by Kortix session id in `activeStreams` |
| I | `slack send` called twice | first finalizes the stream; a second relay finds no active stream → the agent-cli errors or posts normally if `--channel` given |

---

## 8. Implementation order — **done**

1. ✅ `chat.startStream` / `appendStream` / `stopStream` helpers in `slack-api.ts`.
2. ✅ apps/api: `startTurnStream` on a triggering event — `startStream` with the
   boot checkpoint + ⏳ reaction; `activeStreams` keyed by session id; replaced
   `startWorkingIndicator`.
3. ✅ Watchdog finalize for the failure cases (§7 A/B/C); plain-message fallback
   when `chat.startStream` is unavailable.
4. ✅ Relay endpoint `POST /v1/projects/:projectId/turn-stream`; agent-cli
   `slack step` + stream-aware `slack send` relay through it by session id.
5. ✅ `renderAgentPrompt` / `renderFollowUpPrompt` — narrate-with-`step`,
   answer-with-`send`.
6. ✅ Warm-turn path: `startTurnStream` bound to the existing session id.
7. Rebuild the agent-cli into the snapshot; bust the cache.
