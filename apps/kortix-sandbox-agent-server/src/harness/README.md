# Internal harness boundary

`harness.ts` is the only module that imports a concrete adapter. It resolves
the implementation and exposes a definition for configuration, boot, and service
creation. The import rules are in [ARCHITECTURE.md](../../ARCHITECTURE.md). Two adapters are registered: `pi`, which every new
session runs, and `opencode`, deprecated (see "OpenCode sunset" below). An
unknown id fails the boot.

```ts
const cfg = loadConfig()                 // reads KORTIX_HARNESS, then the selected adapter's env
const selected = resolveHarness(cfg)     // openCodeDefinition | piDefinition
const runtime = selected.createService(cfg, projectEnv)
await runtime.lifecycle.start()
```

## OpenCode sunset

Since 2026-10-23 every new box runs pi. There is no `pi_harness` flag, and the
manifest's `runtime:` selects nothing (`runtime: opencode` validates with a
deprecation warning). OpenCode serves only boxes that booted it before, and it
will be deleted. Until then:

- Everything only OpenCode uses is `@deprecated`: `open-code/` and the
  OpenCode-only names outside it. Never call it from new code and never add a
  feature to it. Change it only to fix a bug that breaks a running OpenCode
  session.
- Build new behavior in `pi/` or `shared/`, behind a capability
  (`RUNTIME_CAPABILITIES`), never behind a harness check.
- Names that say `opencode` but serve pi too (`opencode_session_id`,
  `/kortix/opencode/*`, the OpenCode-shaped event wire pi emits) are wire
  names, not OpenCode code. They stay until a separate rename.

## Selection

`KORTIX_HARNESS` (`opencode` | `pi`; unset means `opencode`) is set by apps/api
at provisioning (`buildSessionRuntimeEnv`): always `pi`. Unset still means
`opencode`, so a box that booted OpenCode before the sunset keeps it.
`loadConfig` reads it BEFORE the adapter loads its own environment, so only the
selected adapter's variables are parsed. There is no per-request switching: one
box, one harness, for the life of the box. A new box of an OpenCode session
boots pi. With `session_log_restore` on, that box restores the log into pi and
records the switch in `harness.history` ("Harness history, a switch" below).
`POST /v1/projects/:p/sessions/:s/log/switch-preflight` (apps/api) answers
before that happens: whether the switch can happen (`available`, `reason`:
`same_harness`), whether the new box restores the
log (`restores`; off, `losses` starts with `history`), what the session uses
that the target handles worse (`losses`) and everything the target lacks, used
or not (`unsupported`). The contract is `switchPreflight` in
`@kortix/api-contract/session-log` (`capabilities.ts`).

## Models: the LLM gateway only

Both harnesses send every model request to the Kortix LLM gateway, under one
provider id, `kortix`. There is no native provider mode. OpenCode's composed
config always registers the `kortix` provider and sets
`enabled_providers: ['kortix']` (`buildOpencodeConfigContent`,
`open-code/lifecycle.ts`), and every model ref becomes `kortix/<wire id>`.

- A box without the gateway env (`KORTIX_LLM_BASE_URL` + `KORTIX_TOKEN`, or
  `KORTIX_LLM_PROXY_URL`) logs an error at each config compose. OpenCode keeps
  the `kortix`-only config with no upstream, so turns fail; it never falls back
  to provider keys in the process env. pi throws at model setup
  (`createPiModels`, `pi/model.ts`).
- `POST /kortix/env` with `llmGatewayEnabled: true` sets `KORTIX_LLM_BASE_URL`
  and re-points a running LLM proxy. `llmGatewayEnabled: false` (an API from
  before the graduation) is logged and ignored: it never clears the gateway env.

## Ownership

| Location | Responsibility |
| --- | --- |
| `harness.ts` | Resolution, `loadConfig`, the boot context and the union helpers every box uses |
| `contract/` | Named host-facing operation contracts (`control`, `diagnostics`, `queries`, `proxy`, `lifecycle-contract`, `boot-state`, `server`, `session-log`); no router dependencies |
| `shared/` | Adapter-neutral steps both adapters call: agent env file, `on_boot`, attachment stripping, the host facts of `/kortix/health` (`host-health.ts`), and every daemon-to-API callback (see below) |
| `../services/runtime-assets/port.ts` | Harness maintenance contract, owned by the service that consumes it |
| `open-code/service.ts` | Composition over one lifecycle; native typed ports |
| `open-code/boot.ts` | Native cold boot, warm seed/adoption, first turn, reconciliation and relays |
| `open-code/control.ts`, `open-code/diagnostics.ts`, `open-code/queries.ts` | Native execution, configuration, state queries, diagnostics and attachments |
| `open-code/proxy.ts` | Native readiness, upstream client, timeout classification and payload processing |
| `open-code/events.ts`, `open-code/event-bus.ts` | Native event reading, session identity and recovery instructions |
| `open-code/config.ts`, `open-code/paths.ts` | Native environment, authored config discovery and paths |
| `open-code/assets.ts` | Native binary/plugin updates and skill placement |
| `open-code/background.ts`, `open-code/resource-diagnostics.ts`, `open-code/quick-queue-interrupt.ts` | Native offload, turn guard, tool-boundary queue interrupt and diagnostic projection |
| Other `open-code/` modules | Native database, projections, pins, attachments, audit and recovery |
| `pi/service.ts` | Composition; loads pi lazily so an OpenCode boot never pays for it |
| `pi/runtime.ts` | The in-process pi `Agent`: model, tools, skills, the root `AGENTS.md`, today's date (each turn, OpenCode's `Today's date` line), turns, transcript, durability |
| `pi/boot.ts` | Session boot: the same host steps as OpenCode, then `pi-ready` |
| `pi/surface.ts` | The raw OpenCode-compatible routes, answered in-process |
| `pi/vcs.ts` | The Changes tab on pi: `vcs: 'git'` on `/project/current` and `GET /vcs/diff` (`mode=branch` against the merge base with `KORTIX_DEFAULT_BRANCH`, `mode=git` against HEAD), OpenCode's `VcsFileDiff` shape |
| `pi/turn-events.ts`, `pi/transcript.ts` | pi events → Kortix session events (`@kortix/api-contract/transcript`); the transcript store |
| `pi/interactions.ts`, `pi/tools.ts`, `pi/model.ts`, `pi/sampling.ts` | Permissions/questions, workspace tools, gateway model, the agent's `temperature`/`top_p`/`steps` on each model request |
| `../routes/` | Controllers, authentication, request parsing, HTTP status/headers, gzip and SSE delivery |

## One host relay (E12)

Every callback a box makes to apps/api lives in `shared/`, with Kortix names
and the body types of `@kortix/api-contract/runtime-relay`. An adapter decides
WHEN a turn begins or ends and what its identity is; the shared module owns the
route, the body, the credential, the retries and the dead-token breaker.

| Module | Callback |
| --- | --- |
| `shared/turn-relay.ts` | `POST /projects/:id/turn-stream` (initial-turn claim, `turn_accepted`, `turn_abandoned`, `runtime_session` pin, `turn_begin`, `end`, `steer_read`, memory-guard end), `/turn-question`, `/turn-permission` |
| `shared/projection-relay.ts` | `POST /platform/runtime-projection`; the adapter registers its state reader |
| `shared/audit-relay.ts` | `POST /projects/:id/sessions/:id/audit/events`: sanitize, batch, spool; batches carry `source: 'runtime'` and the harness id. pi feeds it every frame it publishes (`PiRuntimeHooks.onFrame`), so pi sessions have a tool audit trail |
| `shared/boot-timeline-relay.ts` | `POST /platform/boot-timeline` |
| `shared/session-log-journal.ts` | `POST /projects/:id/sessions/:id/log/journal`: the session log (`kortix.session/2`, `@kortix/api-contract/session-log`), and `GET`/`PUT …/log/blobs/:sha256`: the bytes of each attachment it names (P2.13), see below |
| `shared/session-log-restore.ts` | `GET /projects/:id/sessions/:id/attachments/:id`: the full text of each text a restore answer (P6.1) stores by reference (`sessionLogFromRestore`, `apiTextReader`), see "Restore" below |
| `shared/session-log-boot.ts` | `GET /projects/:id/sessions/:id/log/manifest` and `POST …/log/restore`: the boot reconcile (P6.4), see "When the boot restores" below |

A callback added here reaches every harness. The API accepts the pre-W3
spellings (`opencode_session_id`, kind `opencode_session`) from older daemons.

## Session log (P2.4, P2.5, P2.6, P4.3, P4.3b, P6.2, P6.3, P6.4, P6.5)

