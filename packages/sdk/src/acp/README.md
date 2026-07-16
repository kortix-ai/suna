# ACP protocol/transport reference

This is a reference for `packages/sdk/src/acp/` — the ACP (Agent Client
Protocol) transport, identity, transcript, and session-store layer. It is a
protocol/transport document, not a how-to-use-the-SDK guide (that's
`packages/sdk/CLAUDE.md`). Every claim below is traced to a source file, a
named test, or a commit — where a claim is a known open decision rather than
a settled invariant, it is stated as such, not smoothed over.

## 1. The canonical decision

ACP is the canonical protocol between coding-agent harnesses (Claude Code,
Codex, OpenCode, Pi) and Kortix — not an internal implementation detail Kortix
translates away. The durable truth for any session is the append-only,
ordinal-ordered log of raw inbound/outbound ACP JSON-RPC envelopes; every
markdown/HTML rendering, every chat-item projection, every web/mobile UI is a
*projection* derived from that log, never the source of record itself. Kortix
does not translate ACP into AG-UI, the Vercel AI SDK message format, or an
OpenCode-shaped universal schema — ACP already specifies the bidirectional
coding-agent contract (permission responses, terminal sessions, session load,
config options, client-provided MCP servers) that a translation layer would
have to re-invent. This is the grounding decision for the whole `acp/`
directory; see
`docs/superpowers/specs/2026-07-15-acp-native-multiharness-context.md`
("The one-line decision", "Canonical persistence & the SDK boundary").

## 2. The 3-identity model

Every ACP session carries three distinct identities that the grounding
invariant forbids collapsing into one another:

```ts
type RuntimeSessionIdentity = {
  projectSessionId: string; // durable Kortix identity (survives sandbox replacement)
  runtimeId: string;        // current sandbox/runtime allocation
  acpSessionId: string;     // harness-native ACP session (from session/new or session/load)
};
```

- **`projectSessionId`** — the durable Kortix identity: the `projectSessions`
  row id (`project_sessions.session_id` primary key). It survives sandbox
  replacement and is never re-minted by the identity-write path.
