# @kortix/voice-agent

A [LiveKit agents-js](https://github.com/livekit/agents-js) worker: the spoken
voice of a Kortix agent inside a live meeting. STT → LLM → TTS pipeline
(deepgram STT, openai LLM, openai TTS) with silero VAD driving turn detection
— LiveKit's standard cascaded pipeline, not a realtime speech-to-speech model
(this workload is tool-heavy; half-cascade is the reliable path for tool use).

This process is a standalone worker. It is not part of `apps/api` and does
not import anything from it — everything it needs to know about a call
(which project, which session, how to reach the Kortix API) comes in over
LiveKit, not a shared process.

## Run it locally

Against the local LiveKit dev server (`ws://localhost:7880`, `devkey` /
`secret`):

```bash
cd apps/voice-agent
pnpm install   # from the repo root, or scoped: pnpm --filter @kortix/voice-agent install

LIVEKIT_URL=ws://localhost:7880 \
LIVEKIT_API_KEY=devkey \
LIVEKIT_API_SECRET=secret \
DEEPGRAM_API_KEY=<your deepgram key> \
OPENAI_API_KEY=<your openai key> \
pnpm dev
```

`pnpm dev` runs `bun run src/index.ts dev` — `dev` is LiveKit's own CLI
subcommand (from `cli.runApp`), not a bespoke script; it registers the worker
with the LiveKit server at `LIVEKIT_URL` and handles reload. There's also
`pnpm start` (production mode, no reload) and `pnpm console` (an in-process
text-only session with no real room — useful for iterating on
instructions/tools without joining a room at all; note this mode cannot
resolve a `CallContext` from room metadata, since there is no room — see
below).

To actually exercise a call end-to-end you need something in the room to
trigger dispatch: either open the `/voice/[token]` page (apps/web) pointed at
this LiveKit server (the real integration), or, for a bare smoke test, join
the same room name as a human participant with any LiveKit client (e.g. the
[Agents Playground](https://agents-playground.livekit.io/) pointed at your
local server) and talk to it.

**Required env vars** (see `src/call-context.ts` for the full explanation of
why call-specific values come from room metadata, not env vars):

| Var | Required | Purpose |
|---|---|---|
| `LIVEKIT_URL` | yes | LiveKit server to connect to. Read by `@livekit/agents` itself. |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | yes | Worker auth against the LiveKit server. Read by `@livekit/agents` itself. |
| `DEEPGRAM_API_KEY` | yes | Read by `agents-plugin-deepgram`'s `STT` constructor when no `apiKey` option is passed. |
| `OPENAI_API_KEY` | yes | Read by `agents-plugin-openai`'s `LLM`/`TTS` constructors when no `apiKey` option is passed. |
| `KORTIX_API_URL` | no | Fallback Kortix API base URL, used only when a room's metadata omits `kortix_api_url`. Defaults to `http://localhost:8008` (matches `apps/api`'s local dev port). Named to match the existing convention (`apps/cli`, the self-host compose file). |

## Why room metadata, not env vars, for call identity

A single worker **process** can run many jobs (rooms) concurrently — one
process, many simultaneous calls, each for a different project/session. An
env var is process-wide, so anything that differs per call **must** come from
the room instead, above all the Kortix API credential: a shared static token
would let any live call impersonate any other project's session.

`apps/api`, when it creates the LiveKit room for a call (before dispatching
this agent into it), is expected to set the room's metadata to JSON shaped
like:

```json
{
  "project_id": "...",
  "session_id": "...",
  "call_id": "...",
  "kortix_api_url": "https://api.kortix.com",
  "kortix_api_token": "<short-lived, call-scoped bearer credential>",
  "bot_name": "Kortix"
}
```

via `RoomServiceClient.createRoom({ name, metadata })`
(`livekit-server-sdk@2.17.0`). This worker reads it back via
`ctx.job.room.metadata` — the room's server-side state as of dispatch time,
readable in the entrypoint immediately, before `ctx.connect()` has actually
joined (the live `ctx.room` object only populates `.name`/`.metadata` once
connected). `call_id` defaults to `session_id` when omitted: today there's one
live call per session (`apps/api/src/channels/voice/routes.ts`: "The call id
IS the session id"), so the two are normally the same value.

## The two tools

Defined in `src/tools.ts`, described to the model in `src/instructions.ts`:

- **`send_prompt`** — fire-and-forget hand-off to the Kortix agent session,
  for anything needing real project knowledge, files, connectors, or
  actions. Mirrors the old in-process `ask_kortix` → `continueSession()`
  path, but now over the voice MCP's `ask_kortix` tool (see below) since this
  process is no longer inside `apps/api`. Returns the instant the request is
  queued; the instructions tell the model to say one short sentence that it's
  checking and then stop talking rather than invent an answer.
- **`run_command`** — runs a short shell command in the session's sandbox and
  waits (up to 12s client-side) for its result, for quick checks only
  (reading a file, listing a directory). Unlike `send_prompt` this **does**
  block the tool call, briefly, on purpose: the point of `run_command` is
  "quick check, answer directly."

## The Kortix reply channel (Kortix → call)

The mirror problem: once a `send_prompt` hand-off's `continueSession()`
eventually resolves, something has to speak the answer into the live call.
`src/inbound-replies.ts` listens for a LiveKit **data message** on the
`kortix` topic — `RoomEvent.DataReceived` on the connected room — and calls
`session.say(text)` on `{ "type": "kortix_reply", "call_id": "...", "text":
"..." }`. `apps/api` is expected to send that via
`RoomServiceClient.sendData(roomName, payload, DataPacket_Kind.RELIABLE, {
topic: 'kortix' })` once it has a reply. LiveKit delivers data messages to
every participant already subscribed to the room, agent included, so no
extra plumbing is needed on this side beyond the listener.

## Transcripts

`src/transcripts.ts` posts every finalized turn (`voice.AgentSessionEventTypes.ConversationItemAdded`,
one event per committed chat item, both roles) via the voice MCP's
`post_turn` tool, fire-and-forget — mirroring the old in-process
`appendTurn()` write to `voice_call_turns`.

## The `apps/api` contract this app expects

This app is scoped to the LiveKit worker only — it does not touch
`apps/api`. It expects ONE endpoint,
`POST /v1/projects/:projectId/sessions/:sessionId/mcp/voice` — a JSON-RPC 2.0
voice MCP (`apps/api/src/channels/voice/mcp.ts` + `routes.ts`), authenticated
with `Authorization: Bearer <kortix_api_token>` (the per-call token from room
metadata). Every call is a `tools/call` request; the tool surface is:

| Tool | Args | Behavior |
|---|---|---|
| `ask_kortix` | `{ request }` | Fire-and-forget; relays into the Kortix session the same way the old `ask_kortix` → `continueSession()` did. Responds instantly; the actual agent turn runs in the background. |
| `run_command` | `{ command, cwd? }` | Runs `command` in the session's sandbox, capped server-side well under this app's 12s client-side timeout, and returns `{ stdout, stderr, exit_code, timed_out }`. |
| `post_turn` | `{ role, text, speaker? }` | Persists one transcript line to `voice_call_turns`, same shape as the old `appendTurn()`. |

`call_id`/`project_id`/`session_id` are never in the tool arguments — the MCP
route resolves them from the URL path (and the HMAC proves the caller owns
that call), the same way the three REST endpoints this MCP replaced used to.

Plus the reply channel above (`RoomServiceClient.sendData` on the `kortix`
topic) and setting `kortix_api_token`/`project_id`/`session_id` in room
metadata at room-creation time.

`src/kortix-client.ts` implements the client side of all three tool calls —
real `fetch()` requests against the MCP endpoint, correctly shaped, with
client-side timeouts and defensive error handling.

## Package versions

Pinned exactly, verified to exist on npm and checked against their actual
shipped `.d.ts` files (not docs/memory) before writing any of this:
`@livekit/agents@1.5.5`, `@livekit/agents-plugin-{openai,deepgram,silero}@1.5.5`.
`@livekit/rtc-node@0.13.31` is also pinned explicitly as a direct dependency
even though the task list above didn't name it — it's a `peerDependency` of
every one of those packages (the native RTC transport binding they all sit
on top of) and the worker cannot connect to a room without it.