An adapter implements `SessionLogPort` (`contract/session-log.ts`):
`changes(cursors)` returns the messages, tombstones, thread upserts and session
patch since one `ExportCursor` per thread; `restore(log)` writes a session log
into the native store before the harness starts and returns the cursors of what
it wrote and the counts of model-visible content it could not write
(`SessionLogRestoreResult`); `held()` names every message id the native store holds (and,
on OpenCode, every id it held and deleted) for the boot reconcile, or null when the store is
missing;
`live(threadId, messageId)` names the seq (and pi's `created_at`) of a message
of the live turn (see "The live turn" below); `blob(sha256)` returns the bytes
behind an attachment the last `changes` exported as `ref: blob:<sha256>`;
`capabilities` is the adapter's `AdapterCapabilities`. pi implements it
(`pi/session-log.ts`, P2.5), and OpenCode (`open-code/session-log.ts`, P2.6).
Both rebuild the whole log on each read and diff it against the cursors with
`logChanges` (`shared/session-log-journal.ts`).

Attachment bytes (P2.13). Both exports write an image or file (a prompt's, or
a tool result's) as `ref: blob:<sha256>` with `sha256` (and `bytes` on a
block): the bytes are only in the native store. A collection starts one
attachment pass over the sha256s the boot has not settled and waits for it at
most 10 s before its records enter the dirty set; the pass goes on in the
background. The pass asks `GET …/log/blobs/<sha256>` for the session's object
(4 at a time) and uploads `blob(sha256)` with `PUT …/log/blobs/<sha256>` for
each one the API lacks, one at a time (at most 50 MiB; the API checks the
digest, stores one object per sha256 per session in the session's attachments
folder and the `session_log_blobs` index, gives the upload a 95 s request
deadline and cancels a body not received in 60 s with 408, and takes at most
one upload per session and 4 per replica, else 429). The
`kortix-attachment://` ref both answer replaces `blob:` in the record: a record
names only an object that exists, and `apiBytesReader` reads it back on a fresh
box (4 reads at a time). A record whose attachment is not settled when the wait
ends goes out with `blob:`, and the next collection exports it again with the
ref or retries. A failed lookup, a 429 or a 401 stops the pass and counts
nothing. One failed upload in a pass counts against its sha256 (after 3 it
keeps `blob:` for the boot); a second stops the pass and counts none, because
two are an outage. A 404 (an API without the route), a 400 or 413, a body over
50 MiB and bytes the store lost keep `blob:` for the boot at once. A boot
re-sends every message, so a session journaled before P2.13 gets its objects at
its next boot on a new daemon, while its box still holds the bytes.

The pi boot starts the journal once the runtime is ready and a session is
bound, before the first turn, at the generation and with the cursors the boot
reconcile returned (below). `lifecycle.stop()` stops it before the runtime
stops. The adapter reads `PiRuntime.sessionLogSnapshot()`: the root's
`SessionManager` branch and session header, each sub-agent child's agent
messages, and the v1 transcript. pi entries carry pi's own ids, so the runtime
records the Kortix message id of each pi message (and of each compaction
entry: its marker) and persists the map and the header in its dump; block ids
are the v1 part ids. `seq` is monotonic per thread and never reused (the API
keeps a tombstoned row's seq): a root message's seq is its entry's position in
pi's append-only entry list (on a restored store: the seq the dump maps the
entry to, and above every restored seq for a later entry), and the runtime
issues each child message a seq once and persists it. The mapping decisions are
in the header of `pi/session-log.ts`. A v1
file part pi never received is a harness block (`kind: 'undelivered_file'`,
`model_visible: false`), never an attachment: the model never saw it, so a
restore must not present it.

The OpenCode export reads `opencode.db` through `OpencodeDb.storeSnapshot()`
(every session, message, part and todo row, one WAL snapshot), assembles the
v1 rows as OpenCode's HTTP serves them, drops attachment bytes as the API's
mirror does, and converts them with `fromV1`: one mapping with the API's
capture (P2.7) and backfill (P3.1). Its records equal `fromV1` of the mirror
rows except in the fields only the daemon knows: `seq`, `producer`
(`opencode`), attachment `ref`/`bytes`/`sha256`, and the session's title,
`created_at`, todos, `restore_grade: 'native'` and harness history (the list
is in the header of `open-code/session-log.ts`). `seq` is issued once per
message in OpenCode's message order and persisted in
`$KORTIX_RUNTIME_STATE_DIR/opencode-session-log.json`, so a restart keeps
every seq and a revert never hands a deleted message's seq to the next one;
the deleted messages reach the journal as tombstones. `startSessionRuntime`
runs the boot reconcile and starts the journal before the event loop and the first prompt;
the service's host `lifecycle.stop()` stops it before OpenCode stops, and a
restart (`this.stop()` inside the native lifecycle) leaves it running.

### Restore (P6.2 pi, P6.3 OpenCode)

The boot runs these steps when the native store is behind the log (P6.4, "When the
boot restores" below):

1. `POST …/log/restore` (P6.1) answers `SessionLogRestore` `{ generation, log, revs, seq_max, blobs }`,
   or 413 `session_log_too_large` for a log over the API's cap (see "Memory" below).
   The claim raises the generation, and the ingest applies a put whose
   `(generation, rev)` is above the stored pair, so the box needs no rev seed.
2. `sessionLogFromRestore(answer, apiTextReader(sandboxRelayContext()))`
   (`shared/session-log-restore.ts`) reads each text listed in `blobs` through
   the attachments route with the sandbox credential (3 attempts of at most 15 s,
   60 s for all reads; only refs in this session's own folder), checks its `sha256`, and puts it back in place of
   the 16 kB preview. A text with `ref` + `bytes` and no `blobs` entry, an
   unreadable one and a wrong digest keep the preview and are listed in
   `truncated` (`not_listed`, `unreadable`, `sha256_mismatch`). An adapter's
   `readAttachment` reads attachment bytes the same way: `apiBytesReader(ctx)`
   returns a `kortix-attachment://` object of this session, and the adapter
   checks it against the block's `sha256` (`attachmentBytes`). Attachment reads
   have their own budget: 60 s for all of them, separate from the texts' 60 s
   (they run later, in the adapter's `restore`). An attachment not read within
   it has no bytes.
3. `port.restore(log, seq_max)` before the runtime starts. pi:
   `restorePiSessionLog` (`pi/session-log-restore.ts`, the mapping is in its
   header) writes the dump the runtime loads: the root's entries with a header,
   the entry → message id map and the entry → seq map (`PiDump.seqs`), each
   child's projected agent messages with their ids and seqs, and the v1
   transcript of each thread (`toV1`). The dump names the log's root thread
   (`PiDump.rootId`) and the runtime adopts it, so a session that started on
   another harness keeps one root through any number of restores. New messages
   number above the floor: `seq_max` and every seq of the log (a trailing
   `kortix.seq-floor` entry for the root, `nextSeq` for a child). It returns one cursor per thread with the
   hash the export computes for each message of the written store, and
   `dropped` (counts by kind, only for messages modelView shows next).
   OpenCode: `restoreOpenCodeSessionLog` (`open-code/session-log-restore.ts`,
   the mapping is in its header) writes one session file per thread and runs
   `opencode --pure import` on each in the directory OpenCode serves, so the
   sessions join the box's project and keep every id. It first removes every
   session from `opencode.db`: the store then holds exactly the log. That
   removal deletes work the journal has not sent, so the precondition is the
   caller's (P6.4): restore only when the native store is missing or behind the
   log, never while a turn runs. A crash between the removal and the last
   import leaves an empty or partial store; P6.4 treats a store without the
   pinned root as behind. The seq map and the id map are written to
   `opencode-session-log.json` before the removal, so a crash after the import
   never leaves a store whose export issues seqs from 1 or sends native ids;
   P6.4 treats a missing state file after a re-keying restore as behind. The root
   thread's id is the OpenCode session id (a pi root `ses_pi…` included) and
   the pin (`opencode-session-id`) names it; sub-agent threads are child
   sessions that their spawning call names. A message `fromV1` built from
   OpenCode rows is written as `toV1` gives it back, with its attachment bytes
   as data URLs; any other message is written for what the model sees. An id
   OpenCode rejects (no `ses`/`msg`/`prt` prefix, such as pi's `msg_…-p0`
   part ids) is re-keyed, and `opencode-session-log.json` keeps native id →
   log id (`ids`) beside the seqs, so the export renames it back. New
   messages number above the floor (`seq_max` and every seq of the log). A
   running OpenCode (a warm seed) needs no stop: it reads sessions per request,
   also a session it served before the restore (tested). The warm seed's
   rotation still names the seed's root (`markSeedBakedSession`, the
   `opencode-seed-baked-id` marker, `initial-session.ts`), which the restore
   deletes: P6.4 runs the restore before the boot resolves its root
   (`maybeCreateInitialOpencodeSession`) and clears the marker, or the boot
   creates and relays a root the restore then removes.
   It returns the cursors of the written store and `dropped`, as pi does.
4. `startSessionLogJournal(port, { generation, cursors })`: the export skips
   every restored message by hash (C13).

### When the boot restores (P6.4)

`reconcileSessionLog(port)` (`shared/session-log-boot.ts`) decides, restores, and
returns what the journal starts with (`{ generation, cursors, session }`). pi
runs it beside the workspace checkout (pi's dump needs no `/workspace`) and
awaits it before `lifecycle.start()`; the runtime adopts the root the dump names
at start, so a service built before the restore runs under the log's root.
OpenCode runs it in `startSessionRuntime`, after the workspace (`opencode
import` keys sessions to the served directory), before the event loop and the
root resolution; a restore clears the seed marker
(`clearSeedBakedMarker`), or the root resolution would rotate off the restored
root. No turn runs at either point.

- **The flag.** apps/api sets `KORTIX_SESSION_LOG_RESTORE=1` when the hidden
  project flag `session_log_restore` is on (every provisioning path:
  `buildSessionSandboxEnvVars`). Off: no manifest read, no restore; the box
  keeps its native state and journals at its persisted generation (0 when it
  never restored). The env is built when a box is provisioned, so a change of
  the flag reaches the next new box of a session; a box that is already running
  (or resumed in place) keeps the value it booted with.
- **Behind.** `GET …/log/manifest` lists every stored message id (`deleted` for
  a tombstone) and the session generation. The store is behind when the log
  holds a live message and: `held()` is null (no store; OpenCode: no pinned
  root in the store, or a lost `opencode-session-log.json` beside stored
  messages, whose next export would issue seqs from 1), or the manifest
  generation is above the one this box persisted (another box claimed the
  session), or a live id is neither held nor one the last restore left
  unwritten (a `context` record both harnesses rebuild).
- **Flag off after state loss (as before P6.4).** A box whose native store is
  gone starts empty: the agent does not know the history, and its first turn's
  journal batch reuses seqs the log holds (422 `seq_conflict`, the batch is
  dropped). The stored transcript still shows the whole history.
- **Unsent work never reads as behind.** Only ids are compared, one way: a
  message the store holds that the log lacks (a turn not yet journaled), a
  newer version of a stored message, and a message OpenCode deleted after the
  seq map issued it (a revert not yet tombstoned) leave the store current.
  Content hashes are not compared: a store with unsent edits differs from the
  log by design, and the journal sends the difference.
- **The restore.** The claim, then the texts and the attachment bytes read at
  the same time (each with its own 60 s budget), then `port.restore(log,
  seq_max, read)`. After the write, `$KORTIX_RUNTIME_STATE_DIR/session-log-restore.json`
  keeps the claimed generation, the ids the write left out, and the D3 notice:
  a crash before it reads as behind at the next boot, and a daemon restart
  journals at the claimed generation. A 404 (no stored log) or 503 (operator
  switch off) claims nothing and restores nothing. A 413 `session_log_too_large`
  claimed but carries no message: see "Memory" below. Any other failure (5xx,
  408, 429, network, a body that does not parse, a write that throws) is
  retried, 3 attempts, each a new claim; then the boot fails
  (`initialRuntimeSessionError`, the proxy answers
  `initial_runtime_session_failed`) and no journal starts. The claim commits
  before the answer leaves the API, so a box that kept its store after a failed
  restore would post below the claimed generation (409: its journal stops for
  the boot) and the next healthy boot would restore over that boot's turns.
  The manifest is retried the same way, but no claim happens there: after its
  retries a box with a store (`held()` not null) boots on it at its persisted
  generation and logs one warning, and only a box with no store fails the
  boot. One exception: before its first restore POST the box writes
  `claiming: true` into `session-log-restore.json`. A restore clears it, and so
  does a 404 or 503 to the first attempt (nothing was claimed), and a later boot
  whose manifest shows no claim above this box. A 404 or 503 after a failed
  attempt settles nothing: that attempt may have claimed, so the boot fails
  with the mark kept. While the mark stands, a manifest that cannot be read
  (5xx, network) fails the boot even with a store: a box that claimed and then
  failed or died may hold a store below the claim. A manifest that answers
  403, 404 or 503 (the ingest kill switch) boots the store and keeps the mark:
  the journal route has the same gates, so nothing posts below a claim, and
  the first boot that reads a manifest restores or clears the mark. A
  manifest above this box's generation reads as behind even when every message
  in it is tombstoned. A brand-new session (no store, the manifest lists no
  live message or answers 404) boots empty, as before.
- **D3, a partial restore** (the log's `restore_grade` is `partial`, the write
  dropped model-visible content, or a text kept its preview). The agent: a
  user message with one text block (`prt_kortix_restore_g<generation>`, naming
  what is missing) after every seq the API holds, under a wire id
  (`mintWireMessageId({ after })`, as a client prompt is minted) above every id
  of the thread, so hosts that order placed messages by id show it after the
  restored history and before the next turn,
  written into the native store with the log (the adapter writes twice), so
  the next request carries it. Its cursor entry is dropped, so the journal
  sends it as the store holds it: it is in modelView of the log. Neither
  native store keeps an origin, so both exports give a user message with a
  `prt_kortix_restore_g` block `origin: 'notification'`; the v1 transcript
  has no such notion and shows it as a user message (P5.6 renders the origin).
  A partial log that already holds an earlier note gets a new note only when
  this restore dropped or truncated something itself. The user: the
  session patch `restore_grade: 'partial'`, `grade_counts`, and
  `ext.kortix.data.restore` (`generation`, `dropped` by kind, `truncated`
  texts). The journal sets it on every session patch it sends, at every boot.
  The stored log then keeps `restore_grade: 'partial'`, so every later restore
  of the session is partial too (no new note unless it loses more); only a
  restore of a log graded otherwise clears the notice. P5.6 shows it.
- **Harness history, a switch (P7.1).** Each adapter exports a one-entry
  `harness.history` (its own harness). A restore keeps the log's history
  (`HarnessCarry` in `session-log-restore.json`: the history, the first root
  seq after the restore, the restore time), and the journal sends it in place
  of the adapter's (`carryHarness`), at every boot. When this box's harness is
  another than the last entry's (a session whose log says `opencode` boots on
  pi), the journal appends `{ harness, version, from_seq, at }`; P5.6 draws the
  switch before the turn at `from_seq`. A new version of the same harness adds
  no entry. A log without a history (a converted log) starts with the harness
  its `harness.current` names. Limit: a box that never restored (flag off)
  sends its adapter's one-entry history, which replaces the stored one.
- **Memory, and the cap.** A restore holds the whole log in memory on both
  sides. Measured on a real Platinum box (pi, 2 vCPU, 3.9 GB, Bun 1.4.3) with a
  synthetic 38.5 MB log (1,000 tool results of 40 kB): the daemon peaked at
  1.57 GB RSS (+1.45 GB, about 38x the log) and settled at 272 MB; the API
  (`POST …/log/restore`) rose by about 330 MB. Attachments cost less per
  byte: 60 synthetic 500 kB images (30 MB of blobs, 83 kB of records) peaked
  the daemon at 566 MB (+455 MB, about 15x) and the API by about 50 MB (the box
  reads them one by one through the attachments route). So the API caps what
  the box pulls: `SESSION_LOG_RESTORE_MAX_BYTES` (default 24 MiB) bounds the
  live messages' stored JSON lengths plus the bytes of the session's live
  `session_log_blobs` (full texts over 256 kB and attachments) at
  `SESSION_LOG_BLOB_WEIGHT` = 2/5 (15x / 38x ≈ 0.39, rounded up), one sum in
  daemon-memory terms. Effective maxima: 24 MiB of records alone, or 60 MiB of
  blobs alone (about 125 screenshots of 500 kB); either peaks the daemon at
  about 1 GB. 60 screenshots of 500 kB restore; 400 (200 MB) answer 413. p99.9 of
  prod sessions is about 15 MB, p99 3.7 MB. The size query reads the records
  inside Postgres before any record leaves it. Above the cap the claim still
  happens and the answer is 413
  `SessionLogRestoreTooLarge`: every thread without messages, every rev,
  `seq_max`, `messages` (the count left out), `bytes` and `limit`; no record
  leaves Postgres. The box writes the log's root with the D3 note alone
  (above `seq_max`, so new messages number above every stored seq), keeps no
  other thread, persists every stored id (`revs`) as unwritten so later boots
  do not read the store as behind, and journals at the claimed generation. The
  note tells the agent the size and the limit; the session patch carries
  `restore_grade: 'partial'` and `dropped: { message: <count> }`, which P5.6
  shows as "Missing: N earlier messages". The stored history stays in the
  transcript. The same 38.5 MB log over the cap: the daemon peaked at 135 MB
  (+29 MB) and the API rose by about 21 MB; the 30 MB of images over the cap:
  128 MB and about 2 MB. The switch preflight (`POST …/log/switch-preflight`)
  reports `restores: false` and a `history` loss for a log over the cap. A 413 with another body (a proxy)
  claimed nothing and restores nothing, as a 404.
  ponytail: an over-cap restore gives the agent none of the history; restore
  the newest messages under the cap (paging) when sessions near it are common.

Default-on: the cap above bounds what one restore makes the box hold (live
records plus 2/5 of live blobs, 24 MiB by default). It does not bound the native
store a box already holds: a box with a large store loads it at boot (`held()`)
before any restore. A fresh box drops only an attachment whose record still
says `blob:` (P2.13 uploads the bytes). Precondition for prod default-on: a
release whose kortixd handles the 413 (an older kortixd boots without the
restore and its journal stops at 409). Dev turns `session_log_restore` on for
every project without a stored value (`SESSION_LOG_RESTORE_DEFAULT_ENABLED` in
`deploy-dev.yml`, 2026-10-15); prod does not yet.

Known limits of the boot reconcile:
- Losing `session-log-restore.json` (or OpenCode's `opencode-session-log.json`)
  after a restore reads as behind (the persisted generation falls to 0, or the
  seq map is gone), and the next boot restores over any work the journal had
  not sent. In practice the state file, pi's dump and `opencode.db` share the
  box's home volume, so they are lost together.
- Two boxes for one session (a stale box that wakes after a provider
  replacement): the waking box reads the newer generation as behind, restores,
  claims a newer generation and fences the box that was active (its journal
  gets 409). The box that booted last owns the session.

Proved in `pi-session-log-restore.test.ts` (real runtime, fake model, isolated
home, dummy key): for the 7 golden fixtures and a pi session recorded in the
test, the request pi sends next equals `modelView(log)` plus the prompt, for the
root and for each sub-agent resumed through `task` with its `task_id`. The
recorded session round-trips: export → restore → export is equal except pi's
system prompt messages (`kind: 'context'`), which pi rebuilds at the next prompt.
The restore names each thread's last context record in the dump (`contextId`):
the first system prompt pi rebuilds takes that id, so the record is replaced, not
added. Three restores of one session keep one context record per thread (the
same ids); before, each restore added one per thread pi prompted.

Proved in the `opencode-session-log-restore-*.test.ts` files (the pinned OpenCode binary,
`opencode serve` in an isolated home against a fake model, dummy key): the 7
golden fixtures, converted and partial logs, an OpenCode session and a pi
session recorded in the test, a second restore after a journaled turn, the seq
floor, a restore into a running OpenCode, and a restore that gives a session
the running OpenCode already served a different history. Each checks the hash guard
(`changes(cursors)` returns no message and no tombstone) and the next request
of the root and of each sub-agent (resumed through `task` with its `task_id`)
against `modelView(log)`. The recorded OpenCode session round-trips: export →
restore → export is equal. A crash after the import (the pin write fails)
leaves the seq and id map on disk: the next export carries the log's seqs and
ids. Each `dropped` kind has a case: a call without a result
(`tool_result`), a text still stored by reference (`text`), an attachment
without bytes or with bytes that fail its `sha256` (`attachment`). One
`opencode import` writes every thread (a holding session, then one transaction
moves each thread's rows to its own session): for the 7 fixtures and a 4-thread
log, the session, message and part rows equal those of one import per thread
except the write times (a message's `time_updated`, a part's times), every other
table keyed by session holds the same row counts, and a message under another
thread or a missing thread fails that comparison. A row left on the holding
session fails the restore before the delete could cascade it away; the store then
holds no root, so the next boot restores again.

Known limits of the OpenCode restore:
- One `opencode import` process runs per restore, whatever the thread count; its start dominates the restore time (about 2 s on a 2-vCPU Platinum box). The version comes from the running OpenCode's `/global/health`; without an answer, `opencode --version` runs first (one more process start).
- An attachment whose record still says `ref: blob:<sha256>` (its upload failed, it is over 50 MiB, or it was journaled before P2.13 and its box never booted on a new daemon) has no object: a fresh box restores it only when `readAttachment` has the bytes. Without them it is left out and counts in `dropped.attachment` when the model would see it next.
- A layout OpenCode cannot show in its order (an assistant message before the summary, a kept run that is not the contiguous run before the marker) counts in `dropped.layout`.
- The id map (`ids` in `opencode-session-log.json`) is the only record of a re-keyed id. A lost map renames nothing back: a uuid thread id comes back as `ses_<sha>` (a second thread in the API), and a re-keyed pi part id as `prt_…` (a changed block id). Real Kortix roots (`ses_…`, `ses_pi…`) are never re-keyed; pi part ids are.

Known limits of the pi restore:
- An image whose record still says `ref: blob:<sha256>` (see the OpenCode limit above) cannot be restored in a fresh box: `apiBytesReader` reads only a `kortix-attachment://` object. It counts in `dropped.attachment`.
- A call input that is not an object or a string (a converted row that lost it) goes out as `{}` and counts in `dropped.tool_input`.
- A `layout` compaction is rendered as entries after hiding the history; a native pi compaction before it cannot be hidden and keeps its summary first.

Known limits of the pi export:
- A dump written before P2.5 has no header; pi makes a fresh one on load, so `created_at` is the restart time for a session that spans the upgrade.
- The journal does not start on a box with `repoMaterializationError` (the boot returns before it): turns run through the proxy on such a box are not journaled.

Known limits of the OpenCode export:
- OpenCode 1.18.23's compaction part has no `tail_start_id` on a live box, so the compaction block's `first_kept_message_id` is `null` (what OpenCode stored; a restore into another harness counts it as a missing cut point).
- A daemon restart sends every message again in its first batch: only a boot that restored gives the journal its cursors.
- A lost or corrupt `opencode-session-log.json` issues seqs again from 1 (a corrupt one logs a warning) until a restore (P6.3) writes the seqs of the API's log.

### Bumping a harness (P6.5)

Each adapter declares in its capabilities what its oracle suites passed against:
`PI_CAPABILITIES` and `OPENCODE_CAPABILITIES` (`@kortix/api-contract/session-log`,
`capabilities.ts`: apps/api reads the same manifests for the switch preflight,
`POST /v1/projects/:p/sessions/:s/log/switch-preflight`), field `harness_versions` (a semver range, today
`1.0.3 || 1.2.0` and `1.18.23`) and field `schema_minors` (today `[1]`). Both are written
by hand, never derived from the pin. `session-log-adapter-versions.test.ts`
reads them and fails when a pin leaves them:

- pi: the four `@earendil-works/pi-*` deps in `package.json` (the daemon bundles
  them) and `PI_HARNESS_VERSION` (`pi/version.ts`). `@earendil-works/pi-codemode` and
  `quickjs-wasi` are pinned beside them at the versions pi-coding-agent depends on (codemode's
  worker and wasm, above): move them with the bump, and check that pi still resolves the
  worker as `./src/extensions/codemode/worker.ts` (`getCodemodeWorkerSpecifier`).
  `@silvia-odwyer/photon-node` (pi's image resizer, "Images" below) is pinned the same way.
- OpenCode: `opencode` in `packages/shared/src/runtime-versions.json` (the image
  installs it; `opencode-db.test.ts` also gates its minor line).
- Both: `SESSION_LOG_MINOR` in `@kortix/api-contract/session-log`.

To bump a harness or the minor:

1. Change the pin. pi: the four deps and `PI_HARNESS_VERSION`, then
   `pnpm install`. OpenCode: `runtime-versions.json`; the oracle downloads the
   npm platform package of the new version once into
   `~/.kortix/opencode/<version>/` (60 MB, about 2 s).
2. Run the oracle suites: `bun run test session-log` in this app (8 files, 145
   tests, about 2 min on a laptop): both adapters' export and restore against
   the real harness and the mock LLM (`helpers/fake-model.ts`, dummy key,
   isolated home), the golden and recorded logs, the boot, the journal, the
   guard.
3. Fix the adapter until they pass. Then add the version to the adapter's
   `harness_versions` (`1.18.23 || 1.18.24` while boxes on the old pin still
   run) or the minor to `schema_minors`.

The suites run in the `packages` lane (`tests/bin/package-quality.ts` runs
`pnpm --filter kortixd test`) and in the diff-scoped `pnpm test` when this app,
`packages/shared` or `packages/api-contract` changes. The negative controls
prove the oracle can fail: OpenCode's golden test checks a log with one changed
answer against the request and expects a difference, and pi's partial-log test
expects exactly the one difference the restore dropped. A broken mapping fails
the suites: dropping pi's reasoning fails 1 of 22 pi restore tests, writing
OpenCode reasoning as text fails 1 of 26 OpenCode restore tests, and writing an
assistant `text` in place of its `model_text` fails 1 test in each suite. No
harness exports an assistant `model_text`, so that test sets one on a golden
reply.

### The v2 stream (P4.3)

`GET /kortix/runtime/events?schema=v2` streams the session log as `log.*`
frames (capability `session.log.v2`; payload schemas in
`@kortix/api-contract/session-log` `events.ts`, `SESSION_LOG_EVENTS`) in place
of the v1 transcript frames, and every other v1 frame unchanged. The frames
ride `sessionLogEventBus()`, a second bus with its own seq and epoch, so the
v1 stream keeps dense seqs and the v2 stream resumes with its own `since` and
`epoch`. Without `schema`, or with `schema=v1`, the stream is the v1 stream,
byte for byte (an empty `schema=` too); another value is a 400.

Frame classification (`V1_TRANSCRIPT_EVENTS` in
`services/event-bus/kortix-event-bus.ts`, the set P4.4 adds to
`@kortix/api-contract/session-log`; `kortix-event-bus.test.ts` fails when a
`KortixSessionEvent` type is unclassified):
- replaced by `log.*` (never on v2): `message.updated`, `message.removed`,
  `message.part.updated`, `message.part.removed`, `message.part.delta`;
- kept (copied onto v2): `session.status`, `session.idle`, `session.error`,
  `permission.asked`, `permission.replied`, `question.asked`,
  `question.replied`, `question.rejected`, `todo.updated`, and every frame
  beyond `KortixSessionEvent` (`session.created`, `session.updated`,
  `session.diff`, `session.compacted`, pty, lsp, `kortix.*` daemon frames).

The copy is a `tap` on the v1 bus (`kortixEventBus()` installs it): a
daemon-internal listener that runs before the subscribers and is not counted
in `subscriberCount`. The journal's v1 listener is a tap too. The
`sse-subscriber` swap blocker counts the subscribers of both buses.

| Frame | Payload | Emitted |
| --- | --- | --- |
| `log.state` | `{ generation, session }`: the session patch the batch carries | when a collection finds the session fields changed |
| `log.thread` | the thread upsert (no messages) | for each thread a collection finds new or changed |
| `log.message` | a put `{ rev, message }`, or a tombstone `{ message_id, rev }` (the journal's tombstone; no `message`; the schema has no `deleted_at`) | for each revision a collection puts in the dirty set; and a live put while a turn runs (below) |
| `log.block.delta` | `{ thread_id, message_id, block_id, delta }` | for each v1 `message.part.delta` text frame while the journal runs |
| any kept v1 type | the v1 payload, unchanged | for each such frame on the v1 bus |

The journal publishes the first three in `collectOnce`, from the same records
it posts (same ids, seqs and revs), in that order. It collects when it starts
(the store is at rest: the stream gets the session and its threads before the
first turn streams), at each turn end, when pi stores a compaction between
turns, and at the daemon stop. The delta frames
come from the v1 bus: both harnesses stream text with the v1 session, message
and part ids, which are the thread, message and block ids of the records.

#### The live turn (P4.3b)

A put with `status: 'streaming'` precedes the first delta of a message; a
later put with a higher `rev` replaces it. The client keeps the highest `rev`
of each message, appends each delta to the block it names, and lets the next
put replace the whole record.

The journal folds the v1 frames of each message it has not collected. It
publishes a live put of a message on the v2 bus only, never into the dirty
set: apps/api receives the turn end's record alone (its `log_durable_at`
reacts to a non-streaming assistant message or compaction). A live put is published:
- on the first `message.updated` of a message: the prompt (complete) and each
  assistant message (`streaming`, no blocks yet, `reply_to` the prompt);
- on each `message.part.updated` of a part the message did not have: a new
  text, reasoning, tool or step block. The put is built in the bus listener,
  before the next v1 frame, so a block is on the stream before its first delta
  and its text holds exactly the deltas published before it;
- on each `message.part.updated` of a tool part that changes its
  `state.status` or the key set of its `state.metadata` (the keys with a
  defined value: what the wire carries) (P4.7): a call that
  starts running, a task that names its child (`sessionId`), a bash call that
  names its `command`. A value change alone (bash rewrites `metadata.output`
  per stdout chunk, a pending call's `raw` grows) publishes nothing: a put
  rebuilds the whole message.

The record is `liveMessageFromV1` of the frames so far (`@kortix/api-contract`
`live.ts`, the same function the API relay runs for an older daemon):
`fromV1` with `live: true`. An open reply is `streaming`, and so is a reply
with an open call (pi completes a reply before its calls run). An open call
keeps its v1 status (`pending` or `running`) without a result; a pending call
whose input streams carries the text so far (`raw`) as its `input`. The v1
residual of each block stays in its `ext`, so a running call keeps its display
metadata (task `sessionId`, bash `command`; the SDK's `toolCallMetadata` reads
it) and `toV1` gives back the frames. The adapter's `live` names
the fields the frames do not carry, so a live put carries the `message_id`,
`thread_id`, `seq` and `created_at` of the turn end's record:
- OpenCode stores a message before it publishes it, in the order it creates
  them, so `live` issues the message's seq from the persisted seq map at its
  first frame; the turn end's collection reads the same seq.
- pi appends a message's entry at its `message_end`, after the reply has
  streamed. pi's own listener appends every earlier entry before the runtime
  sees the next event, so the reply pi streams gets the next entry:
  `getEntries().length + 1` (a sub-agent child: its `nextSeq`), with pi's own
  timestamp as `created_at`. An extension that appends a non-message entry
  while the reply streams moves the reply one entry later; its turn-end put
  then carries the higher seq and replaces the live ones. A prompt has no seq
  until pi appends its entry when its turn starts: its put goes out with the
  first assistant `message.updated` of that turn, not at accept.

The collection's put of a message has a higher rev than its live puts, and a
message the journal has collected gets no live put again.

A live message the harness removes before the journal collects it (pi
retracts a queued prompt, OpenCode reverts) leaves no ghost: on
`message.removed` the journal drops its row and, if a put of it went out,
publishes the journal-form tombstone `{ message_id, rev }` on the v2 bus; on
`message.part.removed` it publishes a fresh put without the part.

Limits:
- A block's changes after it first appears (a reasoning block's end, a
  running call's growing output, a pending call's growing `raw`) reach the v2
  stream with the next live put of that message or at the turn end, not on
  their own. A call's status change (its result included) and a new metadata
  key get their own put. Unlike the v1 stream, a pending call's input preview
  does not grow on v2 until the call runs (a P5 follow-up).
- A daemon that crashes mid-turn never sends the turn end's put: a client
  keeps a `streaming` put until the next epoch's `kortix.resync` or its reread
  of the saved session log (P4.5).
- A journal the API turned off (404, 409) publishes no `log.*` frame more,
  deltas included: a 404 API has no relay for the stream, and a 409 box is a
  zombie. A box with no control plane starts no journal: its v2 stream
  carries the kept v1 frames only.
- A `kortix.resync` on the v2 stream carries an empty `recover`: the client
  reads the saved session log again (P4.5).

Debug: `KORTIX_SESSION_LOG_DUMP_DIR=<dir>` (off by default) makes the journal
write each batch body as JSON to `<dir>` and acknowledge it at once, instead of
posting it. Use it to read what a box exports before the ingest route exists
(read the files back through `/file/content`). Nothing reaches apps/api while
it is set. Never point it under `/workspace`: the batches hold full prompts and
tool output, which would land in the project tree.

The journal (`shared/session-log-journal.ts`) drops a message whose native hash
equals its cursor's (schema rule C13), so an unchanged or restored message is
never sent again, and a thread equal to the last one it collected. It posts the
rest in order, in gzipped batches of at most 1 MB, each message with a `rev`
that is monotonic across boots (`max(Date.now() * 1000, last + 1)`), and keeps
them dirty until apps/api acknowledges `(message_id, rev)`.

Both harnesses flush it before a turn's end is relayed: pi and the OpenCode
orphan path through `relayTurnEnd`, OpenCode's normal turn end through
`relayTurnEndToApi`. pi also flushes it when it stores a compaction between
turns (`compact()`, `/session/:id/summarize`, P2.12), and the `/summarize`
turn end flushes it again (see "The conversation, compaction and slash
commands"). A compaction inside a turn (threshold, overflow) waits for the
turn's end. The memory-guard turn end does not flush. The daemon
shutdown (SIGTERM, SIGINT, the agent swap) flushes it before `harness.stop()`.
Each flush waits at most 3 s, or until the first failed post; a batch not
acknowledged by then keeps retrying in the background. A provider stop is not
known to deliver SIGTERM to kortixd, so for a provider stop the turn-end flush
and the P6 boot reconcile carry the log.

Network errors, 401, 408, 429 and 5xx (503: the operator switch is off) back
off like the audit relay; a dead session token (the KRTX-446 breaker) sends
nothing. 404 (an older API) and 409 (a newer generation owns the session) turn
it off for the boot and stop the drain at once. Another 4xx drops the batch. A
200 that does not acknowledge a batch is retried 3 times, then its pairs are
dropped: the native store still holds them. A second `startSessionLogJournal`
stops the first journal.

## Health and capabilities (E19, E1)

`GET /kortix/health` is composed by `routes/kortix/health.ts`: the host facts
(`shared/host-health.ts`), the harness's closed `harness` block
`{ id, version, state, ready, error, session, turn, details }`
(`HarnessDiagnosticsService.health`; OpenCode's pid/port and pi's model and
extensions are in `details`), `runtimeReady` computed once from both, and
`capabilities`: the host's `file.import`/`file.append`, the control's
`config.release.v1` (both harnesses), and the session features the runtime serves
(`HarnessDiagnosticsService.capabilities()`, read on each health call: all twelve
on OpenCode 1.18.15 and later, the eleven without `session.steer` on an older or
unknown OpenCode version; `session.subagents`, `session.compact`,
`session.commands`, `session.steer` and `session.log.v2` on pi). The pre-W3 flat fields (`opencode`, `opencode_pid`,
`opencode_port`, `opencode_session_id`, …) are composed from the block in
`routes/kortix/legacy-names.ts` for an older API.

The host retains its entrypoint and monitor mode (`src/app/`), Git/files/PTYs,
authentication, static previews, the LLM/connector proxy, the resource sampler,
the event sequencer, the managed-skill overlay (`src/services/skills/`) and the
CLI/daemon update scheduler (`src/services/runtime-assets/`). These call service
ports for harness behavior. They import no adapter module; adapters import no
other adapter, no route and nothing in `src/app/`. The app hands a boot what it
needs through `HarnessBootContext` (`serve` starts the HTTP server).
`bun run lint` enforces all of it.

## Steering

`POST /kortix/runtime/sessions/:id/steer` takes the `/prompt` body with
`message_id` required (400 without it), behind the same auth, readiness gate
and `X-Kortix-Turn-Verb` header. The running turn reads the message at its next
step boundary, after the running tool batch; the turn does not stop. Answers:
`202 { message_id, steered: true }`; `200 { deduplicated: true }` for an id
already admitted, steered or on the transcript; `409 { code: 'no_active_turn' }`
when no turn runs (nothing is stored, the caller sends a prompt);
`501 { code: 'feature_not_supported' }` on OpenCode older than 1.18.15.

- **Read.** pi: the loop emits the message as a user message
  (`steeringMode: 'all'`: every message steered before one boundary arrives
  together). The daemon publishes it on the wire then, under its id, and the
  replies after it name it as `parentID`. OpenCode: the first assistant
  `message.updated` whose `parentID` is the steered id. Both relay `steer_read`
  once per id (`shared/turn-relay.ts`).
- **Withdraw.** The retract (below) on an unread steered message removes it
  (pi: from kortixd's queue in front of `agent.steer()`; pi can only clear its
  queue, so the rest are steered again in order). A read one answers
  `409 { code: 'message_read' }`.
- **Leftovers (pi).** A turn that ends on its own with unread steered messages
  starts the next turn with them, in the same queue slot: the first is its
  prompt, the rest are read before its first model call. A stopped turn (Stop,
  Quick Queue, the no-progress watchdog) drops them. OpenCode needs neither: its
  loop does not end while a newer user message is unanswered.
- **Gaps.** A steered message keeps the turn's model, agent and variant. On pi
  it does not run extension `input` handlers, `/skill:` or prompt-template
  expansion (a prompt does). Unread steered messages live in memory: a daemon
  restart loses them.

## Retract

`POST /kortix/runtime/messages/:sid/:mid/retract` takes back a user message no
model call has read (`runtime.retract.v1` in `/kortix/health` `capabilities`),
behind the same auth, readiness gate and `X-Kortix-Turn-Verb` header. apps/api
uses it to cancel a forwarded prompt, to hold forwarded prompts after a Stop,
and to re-place a stranded prompt. Answers: `200 { retracted: true }`; `404`
when the session holds no such message; `409 { code: 'message_read' }` when a
model call read it (its turn runs or ran), and it stays.

- **pi** decides from its own state: an unread steered message, a prompt
  admitted behind the running work that has not started, and a `no_reply`
  message no turn has read (pi omits its session entry from the model context)
  are retracted. A retracted id may be sent again. The `DELETE` verb and the
  compatibility `DELETE /session/:id/message/:mid` answer the same way, so an
  older API gets the fix too.
- **OpenCode** cannot tell a read message from an unread one, so apps/api
  proves "unread" from the transcript first (`reachedPlacement`). The adapter
  deletes the message whole when idle; when the loop runs and refuses that, it
  deletes every part, and OpenCode's loop skips a user message with no parts.

## The pi harness

> **pi replaces OpenCode.** Every new session runs pi since 2026-10-23, and
> OpenCode is deprecated ("OpenCode sunset" above). The gaps pi still has are
> listed at the end of this section. When the last OpenCode session is gone,
> `open-code/` and the `opencode` harness id are removed.

pi (`@earendil-works/pi-agent-core` and `pi-coding-agent`, 1.2.0) is bundled
into the daemon binary and runs INSIDE the daemon process. There is no child
process, no port, no RPC and no second sandbox: pi-coding-agent's built-in
`bash`/`read`/`write`/`edit` run on `/workspace` in this process, Kortix adds
`glob`/`grep` (ripgrep) and `question`, and the hosted tools (see "Hosted
tools" below). A project needs no `harnesses/pi/` file for any of them.
Every model request goes to the Kortix LLM gateway through the
daemon's localhost LLM proxy, under the same `kortix` provider id OpenCode uses.

What the product sees is unchanged: pi's events are reshaped into the OpenCode
wire (`message.updated`, `message.part.updated`, `message.part.delta`,
`session.status`, `session.idle`, `permission.*`, `question.*`), served over the
same `/kortix/runtime/*` namespace and the same raw routes
(`/session`, `/session/:id/prompt_async`, `/session/:id/message`,
`/permission/:id/reply`, …). pi does not serve OpenCode's `/config`, `/agent` or
`/provider` (they answer `404`), so `opencode attach` cannot drive a pi
session. One pi session is one Kortix
session: the root id is `ses_pi<sha256(sessionId)[:24]>`, deterministic (or the
root thread id a session-log restore wrote into the dump), so a restart
resolves the same root and restores the transcript from
`$KORTIX_RUNTIME_STATE_DIR/pi/<session>.json`. The root's title stays
`New session`, also after a restore: the session title is Kortix's
(`metadata.name`, generated from the first prompt), and the API drops the
placeholder (`isPlaceholderOpencodeTitle`).

Config it reads (all set by apps/api for every session, harness-neutral values):
`KORTIX_MODEL` (the resolved session model), `KORTIX_COMPILED_AGENT_CONFIG`
(agent prompt, model, permission policy), `KORTIX_AGENT_NAME`, `KORTIX_LLM_BASE_URL`
+ `KORTIX_TOKEN`, the image-baked catalog at `/opt/kortix/llm-catalog.json`.
pi-only: `KORTIX_PI_STATE_DIR`.

`KORTIX_AGENT_NAME` (else the config's `default_agent`) is the session's
agent. A prompt that picks a primary agent of the compiled config runs its
turn on that agent: its prompt, permission policy, tool switches, sampling and
variant, and its `model` when the prompt names none. A prompt that picks none
runs on the session's agent, as on OpenCode. A pick of a subagent, a disabled
agent or an unknown name is logged and runs on the session's agent. pi
packages and extensions stay the ones the session booted with.

### kortix.yaml v3

A compiled set with `schema: 3` (`CompiledAgentSet`) is the only config input
for a v3 session. Every rule below holds for the working tree and for a config
release. v1 and v2 sessions keep the folder behavior the rest of this section
describes.

- **No harness folder.** pi reads no `pi.config_dir`, `harnesses/pi` or
  `.kortix/pi`: no project `settings.json`, `extensions/` or `prompts/`
  (`PiRuntime.projectConfigDir`, `config-release.ts` `piDirIn`). pi's own
  discovery of `.pi/` and `.agents/skills` is off (`discoveryRoot: null`).
- **Skills.** The managed `kortix-*` skills, then exactly the folders in
  `compiled.skills`, under the config root: the active release root, else
  `/workspace` (`resolvePiV3SkillDirectories`). The image default has no
  project skill. pi does not scan `skills/` or the legacy dir. The agent's
  `permission.skill` allowlist still hides every skill it does not grant.
- **Subagents.** No built-in `general` or `explore`. The `task` tool offers
  only declared, enabled agents with `mode` `subagent` or `all` that the
  calling agent's `permission.task` rule does not deny. The rule's subject is
  `subagent_type`, so a call to a denied name is refused before it runs.
- **Commands.** `GET /command` lists every `compiled.commands` entry with its
  `agents`. `POST /session/:id/command` runs on the body's `agent`, else the
  session's agent. An agent outside `agents` gets `403 { error:
  "command_not_enabled", command, agent }` and no turn runs. The runtime
  expands the template as OpenCode does (`expandCommandTemplate`): `$1`…`$n`
  take the words (a quoted string is one word), the highest placeholder takes
  the rest, `$ARGUMENTS` takes the raw text, and a template with neither gets
  the arguments appended. OpenCode's `` !`cmd` `` shell expansion is not
  supported.
- **Skills in the command list.** On v2 and v3, `GET /command` ends with the
  agent's granted skills as `source: 'skill'` rows, as OpenCode lists them:
  the session composer's `/` menu reads only this list. A command shadows a
  skill of the same name. `POST /session/:id/command` with a skill name sends
  the `SKILL.md` body in pi's `<skill>` block, then the arguments.
- **Extensions.** The API sends the session agent's pi packages as
  `KORTIX_PI_PACKAGES`; a repo entry is `./<path>` and resolves against the
  config root. Extensions load once per runtime start, so an agent switch
  later in the session keeps them.
- **codemode.** `KORTIX_PI_CODEMODE`, else the session agent's compiled
  `codemode`, else `on`. It is fixed at start, like the extensions.

### Config releases

pi runs the base branch's current config release, exactly as OpenCode does
(`pi/config-release.ts`, contract in `services/config-provider/`). A release is
a checkout of the base branch under `/opt/kortix/config/<release_id>`, with
the repository's own layout, verified against its Git blob IDs and sealed
read-only. pi reads from it what it reads from `/workspace`: the compiled
governance (`KORTIX_COMPILED_AGENT_CONFIG`, the agents), `skills/` (and the
legacy `.kortix/opencode/skills`), the root `AGENTS.md` (else `CLAUDE.md`),
and its own config dir (`pi.config_dir`, else `harnesses/pi`, else
`.kortix/pi`: skills, extensions, prompts, `settings.json`), resolved inside
the release by `resolvePiProjectConfigDir`.
OpenCode's files (`harnesses/opencode`) are not pi's, so a commit that breaks
only those files is a working config on pi.

- **Boot.** `runPi` starts the config choice and the workspace checkout
  together, and they never wait for each other. `lifecycle.start()` waits for
  the config only: the desired release (downloaded from the S3 project
  snapshot, else the API archive), then the last release this box proved
  (`current.json`), then the image default (managed skills and the
  provisioned governance). pi is ready before `/workspace` lands; the
  readiness gate holds turns until it does. `/workspace` is read as config
  only when the box has no Kortix API, or an API from before config releases
  graduated answers `403 feature_disabled`: then pi waits for the checkout.
- **Convergence** (`POST /kortix/config/converge`, the 60 s runtime-truth tick,
  one pass after ready). pi applies a release in place: the governance goes
  into the runtime's env, the skill directories and the `AGENTS.md` root
  (`PiConfigReleases.projectRoot()`) move into the release, and
  `PiRuntime.reconfigure()` re-reads them. A release that changes anything
  in pi's config dir other than its skills (extensions, prompts, settings, which only
  a start reads) restarts the runtime in place instead: the same root, the
  transcript restored. Nothing else restarts, and the answer carries
  `reload: null` either way. A turn in flight, or one admitted behind it
  (`PiRuntime.idle()`), defers the apply; it is asked again after the download,
  right before the swap. A runtime that refuses the config keeps the previous
  one, and the release is quarantined on the box.
- **Reporting.** Health carries the same `config` block and `config_dir_sha`
  as OpenCode, and `harness.ready` requires `config.proven`. While a release
  owns the governance, a `/kortix/env` push of `KORTIX_COMPILED_AGENT_CONFIG`
  is dropped. The session notice (`/tmp/kortix/config-release.md`) is part of
  pi's system prompt while a release runs.
- **Discovery.** pi's own discovery of `.pi/{extensions,skills,prompts}` and
  `.agents/skills` reads the release root, never `/workspace`
  (`createPiSession`'s `discoveryRoot`). The image default discovers nothing,
  and a `./` pi package does not load on it.
- **Not in a release.** npm pi packages (`harnesses.pi.packages`) load when
  the runtime starts. A change to them reaches a session at its next boot or
  restart.

Boot marks: `git-identity`, `proxy-up`, `llm-proxy-started`, `initial-turn-claimed`,
`config-release-published` (the release the API published and signed at
session create, `KORTIX_CONFIG_RELEASE`: read from the store, no API call) or
`config-release-fetched` (the descriptor route answered),
`config-release-<disk|snapshot|archive|git>`,
`config-release-proven`, `pi-ready`, `initial-prompt-delivered`,
`initial-turn-accepted`, `runtime-ready`. No workspace step is a boot mark;
`/kortix/health` reports the checkout as `workspace_provider`.

A permission rule names a capability (`RUNTIME_PERMISSION_CAPABILITIES` in
`@kortix/api-contract/transcript`: `read`, `edit`, `bash`, `webfetch`, …), not
one harness's tool. Each adapter maps its tools onto them: pi's `write` is
`edit`, its `memory` is `edit` (`read` for the `view` command), and its
`web_search`/`image_search` and `scrape_webpage` follow `websearch` and
`webfetch` (`pi/interactions.ts` `toolCapability`); pi asks for them like any
other tool. A rule under the tool's own name wins over its capability. OpenCode's `pty_*` tools follow `bash`, and the
hosted `web_search`/`image_search` and `scrape_webpage` follow `websearch`
and `webfetch` (`open-code/lifecycle.ts` `capabilityToolRules`). The OpenCode
tools cannot ask, so they run only when the capability is `allow`. A rule is an
action, or a glob-pattern -> action map matched against a `bash` command or a
workspace tool's path. A pattern map is never collapsed to its `*` entry.

**A path rule matches the file, both harnesses.** OpenCode resolves the path
and matches it relative to the worktree. pi resolves it as its file tools do
(`pi/interactions.ts` `toolPath`: `@`, `~`, `file://`, `.`, `..`, absolute)
and matches it relative to the workspace. So `./secrets/a`, `x/../secrets/a`,
`@secrets/a` and `/workspace/secrets/a` all match `secrets/*`. A `read`,
`write`, `edit`, `glob` or `grep` path outside the workspace also answers to
`external_directory`, with the subject `<dir>/*`, and the strictest rule wins.
pi applies `external_directory` only when a rule covers it. Neither harness
resolves symlinks. A path rule does not govern `bash`: `cat secrets/a` is a
`bash` command.

**A bash line is decided command by command, both harnesses.** OpenCode asks
for each command its tree-sitter parse finds. pi splits the line
(`pi/interactions.ts` `bashCommands`) on unquoted `;`, `&`, `|` and newlines,
reads each `$(…)`, backtick, `<(…)`, `>(…)` and `( … )` body as commands of its
own, and the strictest answer wins (`deny`, then `ask`, then `allow`). So
`bash: { '*': deny, 'kortix connectors call x get *': allow }` runs that call
and refuses `kortix connectors call x get a; env`. A line whose quotes or
brackets do not balance is decided as a call with no subject: a restriction
asks.

**Precedence, both harnesses:** the most specific matching rule wins, whatever
order the keys are written in (`@kortix/api-contract/permission-rules`). The
longest pattern is the most specific; equal lengths compare by code unit, the
later one winning. Keys follow the same order (`bash` outranks `*`), and a key
whose map matches nothing falls back to a less specific key. pi resolves this
in `pi/interactions.ts` `resolvePolicyRule`. OpenCode applies the LAST match in
key order, so kortixd writes every block it composes least specific first
(`buildOpencodeConfigContent` step 9), and the `open-code/permission-order.ts`
plugin's `config` hook orders the blocks it did not compose (the project's
`opencode.json[c]`, a config dir's `agents/*.md`). An agent block still
outranks the global block on OpenCode. pi's
request names the capability and the call's subject (`patterns`); an "always"
reply allows the capability for the session, and a `deny` still outranks it.
The reply is `RUNTIME_PERMISSION_REPLIES` (`once`, `always`, `reject`).

### Extensions

pi's own extension system runs every extension. The root `Agent` lives inside
pi-coding-agent's `AgentSession` (`pi/extensions/host.ts`), which owns the
loader, the real `ExtensionRunner`, tool wrapping, `input` and
`before_agent_start` on each prompt, extension commands, and `/skill:` and
prompt-template expansion. A package from https://pi.dev/packages runs
unmodified: Kortix writes no per-extension code. Kortix keeps the model (the
gateway provider is registered with pi's `ModelRuntime` only to pass its auth
check), the tools, the wire, and the permission policy, which runs BEFORE any
extension `tool_call` handler. pi's auto-retry is off: the product owns it
(`pi/transient-retry.ts`). Of pi's built-in extensions Kortix loads only
`codemode` (below); `mcp` and `tool-search` are not loaded.

Three sources, in pi's own scopes:

| Source | Declared in | Installed in |
|---|---|---|
| system (every session) | `<agentDir>/settings.json` `packages`; `agentDir` = `KORTIX_PI_AGENT_DIR`, default `/opt/kortix/pi-agent` | `<agentDir>/npm`, when the image is built |
| project | kortix.yaml `harnesses.pi.packages` → `KORTIX_PI_PACKAGES` | npm sources: built once per package list by the API (apps/api/src/pi-packages, on change-request merge) as a PRE-BUILT bundle — one self-contained, minified ESM file per extension (deps inlined; pi's own modules read `globalThis.__kortixPiHost`) plus the package's own files minus the code that file inlined, type declarations, source maps and the root README/CHANGELOG — and the installed `node_modules` as a fallback. The daemon starts the download with the service (beside the repo clone), unpacks to `<KORTIX_PI_PACKAGES_DIR>/<digest>` (outside the repo) and imports each extension natively: no jiti, no install (`extensions/prebuilt.ts`). A package with no pre-built form, one whose file throws on import, or an entry with its own `extensions` filter loads from the fallback (`KORTIX_PI_PACKAGES_FALLBACK_URL`, fetched only then) through pi's loader |
| repo-local | `<workspace>/.pi/extensions/*.ts`, or a `./` path in `harnesses.pi.packages` (a file is one extension, anywhere in the repo) | the repo itself: a `./` path resolves against the config release root while a release runs, else the working tree (`packageRoot`); a release that changes a file in its folder restarts the runtime (`pi/config-release.ts` `startOnlyFiles`) |

A project entry for the same package overrides the system one. Nothing installs
at boot. pi installs a missing package on load (13.2 s for two packages,
measured), so `installedPackages()` drops an npm source that is not on disk at
its pinned version, refuses repository sources, and reports each drop under
`extensions.failed` in `[pi] runtime ready`. A package's extension loads through
pi's jiti loader. In the compiled daemon, pi supplies `typebox` and the
`@earendil-works/pi-*` peers as virtual modules: a compiled probe loaded a
TypeScript package importing both in 24 ms, and its tool ran.

In-process extensions are `InlineExtension`s (`{ name, factory }`): `subagents`,
the hidden `kortix-turn`, which adds a prompt's `system` field for that turn,
the hidden `kortix-nested-calls` gate and `codemode`.

### codemode

pi-coding-agent's `createCodemodeExtension()` (`pi/codemode.ts`): one tool, `codemode`, whose
input is a JavaScript script that calls the other tools as `await tools.<name>(args)` in a
QuickJS VM (no Node, file system, network or timers; 256 MB). Only the script's output
returns to the model. kortix.yaml `harnesses.pi.codemode` (v3: the agent's `codemode`;
`KORTIX_PI_CODEMODE`, sent by the API at session start; an agent's value replaces the
top-level one; without the variable the session agent's compiled `codemode`) picks `on` (the
default: the other tools stay declared), `only` (requests declare codemode alone) or `off`
(the extension is not loaded). `models` stays off: it would call providers past the LLM gateway.

- **Policy.** A script's calls are nested calls (`ctx.executeTool`, id `<call>/<n>`, events with
  `parentToolCallId`). pi runs them through the extension `tool_call` handlers only, never
  `agent.beforeToolCall`, where the policy sits (`toolGate`). `nestedCallGate`, first in the
  extension list (pi stops at the first block), applies the root rule to every call with a
  parent: `deny` blocks, `ask` attaches to the codemode part. `task` and `question` are refused
  from a script (a subagent thread links to its root `task` call; a question needs its own part).
  A tool the agent's tool access turns off is not callable from a script either (pi offers
  scripts only active tools). A subagent gets only the workspace tools, so no codemode.
- **Transcript.** A nested call is not a part. The codemode part's `metadata.calls` is pi's
  live record (`id`, `name`, `args` as JSON text, `running`/`ok`/`error`/`cancelled`,
  `durationMs`, `error`). The v2 live put fires when a call in it changes status.
- **Session log.** The call is `kind: 'code'`. `result.details` is `{ calls, complete }` from
  pi's bounded `nestedCalls` (256 calls, 8 kB of input each, 32 kB in all, 500-character
  errors, no outputs): display data, never `tool_call` blocks, because the model never saw them.
  `store()` values fold into the root thread's `ext.pi.data.codemode_store`; the restore writes
  both back (`nestedCalls`, one `codemode-store` entry).
- **Build.** The compiled daemon embeds `quickjs-wasi/quickjs.wasm` (`setEmbeddedQuickJSWasmPath`,
  reached by a relative path into pi's `dist/config.js` because pi does not export it) and builds
  `src/extensions/codemode/worker.ts` as a second entrypoint with `--root=.`: in a binary pi starts
  the worker as `./src/extensions/codemode/worker.ts`, resolved against the build root. Both fail
  only on the first script, never at boot: `pi-harness.test.ts` "pi codemode" runs scripts from
  source, and a compiled check is a real session (`RUN-20`). At most 2 script workers run per
  process.
Child sessions have no `AgentSession`; the runtime routes their tool, context and
provider hooks to the same runner. `ctx.ui` has no UI bound (`hasUI` is false):
tools and events work, TUI-only rendering does nothing.

`subagents` is OpenCode's `task` tool: input `{ description, prompt,
subagent_type, task_id? }`, the child id in the part's `metadata.sessionId`
(set while the child runs), output `task_id: <id>` + `<task_result>`. Each call
runs an in-process pi agent in a child session (`parentID` = root), with its
own wire transcript served by `/session`, `/session/:id`,
`/session/:id/message`, `/session/:root/children`, the state document and
`/kortix/runtime/messages/:id`, and persisted in the root's dump so `task_id`
resumes it after a restart. Types: `general` (all workspace and Kortix tools), `explore`
(`bash`/`read`/`glob`/`grep`), and every compiled agent with `mode: subagent`
or `all`; v3 has only the declared agents. The calling agent's
`permission.task` rule (subject: `subagent_type`) removes a denied type from
the list and refuses a call to it. A child gets no `task` (no nesting) and no `question`. Several task
calls in one message run concurrently; a batch that includes any other tool
stays sequential. A child session is read-only (prompts to it answer 501).
A child's calls are checked against the subagent's own rules and the session's
rules; a `deny` from either wins, so delegating never unlocks a denied call.

### Images

- **Prompt images.** apps/api writes every prompt attachment to
  `/workspace/uploads/.kortix-inbox/<command>/` and puts a `<file path="…" mime="…">` tag
  in the prompt text; nothing rides inline in the body (`prompt-attachment-materializer.ts`).
  When the selected model reads images (catalog `attachment: true`), the runtime also hands pi
  each PNG, JPEG, GIF or WebP a tag names inside the inbox, resized by pi
  (`promptImages`, `pi/images.ts`): on a prompt, a steer and a `noReply` message. The tag stays,
  so the agent still has the path. A model without image input gets the tag alone.
  Each path is read once, at most 20 images per prompt, one at a time. A file is read only when
  its real path stays in the inbox (no symlink out), it is a regular file and it is at most
  50 MiB. Steers run on one chain, so they reach pi in arrival order; a retract while a steer
  loads its images cancels it (`retracted`; the steer answers `duplicate`).
- **Session log.** pi records each image as an attachment (P2.13). An image from a tag carries
  `source_path` (the tag's path, matched by order: when pi left out a tag image, none is set).
  A restore writes no v1 file part for it, and the web draws it once, through its tag
  (`normalizeAttachments`).
- **Resize.** pi resizes every image (`read` and prompt images) with photon
  (`@silvia-odwyer/photon-node`), which reads `photon_rs_bg.wasm` from its own `__dirname`.
  A compiled daemon bakes the build machine's path there, so before 2026-10-16 photon never
  loaded on a box and pi dropped every image ("[Image omitted: could not be resized below the
  inline image size limit.]"). `pi/images.ts` embeds the wasm in the binary and redirects that
  one file name to the embedded copy. In a binary pi's resize worker does not load, so pi
  resizes in-process (about 0.65 s for an 18 MB 3000x2000 PNG on an M-series laptop; at most
  20 per prompt). Follow-up: build the worker path pi's `resizeImage` asks for in a binary as a
  second entrypoint, as codemode's worker (`scripts/build.sh`); it must install the wasm redirect itself.
  `pi-images.test.ts` builds a binary against a copy of photon-node, deletes the copy, and runs
  pi's `read` and `promptImages` in it.

### The conversation, compaction and slash commands

pi's `SessionManager` (in memory) is the model context: the agent's messages
are its projection. The state dump stores its entries (`entries`), and a
restart restores them, so a compaction or a context edit survives it. The dump
also keeps `agentMessages` for a daemon built before pi 1.0, which restores
from that field; this daemon reads it only when `entries` is absent.

pi's own compaction is on. It runs on demand (`POST /session/:id/summarize`),
when the context nears the model's window, and when a model request overflows
it or a reply is cut by the length limit (pi then retries that request once;
the failed attempt's error is withheld from the wire and lands on the message
only when the recovery fails). The wire carries it in OpenCode's shape: a user
message whose one part is `compaction` (`auto`, `overflow`), an assistant
message flagged `summary` with the summary text or an error,
`time.compacting` on the session while it runs, and `session.compacted`. The
transcript keeps every message. A project's `settings.json` in the pi config
dir sets `compaction.enabled`, `reserveTokens` and `keepRecentTokens`.
Subagent child sessions have no `AgentSession` and do not compact.

A `/summarize` is a turn of its own, named by its compaction marker (the user
message with the `compaction` part), as on OpenCode: when the compaction that
`compact()` started begins, the runtime relays `turn_begin` with the marker id,
and when it ends, the turn end with the same id (`onTurnBegin`/`onTurnEnd`).
The boot relays the end after the begin settled, or after 5 s
(`turnEndAfterBegin`). apps/api binds the id to the open `/summarize` turn and
marks that turn durable (`log_durable_at`) when the log acknowledges the
compaction record, whose `message_id` is the marker id (`markDurableTurns`,
apps/api `session-log-ingest.ts`). A failure (the summary's model call) ends
the turn `error` with pi's reason; a stop ends it `idle`. pi's two refusals
end it `idle` too, because nothing changed: `Compaction failed: Nothing to
compact (session too small)` (pi keeps the last `keepRecentTokens`) and
`Compaction failed: Already compacted` (nothing after the last compaction).
pi gives no code for them, so the runtime matches these exact strings
(`PI_COMPACTION_REFUSALS`; the pi-harness tests fail when a pi bump rewords
them). The summary message on the wire carries the refusal as its error, and
the daemon logs `[pi] compaction failed`; the session log has no record (pi
stores no entry). A Stop drops a `/summarize` still queued behind the running
turn: no model call, no turn relay. An auto compaction (threshold, overflow)
runs inside its prompt turn, and an extension's `ctx.compact()` is not a
`/summarize`: neither relays a turn.

Reasoning is display only across models (C3, P7.3). pi-ai replays a thinking
block that another model wrote as visible assistant text. `pi/reasoning.ts`
removes the thinking of another model from each request, with pi-ai's own test
(provider, api, model id): `withoutForeignReasoning` wraps the stream function
of the root and every child agent. pi's summarizers (compaction, branch
summary) send no thinking block of any model since pi 1.2.0
(`serializeConversation`); `pi-session-log-restore.test.ts` fails if that
changes. A model switch (a prompt's
`model`, `POST /kortix/env`) and a restored log written by another model or
harness both go through it. The same model's thinking goes back unchanged, and
the store and the session log keep every block.
`PI_CAPABILITIES.native.reasoning_replay` is `same_model` (OpenCode: `lowers_to_text`), so the
switch preflight lists another model's in-context reasoning as a `lost` line on a
switch from OpenCode to pi (OpenCode showed it as text). modelView compares
provider and model only, so the restore gives a `kortix` message without `api`
(a v1 or OpenCode-converted log) the gateway dialect `openai-completions`;
pi-ai then sees the same model and keeps its reasoning.

`GET /command` lists pi's prompt templates (`prompts/*.md` in the pi config
dir, and the templates of pi packages) as slash commands. A v3 session lists
its compiled commands instead (see "kortix.yaml v3").
`POST /session/:id/command` runs one: it admits `/name arguments`, pi expands
the template, and the user message on the wire becomes the expanded text, as
on OpenCode. A command pi does not have is a 400. pi does not read OpenCode's
`commands/` directory.

Not supported by pi today (answered honestly, never silently): session rewind
(`/session/:id/revert`, 501 `feature_not_supported`), MCP/connector tools, todo
tools, warm-seed capture, `ctx.ui` prompts from extensions. `/kortix/health` reports `harness: 'pi'`
and keeps `opencode: <state>` as the compatibility field the control plane
already reads for readiness.

## Hosted tools

A tool that is not a harness's own (`bash`, `read`, …) is written once, as a
harness-neutral module, and the daemon runs it for whichever harness the box
runs (`../services/tools/`):

| Module | What |
| --- | --- |
| `services/tools/tool.ts` | The contract: a default export `{ description, parameters (JSON Schema), execute(args, context) }`, with `context` = `{ sessionId, agent, directory, env, signal }`. |
| `services/tools/kortix/<name>.ts` | The Kortix tools, one self-contained module each: `web_search` (Tavily), `image_search` (Serper), `scrape_webpage` (Firecrawl), `memory`, `show`. Each follows the project tool contract and imports only `node:*`, so `kortix tools eject <name>` copies the file into a project unchanged (the CLI embeds the same bytes, `apps/cli/src/kortix-tools.generated.json`). The web tools read `KORTIX_API_URL` and `KORTIX_TOKEN` from `context.env` and call the API's billed router proxy (`/v1/router/{tavily,serper,firecrawl}`); a box with no control plane calls the upstream with the project's own key. |
| `services/tools/platform/<name>.ts` | The platform tools, `PLATFORM_TOOLS` in `host.ts`: `remember` (memory pages, `project_channels`). They load in every channel or DM thread (`KORTIX_SPACE_ID` in the session env) whatever `kortix_tools` lists. kortix.yaml cannot list or eject them. A project tool of the same name replaces one in that project, with one warning in the log. An agent's tool access keeps them under an allowlist and removes one only by name (`remember: false`, `hostedToolAllowed`). On pi `remember` is an `edit`: `edit: deny` hides it and refuses a call. `remember` posts to `POST /v1/projects/:id/memory/remember` with `KORTIX_TOKEN`, returns the API's JSON, and answers a 4xx as `Error: <code>: <message>`. |
| `services/tools/memory-copy.ts` | `syncMemoryCopy(layers, env)`: the read-only memory copy at `MEMORY_COPY_DIR` (`/opt/kortix/memory/{company,channel,personal}/`). `.version` holds the layer version and a SHA-256 of every other file in the folder. A layer whose version differs, or whose files no longer match (the agent runs as the daemon's user and can unlock and edit them), is fetched from `GET /v1/projects/:id/memory/layers/:layerId/export` (3 s cap, the wait for an earlier sync of the folder included; 4 MiB, 250 pages at most). The folder is written whole beside it (files `0444`, folders `0555`) and renamed in; a link or a file in its place is removed, never followed. A page with an unsafe or repeated file name is skipped and logged; a failure keeps the old copy. `POST /kortix/runtime/sessions/:id/prompt` runs it for the body's `memory_layers` (each folder once) before the turn, both harnesses, and a later prompt of the session waits for it; `remember` runs it for the layer it wrote. |
| `services/tools/host.ts` | `loadTools(root, compiled, env)`: the Kortix tools `CompiledAgentSet.kortix_tools` lists (all five when it is absent: no kortix.yaml `tools` key, or a config compiled before the key existed), then the project's (`project_tools`), imported from `root` (the working tree or the config release; on OpenCode, the release the boot link serves, recorded as `<boot config root>/boot-release`, so a release with no OpenCode config dir still loads its tools). A project tool replaces a Kortix tool of its name; a module that does not load is logged and skipped. `runTool` bounds the output (over 50 KB or 2000 lines: the whole text to a temp file, the head to the model). `sessionEnv` is `context.env`: the process env with the live agent env file over it. |
| `routes/kortix/tools.ts` | `POST /kortix/tools/:name` for an out-of-process harness: the box's tool-bridge key (`toolBridgeKey`, kept in the runtime state dir) or the control credential; `403` when the agent's tool access refuses the tool. |

- **pi** loads them at `start()` and registers each as an `AgentTool`
  (`pi/tools.ts` `createWorkspaceTools`); subagents get them too. A release
  that changes a project tool's declaration or a file in its module's folder
  restarts the runtime in place (`pi/config-release.ts` `startOnlyFiles`).
- **OpenCode** gets a plugin the daemon writes on every config compose
  (`open-code/tool-bridge.ts`, `~/.config/kortix-tools.js` and its tool list
  `kortix-tools.json`). Each tool is a stub that posts to the route above. Its
  `args` are the JSON Schema properties (OpenCode's non-Zod plugin path) and
  its `tool.definition` hook restores the exact schema, so optional arguments
  stay optional. A name the served config dir defines in its own `tools/`
  (the copies the template wrote before) keeps the project file.

**Tool access.** `CompiledAgent.tools` (kortix.yaml `agents.<name>.tools`) maps
a tool name to visible, with `*` for every tool not named; `toolAllowed`
(`@kortix/api-contract/runtime-relay`) reads it; kortixd reads it through
`hostedToolAllowed`, which keeps a loaded platform tool under an allowlist. pi filters the active tools
and denies a call to a hidden one, for the root and for a subagent (both
agents' maps must allow it). OpenCode reads the map as permission rules
(`open-code/tool-access.ts`): a removed tool is a `deny` after every other
rule, an allowlist is `*: deny` first, then the rules of the allowed tools at
the action they had; the compiled `tools` key is dropped, because OpenCode's
own reading turns `true` into `allow` and lets the agent's `permission`
re-open a removed tool. OpenCode is sunset, so its allowlist rules do not
keep the platform tools: an allowlist agent on an OpenCode box has no
`remember`.

## The workspace and config providers are host services, not harness logic

`src/services/workspace-provider/` (the `git` / `prefer-s3` / `require-s3`
project acquisition, #7221) and `src/services/config-provider/` (the config
release a boot needs) stay outside `src/harness/`. Each depends only on
`src/lib/` and knows nothing about any harness or about the other: both read
the S3 project snapshot through `src/lib/project-snapshot/`, each into its
own directory, in parallel. The config provider never reads `/workspace`
(`obtainRelease`: disk, snapshot, archive, git; the archive first from the
published release's signed store URL). The harness composes them. Both
`open-code/boot.ts` and `pi/boot.ts` call `provideWorkspace(cfg, { onSummary })`
at the point where the cold boot acquires the workspace. OpenCode still waits
for the checkout before its proof, because an OpenCode Instance is built per
directory; pi does not. The warm-seed adoption and monitor mode call the same
function in `git` mode. `contract/boot-state.ts` carries the outcome:
`workspaceProvider` (reported in `/kortix/health` as `workspace_provider`)
and `deferredHistoryBackfill` (`backfillAfterHydration` for an S3 start).

## kortix.yaml v3 on OpenCode

A v3 project's compiled set (`KORTIX_COMPILED_AGENT_CONFIG` with `schema: 3`)
is the only input. `open-code/manifest-v3.ts` turns it into OpenCode config.
v1 and v2 sets keep the behavior above.

- **No project config dir.** OpenCode reads the image default config dir.
  `resolveOpencodeConfigDir` ignores `opencode.config_dir`,
  `harnesses/opencode` and `.kortix/opencode`. `manifestFromDescriptor`
  sets a v3 release's `config_dir` to null, so the release serves the image
  default and is proven there. The boot release link still names the
  release: the config root is the release root, else `/workspace`.
- **No discovery.** OpenCode spawns with `OPENCODE_DISABLE_PROJECT_CONFIG=1`
  (no `opencode.json(c)` or `.opencode/` upward from the working directory)
  and `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` (no `.claude/skills` or
  `.agents/skills`). A change between v2 and v3 respawns OpenCode instead of
  disposing it, because these values ride the process env.
- **Skills.** `skills.paths` is each registered folder (`compiled.skills`,
  under the config root) plus the managed Kortix skills. OpenCode scans
  `**/SKILL.md` under a path, the folder itself included, so a folder loads
  its own skill and nothing beside it. The root `skills/` is not declared.
  The compiled `permission.skill` allowlist decides which agent sees which
  skill.
- **Extensions.** The session agent is `KORTIX_AGENT_NAME`, else
  `default_agent`. Each name in its `extensions` with an `opencode` path
  becomes a plugin. A missing file is logged and skipped. A mid-session
  agent switch keeps the plugins of the boot agent.
- **Extension dependencies.** A module with no `package.json` between it and
  the config root loads as `file://<config root>/<path>`. Otherwise the
  nearest such folder is copied to
  `<runtime state dir>/opencode/extensions/<content hash>/` and the plugin
  loads from there (`open-code/extension-deps.ts`). Its `node_modules` is a
  link to the baked tree (`/opt/kortix/opencode-config-deps`) when every
  declared dependency is there at a version the declared range accepts, else
  an `ensureOpencodeConfigDeps` install (offline, then the declared ranges,
  then the registry). The working tree and a sealed release never get a
  `node_modules`. An unchanged folder reuses its copy. A failed install
  skips that plugin and the boot goes on. The starter's pty extension pins
  `zod 4.1.8`; the baked tree's top-level `zod` is 3.x, so it installs.
- **Commands.** `compiled.commands` becomes OpenCode `command`
  (`template`, `description`). `GET /command` (proxy) and the `commands`
  section of `/kortix/runtime/state` list only the compiled commands, each
  with `agents`. OpenCode's own `init` and `review`, MCP prompts and skills
  are not listed. `POST /session/:id/command` for an agent the command does
  not list answers `403 { error: "command_not_enabled", command, agent }`.
  The agent is the body's `agent`, else the session agent.
- **Kortix-only keys.** `schema`, `skills`, `commands`, `extensions` and the
  per-agent `extensions` and `codemode` are removed before OpenCode reads the
  config. `OPENCODE_CONFIG_CONTENT` from the environment is not merged.
- **Built-in agents.** The API sends `build`, `plan`, `general` and `explore`
  as `{ disable: true }` unless the manifest declares them. OpenCode deletes
  a disabled agent, so the `task` tool cannot start one.
- **Session notice.** The config-release notice names `kortix.yaml` as the
  file to edit.

## OpenCode instance guard

OpenCode builds its per-directory services on first use and caches the result
forever, including an interrupted build. A Stop during the first turn of a
fresh instance can therefore break every later turn on the box.
`open-code/instance-guard.ts` prevents that in 3 steps:

1. **Warm.** The daemon requests `/experimental/tool/ids`, `/agent`, `/skill`,
   `/config/providers` and `/mcp` when the event stream connects and after
   every instance dispose. Loop-starting requests through the proxy wait for
   this warm-up, for 20 s at most.
2. **Heal.** After any aborted turn the daemon probes the same endpoints. Two
   503 answers in a row trigger `POST /instance/dispose` and a new warm-up.
3. **Recover.** A root turn that aborted before any output, with no stop
   request recorded, is a victim. The daemon disposes the instance, then
   re-prompts once through `turn-auto-resume.ts`. When that is not possible,
   the turn end carries the cause `RuntimeAbortedTurn`.

Every daemon path that aborts an OpenCode turn calls
`noteOpencodeStopRequested` first. A new abort path must do the same, or its
stops read as victims.

## OpenCode orphans (P2.9)

OpenCode runs in its own process group, so a daemon that dies without its
shutdown path (SIGKILL, the OOM killer, a panic) leaves it running on its
port. The supervisor relaunches the daemon, and before the new lifecycle's
first spawn `reapOrphanedOpencode` (`open-code/lifecycle.ts`) SIGKILLs the
process group of every `… serve --port <internal|standby> --hostname
127.0.0.1` that is not this daemon's child, its group, or a group its child
leads, then waits (bind check, 5 s at most) for both ports. A `ps` that does
not answer in 2 s is killed and the check is skipped (fail open), so a stuck
`/proc` read cannot stall the boot. It runs once per lifecycle, so it never sees an
OpenCode the current daemon owns. Each kill logs `[opencode] killing an
OpenCode a previous daemon left on its port` with the group and its
arguments. pi has no child process and needs none of this. Test:
`opencode-lifecycle.e2e.test.ts` ("a daemon killed with SIGKILL").

## Native features remain available

The common interface is not a feature limit. Host controllers register every
existing route and invoke named resolved operations. The compatibility proxy
port preserves catch-all forwarding: for OpenCode that is a real upstream
process, for pi an in-process dispatcher — either way a native feature without a
common method still reaches the harness. OpenCode-specific configuration,
events and full lifecycle operations stay typed inside `open-code/`; pi's stay
inside `pi/`. No silent feature fallback or harness switching is added.

`createService` does not spawn a process or subscribe to events. Controllers
receive the resolved service through dependency injection; `/kortix/runtime/*`
(and its pre-W3 alias `/kortix/opencode/*`) is a URL, not an implementation selector. The adapter cannot
register routes or receive a Hono context.

## Unchanged contracts

- Project folders, native config locations and configuration precedence.
- Environment variable names, defaults and loaded values (pi adds `KORTIX_PI_*`).
- Routes, response/event payloads, diagnostics and durable state filenames.
- Readiness gates, timeout policy and update ordering.
- SDK/UI behavior, Docker images and sandbox image selection.