- **`runtimeId`** — the *current* sandbox/runtime allocation. What this
  actually **is** differs by call site today, and the identity module
  documents this as pinned-as-is rather than unified: the interactive route
  (`apps/api/src/projects/routes/acp.ts`'s `resolveAcpTarget`) sets it to the
  Kortix session id itself; the headless engine
  (`apps/api/src/projects/session-lifecycle/engine.ts`) sets it to the
  daemon-reported ACP server id (`runtimeHealth.acpServerId`).
- **`acpSessionId`** — harness-native, minted by the harness's `session/new`
  response or confirmed by `session/load`. An independent random-id namespace,
  never derived from `projectSessionId` or `runtimeId`.

**The never-overload law:** these three must never collapse into each other,
and specifically `acpSessionId` must never equal `runtimeId` — that would
make the harness-native ACP session indistinguishable from the sandbox-scoped
runtime allocation in persisted state. This is enforced, not just documented:
`apps/api/src/projects/lib/acp-session-identity.ts` is the **one** write path
for this identity onto `projectSessions.metadata`
(`persistAcpSessionIdentity`), and it throws `AcpSessionIdentityOverloadError`
at write time if `identity.acpSessionId === identity.runtimeId`. Both the
interactive route (on the `session/new` response) and the headless engine
(on first mint, before `session/prompt`) call through this one function —
replacing what used to be two independent hand-rolled read-merge-write sites.

## 3. Transport

### The session-scoped endpoint

Hosts talk to one URL per session:

```
${backendUrl}/v1/projects/{projectId}/sessions/{sessionId}/acp
```

Mounted by `app.route('/v1/projects', projectsApp)`
(`apps/api/src/index.ts:685`) over the `GET`/`POST`/`DELETE` handler in
`apps/api/src/projects/routes/acp.ts:102` (`resolveAcpTarget` resolves the
session's sandbox, then proxies to the daemon bridge underneath). A sibling
route, `GET .../acp/transcript`, serves the durable, ordinal-ordered replay
log (`apps/api/src/projects/routes/acp.ts:80`).

### The daemon bridge contract

Underneath the API's proxy sits the sandbox daemon's own ACP router
(`apps/kortix-sandbox-agent-server/src/routes/acp.ts`, mounted at `/acp` —
`proxy.ts:124`):

```
GET    /acp                 -> list live servers
POST   /acp/:serverId?agent= -> JSON-RPC envelope in; lazily starts the process
GET    /acp/:serverId        -> SSE stream of agent-originated events
DELETE /acp/:serverId        -> terminate the process
```

- **Lazy, single process per `serverId`.** The first `POST` to a new
  `serverId` must carry `?agent=`; it starts exactly one official ACP stdio
  process for that harness. Later requests reuse it
  (`routes/acp.ts:22-33`, `runtime.getOrCreate`).
- **409 on mismatched agent.** Re-POSTing to an existing `serverId` with a
  different `agent` throws `AcpHarnessConflictError`, mapped to HTTP `409`
  (`acp/runtime.ts:332-339`, `routes/acp.ts:39-41`).
- **202 for notifications/client-responses.** A POST envelope with no
  `method` (a JSON-RPC response/notification) returns `202` immediately
  instead of waiting for a matching reply (`routes/acp.ts:37`,
  `acp/runtime.ts:180-183`); a request (has `method`) waits for its matching
  response. The stdin write queue serializes writes only, never request
  lifetimes — a long `session/prompt` does not block a concurrently issued
  permission response.
- **DELETE is idempotent.** `DELETE /acp/:serverId` always returns `204`,
  including a second call after the process is already gone
  (`routes/acp.ts:103-106`).
- **HMAC gate.** Every `/acp` route sits behind the sandbox's
  `X-Kortix-User-Context` HMAC middleware (`proxy.ts:107`, `app.use('*', …)`);
  health stays unauthenticated.
- **`Last-Event-ID` bounded replay.** `GET /acp/:serverId` accepts
  `Last-Event-ID` and replays only events after that id, from a bounded
  in-memory buffer capped at `MAX_REPLAY_EVENTS = 2_000`
  (`acp/runtime.ts:38,277` — oldest events are evicted once the cap is
  exceeded).

These are the hard gates enforced by commit `8c7d49a64`
("test(sandbox): ACP bridge hard gates (real child process, HMAC, 409/202,
Last-Event-ID, DELETE)") — a real spawned child process, real HTTP + SSE, no
mocked router. That commit brought the daemon's test suite from 159 to 167
tests (0 failures), closing four specific gaps: per-route auth rejection
(not just the collection route), the *bounded* half of replay semantics (a
2,010-event burst against the 2,000 cap, proving eviction from the front),
an OS-level process-exit assertion on `DELETE` (not just the HTTP-visible
contract), and a timing proof that a slow in-flight request does not delay a
concurrently issued fast one.

### The SDK client

`AcpClient` (`packages/sdk/src/acp/client.ts`) has two construction modes:

- **`endpoint` mode** (preferred, provider-neutral): a single, already-resolved
  session-scoped URL — the API's proxy above. Used by hosts.
- **`baseUrl` + `serverId` [+ `agent`] mode**: talks directly to the daemon
  bridge. Lower-level; used for testing/compatibility (`client.ts:66-77`).

Streaming (`AcpClient.connect()`) is SSE via authenticated `fetch` + a real
`ReadableStream` body + `TextDecoder` — **not** `EventSource` — because it
needs custom headers (`Last-Event-ID`) and React Native's fetch has no
incremental response body at all. When `streamTransport` resolves to
`'poll'` (explicit, or `'auto'` on React Native, detected via
`navigator.product === 'ReactNative'`, `client.ts:337`), the client instead
polls the durable transcript endpoint (`pollTranscript`, `client.ts:340-406`)
and derives the same `AcpStreamEvent` shape from persisted rows.

Reconnect uses exponential backoff starting at 250ms, doubling to a 5s cap,
with ±15% jitter (`client.ts:213,301-303`); the backoff only resets once a
connection attempt has actually delivered an event, not merely opened
(`client.ts:216-222`, `deliveredEventThisAttempt`).

Terminal-status policy: `isTerminalStatus` treats every 4xx **except** `408`
(Request Timeout) and `429` (Too Many Requests) as terminal — those two are
transient-by-convention and keep retrying with backoff (`client.ts:18-22`).
A terminal transport error stops the reconnect loop and reports connection
state `'failed'`; a non-terminal one reports `'reconnecting'` and keeps
going.

## 4. The one parser

`sse-core.ts` (`packages/sdk/src/acp/sse-core.ts`) is the single stateful SSE
block parser shared across every consumer that reads a raw ACP SSE byte
stream. It was extracted, behavior-preserving, from `AcpClient`'s previously
module-private `consumeSse` (commit `f4607618e`, cited in
`packages/sdk/PROGRESS.md`'s WS3-P0-a entry). It handles:

- **CRLF holdback** — normalizes CRLF and lone CR to LF, but holds back a
  chunk-final lone `\r` rather than normalizing it immediately, so a
  `\r\n\r\n` block terminator split at *any* point across a chunk boundary
  (including between the two `\r\n` pairs) is never misread as extra or
  missing blank lines (`sse-core.ts:36-40,61-65`).
- **Block framing** — buffers across `ReadableStreamDefaultReader.read()`
  chunks with a single long-lived `TextDecoder` (`stream: true` between
  non-final reads, so a multi-byte UTF-8 codepoint split across a chunk
  boundary decodes correctly), and on the terminal `done` push synthesizes a
  trailing `\n\n` if the buffer still holds an unterminated block
  (`sse-core.ts:56-69`).
- **Poison tolerance** — a block with a parseable `id:` but unparseable
  `data:` (bad JSON) is reported to the caller via an error callback rather
  than thrown, so one bad event doesn't tear down the whole stream; the
  caller still advances past the poisoned id so a reconnect never
  re-requests it forever (`client.ts:269-278`, `consumeSse`'s
  `onParseError`).

**Three consumers** now share this exact parser instead of each maintaining
its own copy:

1. **The SDK client** (`client.ts`'s `consumeSse`) — the original
   implementation, now delegating to `sse-core.ts`.
2. **The cloud API's SSE proxy**
   (`apps/api/src/projects/lib/acp-sse-proxy.ts`) — refactored to consume
   `sse-core.ts` in commit `8664eb3f1`
   ("refactor(api): ACP SSE proxy persistence consumes shared sse-core
   parser").
3. **The headless ACP engine**
   (`apps/api/src/projects/session-lifecycle/headless-acp.ts`) — refactored
   in commit `667951665`
   ("refactor(api): headless ACP engine consumes shared sse-core (one parser
   repo-wide)").

The consolidation fixed **two latent defects** that existed because each
consumer had its own hand-rolled parsing before this extraction:

- **Proxy CRLF silent-drop** (fixed by `8664eb3f1`): the cloud proxy's own
  parser lacked the CR holdback described above, so a `\r\n\r\n` terminator
  split across a chunk boundary could silently drop or misparse a block
  before persistence.
- **Headless poison-kill** (fixed by `667951665`): the headless engine's own
  parser had no poison tolerance — a single malformed `data:` payload could
  kill the whole headless prompt/response cycle instead of being reported
  and skipped.

## 5. Durable transcript

The envelope log is the durable transcript: an append-only, ordinal-ordered
sequence of raw client↔agent JSON-RPC envelopes plus transport metadata
(`projectId`, `sessionId`, `runtimeId`, `direction`, `streamEventId`,
`createdAt`). Its laws are pinned by commit `cbda547e7`
("test(api): pin durable ACP envelope persistence laws (ordered, idempotent,
lossless, raw)"):

- **Append-only, ordinal order.** `ordinal` is a Postgres
  `GENERATED ALWAYS AS IDENTITY` primary key — a single global monotonic
  sequence for the whole table, never app-assigned, never scoped per
  session. Neither persist call site (`routes/acp.ts`,
  `session-lifecycle/engine.ts`) ever supplies `ordinal` in its `.values()`
  call — grep-pinned, not just read. `GET .../acp/transcript`'s `?after=N`
  replay adds `gt(ordinal, N)` to the query and always orders
  `ordinal asc`, never desc (`acp.envelope-persistence.test.ts`, "Pin 1").
- **Idempotence — and the honest exception.** Every insert calls
  `.onConflictDoNothing()`, but the property only actually *holds* (is
  DB-enforced) for the `agent_to_client` direction, where the DB's partial
  unique index covers `(session_id, direction, stream_event_id)` scoped to
  `stream_event_id IS NOT NULL`. For `client_to_agent` rows,
  `streamEventId` is always `null` (there's no SSE event id for a
  client-originated request), which falls outside that partial index's
  protection — so a byte-identical retried POST produces a **second** row,
  not a no-op. This is stated as a real, currently-open gap
  (**"DISC-05"**), not silently accepted: pinned in
  `acp.envelope-persistence.test.ts`'s test named
  `'VIOLATION (pin 2, client-direction sub-claim): a byte-identical retried
  client_to_agent POST produces a SECOND row, not a no-op'`. Its user-visible
  consequence — a retried `session/prompt` renders as **two** user
  messages — is separately pinned at the SDK reducer layer by commit
  `2fdc62bc3` ("refactor(sdk): reduce.ts dead-code + guarded numeric-id
  simplification; pin DISC-05 duplicate projection") in
  `packages/sdk/src/acp/reduce.test.ts`'s test named
  `'DISC-05: a retried session/prompt (duplicate, null streamEventId,
  distinct ordinals) renders as TWO user messages — pinned, not fixed
  here'`. The `(direction, streamEventId)` dedupe key in `reduceEnvelope`
  only fires when `streamEventId != null`, so this class of duplicate is
  never deduped by the reducer either. **This is stated honestly as an open
  decision awaiting DISC-05's own schema fix — not resolved by this
  document, and not resolved by either cited commit.**
- **JSONL is a lossless export.** `acpTranscriptJsonl` (`transcript.ts:317`)
  emits one JSON line per row — `{ordinal, direction, streamEventId,
  createdAt, envelope}` — round-trippable back to the original stored rows.
  Pinned over a realistic mixed fixture (prompt / tool_call /
  tool_call_update / permission / question) in
  `apps/api/src/projects/lib/acp-envelope-jsonl-lossless.test.ts`, including
  that an envelope with unusual-but-valid extra vendor keys survives
  byte-identically.
- **Markdown/HTML are projections, not the source of truth.**
  `acpTranscriptMarkdown`/`acpTranscriptHtml` (`transcript.ts:385-412`)
  render one section per *coalesced* `AcpChatItem` (one heading per message/
  tool/plan/permission/question), never one heading per raw wire chunk — a
  lossy, human-readable view built from `projectAcpChatItems`, not a
  replacement for the raw envelope log.

## 6. The session store

`AcpSession` (`packages/sdk/src/acp/session.ts`) is the framework-free store
every host (`useAcpSession`, `useSession`, headless consumers) sits on top
of. In one paragraph: it bootstraps a session by fetching `initialize` +
`session/new`/`session/load` plus the full persisted transcript
(`enqueueHistory`), then folds every subsequent live SSE event through the
same incremental reducer (`reduceEnvelope`) the one-shot `project*`
functions use; writes are microtask-batched so multiple synchronous
`enqueue()` calls collapse into a single `emit()`; a `send()` echoes the
outbound prompt optimistically into `chatItems` before the network round
trip resolves, with ordinal-keyed reconciliation against the real persisted
row once it arrives. Commit `846d97601` ("feat(sdk): persisted-busy reload
recovery + bounded history dedupe structures") added two things pinned here:
first, **persisted-busy recovery** — if a page reloads mid-turn, bootstrap
history alone can leave `turnState.busy` true from an orphaned
`session/prompt` no live client is tracking; a **signal-based wedge guard**
(`clearStalePersistedBusy`) clears that stale busy state on exactly two
connection-lifecycle signals — a terminal bootstrap failure, or the live
stream reaching connection state `'failed'` — deliberately *not* a
wall-clock timeout (the store has no clock anywhere in its transition logic)
and deliberately *not* plain `'closed'` (which also fires on the session's
own benign `close()` and must not forget a still-open turn across a
same-session reconnect). Stated honestly, there is a **residual case** the
guard does not cover: a harness that dies without the bridge ever surfacing
either signal (bootstrap succeeds, the stream reaches `'open'` and just
idles forever) leaves `busy` wedged true until the user's own next action
(`send()`/`cancel()`) supersedes it — accepted because the wedge is a soft
UI signal, not a functional lock (`send()` already proceeds regardless of
persisted-only busy). Second, **bounded dedupe structures**: the old
`historyOrdinals` (an unbounded `Set<number>` retaining one entry per
history row for the life of the session) was replaced by a single
`historyHighWaterMark: number` — sound, not just an optimization, because
ordinals are strictly-increasing identity-column values and
`enqueueHistory` is only ever called with the *full* persisted transcript,
so no genuinely-new ordinal can ever be smaller than one already accepted.
The reducer's own `dedupeKeys` (a public-function-facing structure any
external caller can feed out-of-order rows into) instead got a bounded
256-entry recency window rather than a bare high-water mark, because a
mark-only design there could misclassify a genuinely-new-but-smaller-id row
as a duplicate.

## 7. Deprecation pointer

The OpenCode-wire projection stack (`transcript.ts`'s `formatTranscript`/
`TranscriptOptions`/`SessionInfo`/`MessageWithParts`/
`DEFAULT_TRANSCRIPT_OPTIONS`, `core/turns/classify.ts`'s `classifyPart`/
`classifyTurn`, `core/turns/view-model.ts`'s `toolViewModel`,
`core/turns/tool-registry.ts`'s `toolInfo`, and the React binding
`react/chat/use-chat-turns.ts`'s `useChatTurns`/`TurnView`) is deprecated as
of commit `a3dfe0cc2` ("chore(sdk): deprecate OpenCode-wire projection stack
+ golden parity fixtures (retirement prereqs)") — superseded by the ACP
projection layer documented in §5/§6 above (`acpTranscriptMarkdown`/
`acpTranscriptHtml`/`projectAcpChatItems`). The deprecation is JSDoc-only and
additive: every tagged export keeps working (`apps/whitelabel-demo`'s chat
rendering and `apps/web`'s transcript-export modal still depend on it
directly; `apps/mobile` carries a hand-forked local copy that never imports
the SDK's, and `?oc` deep-links are unrelated to this stack). That same commit
added a **golden parity harness** —
`core/turns/__fixtures__/opencode-wire-mixed.json` (a wire fixture exercising
all 12 `Part` variants) plus three golden outputs
(`opencode-wire-classified.golden.json`, `opencode-wire-tool-views.golden.json`,
`opencode-wire-transcript-body.golden.md`) captured from the current
implementation, asserted unchanged by `transcript.golden.test.ts` — the
contract a future removal must satisfy or explicitly break against.
**Removal itself is out of scope here and rides a future cycle** (tracked as
WS4-P6 in the cycle ledger,
`docs/superpowers/plans/2026-07-15-cortex-cycle-progress.md`); this commit is
prerequisites only — zero deletions, zero forced host migrations, zero
behavior change.
