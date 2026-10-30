# Internal harness boundary

`harness.ts` is the only module that imports a concrete adapter. It resolves
the implementation and exposes a definition for configuration, boot, and service
creation. The import rules are in [ARCHITECTURE.md](../../ARCHITECTURE.md). One adapter is registered:
`pi`. An unknown id fails the boot.

```ts
const cfg = loadConfig()                 // reads KORTIX_HARNESS, then pi's env
const selected = resolveHarness(cfg)     // piDefinition
const runtime = selected.createService(cfg, projectEnv)
await runtime.lifecycle.start()
```

## OpenCode is deleted

Since 2026-10-23 every new box runs pi. Since 2026-10-30 kortixd has no
OpenCode adapter: `open-code/` is deleted. A box that OpenCode booted before
the sunset can still wake: its env says `KORTIX_HARNESS=opencode`, or nothing
on a box from before pi existed. It installs each new daemon build
(runtime-assets stages it, the entrypoint supervisor installs it at the next
start). On that box:

- `resolveHarness` maps `opencode` and an unset id to pi. The box boots pi.
- `loadConfig` sets `KORTIX_SESSION_LOG_RESTORE=1`, because apps/api never set
  it on that box. pi starts on an empty store, so the boot reconcile reads the
  store as behind and restores the session log into pi ("When the boot
  restores" below). The journal then appends pi to `harness.history`
  ("Harness history, a switch" below).
- `harnessProtectedPathSegments()` still refuses `/.local/share/opencode/`
  (OpenCode's session database and auth stay on that box), and
  `isHarnessInternalVariable` still treats `OPENCODE_*` as internal, so the
  agent env file never writes them.

The runtime wire pi emits (`kortix.transcript.v1`) keeps OpenCode 1.18's
field names. Those are wire names, not OpenCode code. The E18 lint rule
([ARCHITECTURE.md](../../ARCHITECTURE.md)) rejects any new OpenCode name.
Build new behavior in `pi/` or `shared/`, behind a capability
(`RUNTIME_CAPABILITIES`), never behind a harness check.

## Selection

`KORTIX_HARNESS` is set by apps/api at provisioning (`buildSessionRuntimeEnv`):
always `pi`. `pi`, `opencode` and an unset value select pi; any other value
fails the boot. Images built after 2026-10-30 carry no OpenCode binary, its
config deps or its config dir. `loadConfig` reads the id BEFORE pi loads its
own environment. There is no per-request switching: one box, one harness, for
the life of the box. A new box of a session that OpenCode ran boots pi. With
`session_log_restore` on, that box restores the log into pi and records the
switch in `harness.history` ("Harness history, a switch" below). A box that
OpenCode booted always restores ("OpenCode is deleted" above).
`POST /v1/projects/:p/sessions/:s/log/switch-preflight` (apps/api) answers
before that happens: whether the switch can happen (`available`, `reason`:
`same_harness`), whether the new box restores the
log (`restores`; off, `losses` starts with `history`), what the session uses
that the target handles worse (`losses`) and everything the target lacks, used
or not (`unsupported`). The contract is `switchPreflight` in
`@kortix/api-contract/session-log` (`capabilities.ts`).

## Models: the LLM gateway only

pi sends every model request to the Kortix LLM gateway, under one provider
id, `kortix`. There is no native provider mode, and every model ref is
`kortix/<wire id>`.

- A box without the gateway env (`KORTIX_LLM_BASE_URL` + `KORTIX_TOKEN`, or
  `KORTIX_LLM_PROXY_URL`) never falls back to provider keys in the process env.
  pi throws at model setup (`createPiModels`, `pi/model.ts`), and health
  reports pi `down` with the reason in `harness.error`.
- `POST /kortix/env` with `llmGatewayEnabled: true` sets `KORTIX_LLM_BASE_URL`
  and re-points a running LLM proxy. `llmGatewayEnabled: false` (an API from
  before the graduation) is logged and ignored: it never clears the gateway env.

## Ownership

| Location | Responsibility |
| --- | --- |
| `harness.ts` | Resolution, `loadConfig`, the boot context, and the protected paths and internal variables every box uses |
| `contract/` | Named host-facing operation contracts (`control`, `diagnostics`, `queries`, `proxy`, `lifecycle-contract`, `boot-state`, `server`, `session-log`); no router dependencies |
| `shared/` | Steps that are not pi-specific: agent env file, `on_boot`, attachment stripping, the host facts of `/kortix/health` (`host-health.ts`), and every daemon-to-API callback (see below) |
| `../services/runtime-assets/port.ts` | Harness maintenance contract, owned by the service that consumes it |
| `pi/service.ts` | Composition; loads pi's packages lazily |
| `pi/runtime.ts` | The in-process pi `Agent`: model, tools, skills, the root `AGENTS.md`, today's date (each turn), turns, transcript, durability |
| `pi/boot.ts` | Session boot: the host steps (workspace, config release, relays), then `pi-ready` |
| `pi/surface.ts` | The raw routes of the runtime wire, answered in-process |
| `pi/vcs.ts` | The Changes tab on pi: `vcs: 'git'` on `/project/current` and `GET /vcs/diff` (`mode=branch` against the merge base with `KORTIX_DEFAULT_BRANCH`, `mode=git` against HEAD), the wire's `VcsFileDiff` shape |
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

The API accepts the pre-W3
spellings (`opencode_session_id`, kind `opencode_session`) from older daemons.

## Session log (P2.4, P2.5, P4.3, P4.3b, P6.2, P6.4, P6.5)

An adapter implements `SessionLogPort` (`contract/session-log.ts`):
`changes(cursors)` returns the messages, tombstones, thread upserts and session
patch since one `ExportCursor` per thread; `restore(log)` writes a session log
into the native store before the harness starts and returns the cursors of what
it wrote and the counts of model-visible content it could not write
(`SessionLogRestoreResult`); `held()` names every message id the native store holds for the
boot reconcile, or null when the store is missing;
`live(threadId, messageId)` names the seq (and pi's `created_at`) of a message
of the live turn (see "The live turn" below); `blob(sha256)` returns the bytes
behind an attachment the last `changes` exported as `ref: blob:<sha256>`;
`capabilities` is the adapter's `AdapterCapabilities`. pi implements it
(`pi/session-log.ts`, P2.5). It rebuilds the whole log on each read and diffs it
against the cursors with `logChanges` (`shared/session-log-journal.ts`).

Attachment bytes (P2.13). The export writes an image or file (a prompt's, or
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
`kortix-attachment://` ref either answer carries replaces `blob:` in the record: a record
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

### Restore (P6.2)

The boot runs these steps when the native store is behind the log (P6.4, "When the
boot restores" below):

1. `POST …/log/restore` (P6.1) answers `SessionLogRestore` `{ generation, log, revs, seq_max, blobs }`,
   or 413 `session_log_too_large` with the part that fits for a log over the API's cap (see "Memory" below).
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
3. `port.restore(log, seq_max)` before the runtime starts:
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
4. `startSessionLogJournal(port, { generation, cursors })`: the export skips
   every restored message by hash (C13).

### When the boot restores (P6.4)

`reconcileSessionLog(port)` (`shared/session-log-boot.ts`) decides, restores, and
returns what the journal starts with (`{ generation, cursors, session }`). pi
runs it beside the workspace checkout (pi's dump needs no `/workspace`) and
awaits it before `lifecycle.start()`; the runtime adopts the root the dump names
at start, so a service built before the restore runs under the log's root. No
turn runs at that point.

- **The flag.** apps/api sets `KORTIX_SESSION_LOG_RESTORE=1` when the hidden
  project flag `session_log_restore` is on (every provisioning path:
  `buildSessionSandboxEnvVars`). Off: no manifest read, no restore; the box
  keeps its native state and journals at its persisted generation (0 when it
  never restored). The env is built when a box is provisioned, so a change of
  the flag reaches the next new box of a session; a box that is already running
  (or resumed in place) keeps the value it booted with. `loadConfig` also sets
  it on a box that OpenCode booted ("OpenCode is deleted" above).
- **Behind.** `GET …/log/manifest` lists every stored message id (`deleted` for
  a tombstone) and the session generation. The store is behind when the log
  holds a live message and: `held()` is null (no store), or the manifest
  generation is above the one this box persisted (another box claimed the
  session), or a live id is neither held nor one the last restore left
  unwritten (a `context` record pi rebuilds).
- **Flag off after state loss (as before P6.4).** A box whose native store is
  gone starts empty: the agent does not know the history. Its first turn's
  journal batch reuses seqs the log holds and gets 422 `seq_conflict` with the
  thread's `seq_max`. The journal then numbers that thread above `seq_max`
  (native seq + `seq_max + 1`, on the dirty set and on the live stream) and
  sends the batch again, so the session log keeps the old history and the new
  turns after it. The offsets persist in `session-log-restore.json` for a
  restarted daemon; a restore writes the store at the log's seqs and clears
  them. This path runs only where `session_log_restore` is off: a project
  that stores `false`, or a deployment that sets
  `SESSION_LOG_RESTORE_DEFAULT_ENABLED=false` (the default is on since
  2026-10-28).
- **Unsent work never reads as behind.** Only ids are compared, one way: a
  message the store holds that the log lacks (a turn not yet journaled) and a
  newer version of a stored message leave the store current.
  Content hashes are not compared: a store with unsent edits differs from the
  log by design, and the journal sends the difference.
- **The restore.** The claim, then the texts and the attachment bytes read at
  the same time (each with its own 60 s budget), then `port.restore(log,
  seq_max, read)`. After the write, `$KORTIX_RUNTIME_STATE_DIR/session-log-restore.json`
  keeps the claimed generation, the ids the write left out, and the D3 notice:
  a crash before it reads as behind at the next boot, and a daemon restart
  journals at the claimed generation. A 404 (no stored log) or 503 (operator
  switch off) claims nothing and restores nothing. A 413 `session_log_too_large`
  claimed and carries the part of the log that fits: see "Memory" below. Any other failure (5xx,
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
  sends it as the store holds it: it is in modelView of the log. pi's store
  keeps no origin, so the export gives a user message with a
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
- **Harness history, a switch (P7.1).** The adapter exports a one-entry
  `harness.history` (pi). A restore keeps the log's history
  (`HarnessCarry` in `session-log-restore.json`: the history, the first root
  seq after the restore, the restore time), and the journal sends it in place
  of the adapter's (`carryHarness`), at every boot. When this box's harness is
  another than the last entry's (a session whose log says `opencode` boots on
  pi, a box that OpenCode booted included), the journal appends
  `{ harness, version, from_seq, at }`; P5.6 draws the
  switch before the turn at `from_seq`. A new version of the same harness adds
  no entry. A log without a history (a converted log) starts with the harness
  its `harness.current` names. Limit: a box that never restored (flag off)
  sends its adapter's one-entry history, which replaces the stored one.
- **Memory, and the cap.** A restore holds the whole log in memory on the box
  and in the API. Measured on a real Platinum box (pi, 2 vCPU, 3.9 GB, Bun 1.4.3) with a
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
  happens and the answer is 413 `SessionLogRestoreTooLarge` with the part of
  the log that fits (`kept`), every rev, `seq_max`, the blobs of that part,
  `messages` (the count left out), `bytes` and `limit`. The model never sees
  the whole log: `modelViewSliceIds` (`@kortix/api-contract/session-log`) is
  what it sees of a thread (the in-context turns, or after the last in-context
  compaction its marker, cut point and kept run and the turns after it) plus
  the last context record. The API reads light columns, the record sizes and
  each thread's last compaction, sizes the slice at the same rule, and answers
  `kept: 'model_view'`: the root's slice, then each sub-agent thread's slice,
  newest first, whole or not at all. The box writes it as sent and adds no
  note: the model's context is unchanged (the oracle tests
  `session-log-restore-slice.test.ts` in api-contract, and
  `pi-session-log-restore-slice.test.ts` here). A root slice over the cap alone
  gives `kept: 'newest'`: the root's newest in-context turns that fit, from a
  user turn, without the summary; the box writes them with a D3 note that
  names the left-out count. When not even the newest turn fits, the answer has
  no `kept` and no message: the box writes the log's root with the D3 note
  alone (above `seq_max`, so new messages number above every stored seq) and
  keeps no other thread. Every 413 persists every stored id (`revs`) the write
  left out as unwritten, so later boots do not read the store as behind, and
  the box journals at the claimed generation. The status stays 413: a kortixd
  before `kept` drops the messages and writes the note alone, as before (with
  a 200 it would mark only the part as written and claim again at every boot).
  `newest` and the note alone carry `restore_grade: 'partial'` and
  `dropped: { message: <count> }`, which P5.6 shows as "Missing: N earlier
  messages". The stored history stays in the transcript. The same 38.5 MB log
  over the cap without any message answered: the daemon peaked at 135 MB
  (+29 MB) and the API rose by about 21 MB; the 30 MB of images over the cap:
  128 MB and about 2 MB. The switch preflight (`POST …/log/switch-preflight`)
  reports `restores: false` and a `history` loss only when the model view is
  over the cap too. A 413 with another body (a proxy) claimed nothing and
  restores nothing, as a 404.
  ponytail: `newest` drops the compaction summary; keeping it needs a
  synthesized `layout` compaction, add it when the prod data shows the
  fallback is common.

Default-on: the cap above bounds what one restore makes the box hold (live
records plus 2/5 of live blobs, 24 MiB by default). It does not bound the native
store a box already holds: a box with a large store loads it at boot (`held()`)
before any restore. A fresh box drops only an attachment whose record still
says `blob:` (P2.13 uploads the bytes). Precondition for prod default-on: a
release whose kortixd handles the 413 (an older kortixd boots without the
restore and its journal stops at 409). `session_log_restore` is on for every
project without a stored value: dev since 2026-10-15, every deployment since
2026-10-28 (`SESSION_LOG_RESTORE_DEFAULT_ENABLED` defaults to true).

Known limits of the boot reconcile:
- Losing `session-log-restore.json` after a restore reads as behind (the
  persisted generation falls to 0), and the next boot restores over any work
  the journal had not sent. In practice the state file and pi's dump share the
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

Known limits of the pi restore:
- An image whose record still says `ref: blob:<sha256>` (its upload failed, it is over 50 MiB, or it was journaled before P2.13 and its box never booted on a new daemon) cannot be restored in a fresh box: `apiBytesReader` reads only a `kortix-attachment://` object. It counts in `dropped.attachment`.
- A call input that is not an object or a string (a converted row that lost it) goes out as `{}` and counts in `dropped.tool_input`.
- A `layout` compaction is rendered as entries after hiding the history; a native pi compaction before it cannot be hidden and keeps its summary first.

Known limits of the pi export:
- A dump written before P2.5 has no header; pi makes a fresh one on load, so `created_at` is the restart time for a session that spans the upgrade.
- The journal does not start on a box with `repoMaterializationError` (the boot returns before it): turns run through the proxy on such a box are not journaled.

### Bumping a harness (P6.5)

pi declares in its capabilities what its oracle suites passed against:
`PI_CAPABILITIES` (`@kortix/api-contract/session-log`, `capabilities.ts`:
apps/api reads the same manifest for the switch preflight,
`POST /v1/projects/:p/sessions/:s/log/switch-preflight`), field `harness_versions` (a semver range, today
`1.0.3 || 1.2.0 || 1.4.0`) and field `schema_minors` (today `[1]`). Both are written
by hand, never derived from the pin. `session-log-adapter-versions.test.ts`
reads them and fails when a pin leaves them:

- pi: the four `@earendil-works/pi-*` deps in `package.json` (the daemon bundles
  them) and `PI_HARNESS_VERSION` (`pi/version.ts`). `@earendil-works/pi-codemode` and
  `quickjs-wasi` are pinned beside them at the versions pi-coding-agent depends on (codemode's
  worker and wasm, above): move them with the bump, and check that pi still resolves the
  worker as `./src/extensions/codemode/worker.ts` (`getCodemodeWorkerSpecifier`).
  `@silvia-odwyer/photon-node` (pi's image resizer, "Images" below) is pinned the same way;
  pi's `resizeImage` must still start its worker as `./src/utils/image-resize-worker.ts`
  (`pi-images.test.ts` fails when it does not).
  `pi-host-modules.test.ts` fails when pi's `VIRTUAL_MODULES` gains a module: add it to
  `PI_HOST_MODULES` (apps/api `pi-packages/prebuild.ts`) and to `hostModules()` (`pi/extensions/prebuilt.ts`).
  It also fails when pi moves its `typebox` pin: move the daemon's `typebox` with it. A
  different version puts three more TypeBox copies in the binary (pi 1.4.0, compiled
  darwin-arm64: +1,328 modules, +1.0 MB, boot +20 ms, RSS +11 MB).
- The schema: `SESSION_LOG_MINOR` in `@kortix/api-contract/session-log`.

To bump a harness or the minor:

1. Change the pin: the four deps and `PI_HARNESS_VERSION`, then
   `pnpm install`.
2. Run the oracle suites: `bun run test session-log` in this app (7 files):
   pi's export and restore against the real runtime and the mock LLM
   (`helpers/fake-model.ts`, dummy key, isolated home), the golden and recorded
   logs, the boot, the journal, the guard.
3. Fix the adapter until they pass. Then add the version to
   `harness_versions` (`1.2.0 || 1.4.0` while boxes on the old pin still run)
   or the minor to `schema_minors`.

The suites run in the `packages` lane (`tests/bin/package-quality.ts` runs
`pnpm --filter kortixd test`) and in the diff-scoped `pnpm test` when this app,
`packages/shared` or `packages/api-contract` changes. The negative control
proves the oracle can fail: pi's partial-log test expects exactly the one
difference the restore dropped. A broken mapping fails the suites: dropping
pi's reasoning fails 1 of 22 pi restore tests, and writing an assistant `text`
in place of its `model_text` fails 1 test. pi exports no assistant
`model_text`, so that test sets one on a golden reply.

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
| `log.status` | `{ thread_id, status: idle\|busy\|retry\|compacting, retry? }` | each time a thread starts or ends work, waits to retry, or compacts; never stored |
| any kept v1 type | the v1 payload, unchanged | for each such frame on the v1 bus |

The journal publishes the first three in `collectOnce`, from the same records
it posts (same ids, seqs and revs), in that order. It collects when it starts
(the store is at rest: the stream gets the session and its threads before the
first turn streams), at each turn end, when pi stores a compaction between
turns, at the daemon stop, and on pi at most 5 s after each `message.*` frame
of a turn (below). The delta frames
come from the v1 bus: pi streams text with the v1 session, message and part
ids, which are the thread, message and block ids of the records.

#### The live turn (P4.3b)

A put with `status: 'streaming'` precedes the first delta of a message; a
later put with a higher `rev` replaces it. The client keeps the highest `rev`
of each message, appends each delta to the block it names, and lets the next
put replace the whole record.

The journal folds the v1 frames of each message it has not collected. It
publishes a live put of a message on the v2 bus only, never into the dirty
set: apps/api receives only the records a collection exports from the native
store (its `log_durable_at` reacts to a non-streaming assistant message or
compaction). A live put is published:
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
`thread_id`, `seq` and `created_at` of the turn end's record. pi appends a
message's entry at its `message_end`, after the reply has streamed. pi's own
listener appends every earlier entry before the runtime sees the next event, so
the reply pi streams gets the next entry: `getEntries().length + 1` (a
sub-agent child: its `nextSeq`), with pi's own timestamp as `created_at`. An
extension that appends a non-message entry while the reply streams moves the
reply one entry later; its turn-end put then carries the higher seq and
replaces the live ones. A prompt has no seq until pi appends its entry when its
turn starts: its put goes out with the first assistant `message.updated` of
that turn, not at accept.

The collection's put of a message has a higher rev than its live puts, and a
message the journal has collected gets no live put again (except a streaming
record of a mid-turn collection, below).

#### Mid-turn collection

A box can die mid-turn (the provider deletes it, the daemon crashes). Before
2026-10-28 the journal collected only at turn end, so such a box lost the whole
turn from the session log, the prompt included. On pi (`midTurnMs`,
`JOURNAL_MID_TURN_MS` = 5 s, set in `pi/boot.ts`), each `message.*` frame on
the v1 bus schedules one collection and send at most 5 s later. So within 5 s
apps/api holds what pi stored of the turn:
- the prompt: pi appends its entry when the turn starts;
- each finished step, with its call results: a `complete` record, and the first
  one marks the turn `log_durable_at`;
- the step whose calls run: pi exports it `streaming`, calls `running`, no
  `completed_at`. This record goes to apps/api only: the journal marks its
  cursor hash `~`, publishes no `log.message`, and its live puts go on, so the
  stream keeps their v1 metadata (a running task's `sessionId`). A later record
  has a higher rev and replaces it. A box that dies leaves it `streaming`, as
  the stop path always did. A restore hands pi the open calls, and pi-ai sends
  "No result provided" for each. The record stays `streaming` in the log until
  the restored box's next turn: once pi appends that turn's reply, the step
  exports closed (C2: the call `error`, a synthetic "No result provided"
  result) and its record is replaced.

The reply pi streams has no entry before its `message_end` and is not sent: its
text lives on the stream only. An idle session has no frames and sends nothing.
A collection that finds nothing changed sends nothing.

A live message pi removes before the journal collects it (a retracted queued
prompt) leaves no ghost: on
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
rest in order, in gzipped batches of at most 1 MB and 8 MB raw, each message
with a `rev` that is monotonic across boots (`max(Date.now() * 1000, last +
1)`), and keeps them dirty until apps/api acknowledges `(message_id, rev)`. One
message over the route's cap (2 MB gzipped, 16 MB raw) goes alone, with its
longest strings cut to their first 16 kB and `JOURNAL_TRUNCATION_MARK`,
longest first, until it fits; the native store keeps the whole message.

pi flushes it before a turn's end is relayed (`relayTurnEnd`). It also
flushes it when it stores a compaction between turns (`compact()`, `/session/:id/summarize`, P2.12), and the `/summarize`
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
it off for the boot and stop the drain at once. No refused batch is dropped:

- 422 `seq_conflict`: the thread moves above the log's `seq_max` (see "Flag
  off after state loss"); every message of the thread is collected again at
  its new seq, and the batch goes again at once.
- 413: the batch limit halves for the boot, down to 64 kB, and the dirty set is
  packed again; at 64 kB the journal backs off.
- 400: the puts, tombstones and threads the zod `issues` name, and the session
  patch, are logged (`journal refused a record`, with the issue path) and
  dropped; the rest goes again at once. A 400 that names nothing (a body that is
  not gzip or JSON) drops the batch.
- Any other 4xx backs off and keeps the dirty set. 403: the credential lost
  access to the session; a credential that regains it sends the batch.

apps/api logs one WARN `[session-log] journal rejected` (status, code, project
and session id) for each 400, 403, 409, 413 and 422, because this log stays in
the box. A 200 that does not acknowledge a batch is retried 3 times, then its
pairs are dropped: the native store still holds them. The next boot sends every
stored message again at its first flush (a turn end or the daemon stop; a
journal that restored nothing has no cursors), so a message an older kortixd
dropped on a 422 reaches the log at the first turn end after the box's next
boot on this kortixd (verified on dev 2026-10-23). A second
`startSessionLogJournal` stops the first journal.

### Pending requests

The session log's `pending` lists the permission requests and questions waiting
for an answer (`PermissionBroker.records()`, `QuestionBroker.records()`: `id`,
`thread_id`, `call_id`, `payload`, `asked_at`). Each ask, answer or dismissal
flushes the journal at once, so the change reaches apps/api and the v2 stream as
a `log.state` patch without waiting for the turn to end.

### The session-log actions (`runtime.actions.v1`)

Under `/kortix/runtime`, in session-log terms (bodies and answers:
`RUNTIME_ACTIONS_CAPABILITY` in `@kortix/api-contract/runtime-relay`):

| Route | Does |
| --- | --- |
| `POST /permissions/:id/reply`, `POST /questions/:id/reply`, `POST /questions/:id/reject` | answer what `pending` lists |
| `POST /sessions/:id/compact` | summarize the conversation, as a turn of its own |
| `POST /sessions/:id/command` | run a command, prompt template or skill by name |
| `PUT /sessions/:id/grants` | the capabilities the session uses without asking (`*`: all); `[]` clears them; a `deny` still wins |
| `GET /commands` | the commands, templates and granted skills, without their templates |
| `GET /pending` | each thread's status (`idle`, `busy`, `compacting`) and the permission requests and questions that wait on a person |
| `GET /log`, `GET /log/messages/:id`, `GET /log/blobs/:sha256` | the box's own session log, ahead of the API's copy while a turn runs, and its attachment bytes |
| `GET /workspace`, `GET /workspace/diff?mode=branch\|git` | the checkout's path, home, VCS and default branch; its changes |

### The box's log reads (`runtime.log.v1`)

`RUNTIME_LOG_CAPABILITY` says the box's own log reads can stand in for the
API's copy of the session log:

- `GET /log` answers a whole `SessionLogPage`: the session record without
  threads, the generation, the thread heads and one page of a thread. The seqs
  and session fields are the ones the journal sends apps/api
  (`sessionLogView()` in `shared/session-log-journal.ts`: its generation, its
  session overlay, its per-thread seq offsets).
- A prompt the box admitted and pi has not appended yet (queued behind a
  running turn, or loading its images) is in the log from its admission at a
  provisional seq above every real one (the queued seq in
  `pi/session-log.ts`): on `GET /log`, `GET /log/messages/:id` and the v2
  stream. When its turn starts, the stream gets it again at its real seq
  (`reliveSessionLogMessage`). The journal never sends a queued seq to
  apps/api.
- `GET /kortix/health` `harness.session.root_thread_id` names the root thread
  of the log: a restored dump's root once the runtime started.

Each read still builds the log from pi's entries and the v1 transcript.

## Health and capabilities (E19, E1)

`GET /kortix/health` is composed by `routes/kortix/health.ts`: the host facts
(`shared/host-health.ts`), the harness's closed `harness` block
`{ id, version, state, ready, error, session, turn, details }`
(`HarnessDiagnosticsService.health`; pi's model, extensions and `agentsMd`
are in `details`), `runtimeReady` computed once from both, and
`capabilities`: the host's `file.import`/`file.append`, the control's
`config.release.v1`, and the session features pi serves
(`HarnessDiagnosticsService.capabilities()`, read on each health call:
`session.subagents`, `session.compact`, `session.commands`, `session.steer`
and `session.log.v2`), plus what this box serves on top
(`PiRuntime.multiAgentCapabilities`): `session.messaging` where the box has a
control plane, and `session.team_tasks` while the project's `agent_teams`
flag is on and the session leads a team or is a teammate ("Agents working together"
below). The pre-W3 flat fields (`opencode`, `opencode_pid`,
`opencode_port`, `opencode_session_id`, …) are gone since 2026-10-30.

The host retains its entrypoint (`src/app/`), Git/files/PTYs,
authentication, static previews, the LLM/connector proxy, the resource sampler,
the event sequencer, the managed-skill overlay (`src/services/skills/`) and the
CLI/daemon update scheduler (`src/services/runtime-assets/`). These call service
ports for harness behavior. They import no adapter module; the adapter imports
no route and nothing in `src/app/`. The app hands a boot what it
needs through `HarnessBootContext` (`serve` starts the HTTP server).
`bun run lint` enforces all of it.

## The prompt body

`POST /kortix/runtime/sessions/:id/prompt` (`routes/kortix/runtime.ts`
`parseRuntimePromptBody`) takes `{ message_id?, parts, agent?, model:
"provider/model"?, variant?, directory?, no_reply?, system? }`
and answers `400 { error }` for a malformed one.

| Field | What the turn does with it |
| --- | --- |
| `system` | A string of 16,000 characters at most (`MAX_TURN_SYSTEM_CHARS`), trimmed; blank is none. Added to this turn's system prompt only: pi sets it through the hidden `kortix-turn` extension (`before_agent_start`). apps/api sends the thread's memory file list here (`project_channels`): titles and paths of the Drive Memory folders the thread mounts; the agent reads and writes those files with its file tools. A prompt without it runs without it; a daemon that predates the field ignores it. `/steer` drops it ("Steering"). |

## Steering

`POST /kortix/runtime/sessions/:id/steer` takes the `/prompt` body with
`message_id` required (400 without it), behind the same auth, readiness gate
and `X-Kortix-Turn-Verb` header. The running turn reads the message at its next
step boundary, after the running tool batch; the turn does not stop. Answers:
`202 { message_id, steered: true }`; `200 { deduplicated: true }` for an id
already admitted, steered or on the transcript; `409 { code: 'no_active_turn' }`
when no turn runs (nothing is stored, the caller sends a prompt).
The route drops a steer's `system`: the turn keeps its prompt's `system` to the
end.

- **Read.** The loop emits the message as a user message
  (`steeringMode: 'all'`: every message steered before one boundary arrives
  together). The daemon publishes it on the wire then, under its id, and the
  replies after it name it as `parentID`. It relays `steer_read` once per id
  (`shared/turn-relay.ts`).
- **Withdraw.** The retract (below) on an unread steered message removes it
  (pi: from kortixd's queue in front of `agent.steer()`; pi can only clear its
  queue, so the rest are steered again in order). A read one answers
  `409 { code: 'message_read' }`.
- **Leftovers.** A turn that ends on its own with unread steered messages
  starts the next turn with them, in the same queue slot: the first is its
  prompt, the rest are read before its first model call. A stopped turn (Stop,
  Quick Queue, the no-progress watchdog) drops them.
- **Gaps.** A steered message keeps the turn's model, agent and variant. It
  does not run extension `input` handlers, `/skill:` or prompt-template
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

pi decides from its own state: an unread steered message, a prompt admitted
behind the running work that has not started, and a `no_reply` message no turn
has read (pi omits its session entry from the model context) are retracted. A
retracted id may be sent again. The `DELETE` verb and the compatibility
`DELETE /session/:id/message/:mid` answer the same way, so an older API gets the
fix too.

## The pi harness

> **pi is the only harness.** OpenCode is deleted ("OpenCode is deleted"
> above). What pi does not serve is listed at the end of this section.

pi (`@earendil-works/pi-agent-core` and `pi-coding-agent`, 1.4.0) is bundled
into the daemon binary and runs INSIDE the daemon process. There is no child
process, no port, no RPC and no second sandbox: pi-coding-agent's built-in
`bash`/`read`/`write`/`edit` run on `/workspace` in this process, Kortix adds
`glob`/`grep` (ripgrep) and `question`, and the hosted tools (see "Hosted
tools" below). A project needs no harness folder for any of them.
Every model request goes to the Kortix LLM gateway through the
daemon's localhost LLM proxy, under the `kortix` provider id.

pi's events are reshaped into the v1 wire (`kortix.transcript.v1`) the
clients read (`message.updated`, `message.part.updated`, `message.part.delta`,
`session.status`, `session.idle`, `permission.*`, `question.*`), served over
the `/kortix/runtime/*` namespace and the raw routes (`/global/event`,
`/session`, `/session/:id/prompt_async`, `/session/:id/message`,
`/permission/:id/reply`, …). Any other raw route answers `404`. One pi session is one Kortix
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
+ `KORTIX_TOKEN`. The model catalog is the project's live list,
`GET <KORTIX_LLM_BASE_URL>/models?scope=picker`; it only sizes models (window,
output cap, images, reasoning). pi fetches it from the moment the runtime is
built, beside the repo clone, so the first start rarely waits for it. An env
push (`POST /kortix/env`) and a restart build from the list pi already has and
refresh it in the background: a prompt never waits for the gateway. When the
list does not answer after two tries, models run on default limits and pi
fetches it again after each turn. Images carry no catalog file.
pi-only: `KORTIX_PI_STATE_DIR`.

`KORTIX_AGENT_NAME` (else the config's `default_agent`) is the session's
agent. A prompt that picks a primary agent of the compiled config runs its
turn on that agent: its prompt, permission policy, tool switches, sampling and
variant, and its `model` when the prompt names none. A prompt that picks none
runs on the session's agent. A pick of a subagent, a disabled
agent or an unknown name is logged and runs on the session's agent. pi
packages and extensions stay the ones the session booted with.

### kortix.yaml

The compiled agent set (`KORTIX_COMPILED_AGENT_CONFIG`, `CompiledAgentSet`,
compiled by apps/api from kortix.yaml) is the only config input of every
session. Every rule below holds for the working tree and for a config release.

- **No harness folder.** pi reads no `harnesses/pi`, `harnesses/opencode`,
  `.kortix/pi`, `.kortix/opencode`, `opencode.json[c]` or agent `.md`
  frontmatter: no project `settings.json`, `extensions/` or `prompts/`. pi's
  own discovery of `.pi/` and `.agents/skills` is off (`NO_PROJECT_DIR` in
  `pi/extensions/host.ts`).
- **The `schema: 3` marker.** apps/api writes `schema: 3` into every set it
  compiles from kortix.yaml; boxes that run older daemons read the marker, so
  it stays on the wire. A set without it (My Kortix's, or one from an API that
  predates the one schema) is built-in agents only: its agents run with the
  built-in subagents `general` and `explore`, and no folder is read either.
  No set at all runs `KORTIX_AGENT_NAME` (else `build`) on pi's default prompt.
- **Skills.** The managed `kortix-*` skills, then exactly the folders in
  `compiled.skills`, under the config root: the active release root, else
  `/workspace` (`resolvePiSkillDirectories`). The image default has no
  project skill. pi scans no `skills/` folder. The agent's
  `permission.skill` allowlist still hides every skill it does not grant.
- **Subagents.** A kortix.yaml set has no built-in `general` or `explore`. The `agent` tool offers
  only declared, enabled agents with `mode` `subagent` or `all` that the
  calling agent's `permission.task` rule does not deny. The rule's subject is
  `subagent_type`, so a call to a denied name is refused before it runs.
  The tool also takes an inline ephemeral agent (no manifest entry); the
  session's tool rules still gate every call its child makes.
- **Commands.** `GET /command` lists every `compiled.commands` entry with its
  `agents`. `POST /session/:id/command` runs on the body's `agent`, else the
  session's agent. An agent outside `agents` gets `403 { error:
  "command_not_enabled", command, agent }` and no turn runs. The runtime
  expands the template (`expandCommandTemplate`): `$1`…`$n`
  take the words (a quoted string is one word), the highest placeholder takes
  the rest, `$ARGUMENTS` takes the raw text, and a template with neither gets
  the arguments appended. `` !`cmd` `` shell expansion is not supported.
- **Skills in the command list.** `GET /command` ends with the
  agent's granted skills as `source: 'skill'` rows: the session composer's `/`
  menu reads only this list. A command shadows a
  skill of the same name. `POST /session/:id/command` with a skill name sends
  the `SKILL.md` body in pi's `<skill>` block, then the arguments.
- **Extensions.** The API sends the session agent's pi packages as
  `KORTIX_PI_PACKAGES`; a repo entry is `./<path>` and resolves against the
  config root. Extensions load once per runtime start, so an agent switch
  later in the session keeps them.
- **codemode.** `KORTIX_PI_CODEMODE`, else the session agent's compiled
  `codemode`, else `on`. It is fixed at start, like the extensions. A subagent
  gets codemode only from its own compiled `codemode` (`on` or `only`).
- **kortix.yaml issues.** A set that carries `manifest_issues` (apps/api: the
  file's errors first, at most 50, each `{ path, message, severity, line?,
  column? }`) adds a section to the session notice (below): the error and
  warning counts, one line per issue (`kortix.yaml:<line>:<col> <severity>
  <path> <message>`), the rule that an agent or trigger with an error is off
  until it is fixed, and the fix (edit `/workspace/kortix.yaml`, run `kortix
  validate`, open a change request). No issues: no section
  (`services/config-provider/notice.ts` `manifestIssuesOf`).

### Config releases

pi runs the base branch's current config release
(`pi/config-release.ts`, contract in `services/config-provider/`). A release is
a checkout of the base branch under `/opt/kortix/config/<release_id>`, with
the repository's own layout, verified against its Git blob IDs and sealed
read-only. pi reads from it what it reads from `/workspace`: the compiled
governance (`KORTIX_COMPILED_AGENT_CONFIG`, the agents), the skill folders
and project tools that governance registers, the `./` pi packages, and the
root `AGENTS.md` (else `CLAUDE.md`). A descriptor's `config_dir` (an older
API's) is ignored: the release manifest records `config_dir: null`.

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
  `PiRuntime.reconfigure()` re-reads them. A release that changes a project
  tool or a file in the folder of a `./` pi package (which only a start reads,
  `startOnlyFiles`) restarts the runtime in place instead: the same root, the
  transcript restored. Nothing else restarts, and the answer carries
  `reload: null` either way. A turn in flight, or one admitted behind it
  (`PiRuntime.idle()`), defers the apply; it is asked again after the download,
  right before the swap. A runtime that refuses the config keeps the previous
  one, and the release is quarantined on the box.
- **Reporting.** Health carries the `config` block and `config_dir_sha`, and
  `harness.ready` requires `config.proven`. While a release
  owns the governance, a `/kortix/env` push of `KORTIX_COMPILED_AGENT_CONFIG`
  is dropped. The session notice (`/tmp/kortix/config-release.md`) is part of
  pi's system prompt while a release runs. It is rewritten only when its text
  changes: the commit, the agent re-point, or the kortix.yaml issues.
- **Discovery.** pi discovers nothing (`.pi/{extensions,skills,prompts}`,
  `.agents/skills`), in the release or in `/workspace`. On the image default a
  `./` pi package does not load.
- **Not in a release.** npm pi packages (the agent's kortix.yaml
  `extensions`) load when the runtime starts. A change to them reaches a
  session at its next boot or restart.

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
one tool. pi maps its tools onto them: `write` is `edit`, `memory` is `edit`
(`read` for the `view` command), and `web_search`/`image_search` and
`scrape_webpage` follow `websearch` and `webfetch` (`pi/interactions.ts`
`toolCapability`); pi asks for them like any other tool. A rule under the
tool's own name wins over its capability. The Kortix tools that write files
come from one list, `KORTIX_EDIT_TOOLS` in `services/tools/tool.ts`. A rule is an
action, or a glob-pattern -> action map matched against a `bash` command or a
workspace tool's path. A pattern map is never collapsed to its `*` entry.

**A path rule matches the file.** pi resolves the path as its file tools do
(`pi/interactions.ts` `toolPath`: `@`, `~`, `file://`, `.`, `..`, absolute)
and matches it relative to the workspace. So `./secrets/a`, `x/../secrets/a`,
`@secrets/a` and `/workspace/secrets/a` all match `secrets/*`. A `read`,
`write`, `edit`, `glob` or `grep` path outside the workspace also answers to
`external_directory`, with the subject `<dir>/*`, and the strictest rule wins.
pi applies `external_directory` only when a rule covers it. pi does not
resolve symlinks. A path rule does not govern `bash`: `cat secrets/a` is a
`bash` command.

**A bash line is decided command by command.** pi splits the line
(`pi/interactions.ts` `bashCommands`) on unquoted `;`, `&`, `|` and newlines,
reads each `$(…)`, backtick, `<(…)`, `>(…)` and `( … )` body as commands of its
own, and the strictest answer wins (`deny`, then `ask`, then `allow`). So
`bash: { '*': deny, 'kortix connectors call x get *': allow }` runs that call
and refuses `kortix connectors call x get a; env`. A line whose quotes or
brackets do not balance is decided as a call with no subject: a restriction
asks.

**Precedence:** the most specific matching rule wins, whatever
order the keys are written in (`@kortix/api-contract/permission-rules`). The
longest pattern is the most specific; equal lengths compare by code unit, the
later one winning. Keys follow the same order (`bash` outranks `*`), and a key
whose map matches nothing falls back to a less specific key. pi resolves this
in `pi/interactions.ts` `resolvePolicyRule`. pi's request names the capability and the call's subject (`patterns`); an "always"
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
| project | the session agent's kortix.yaml `extensions` → `KORTIX_PI_PACKAGES` | npm sources: built once per package list by the API (apps/api/src/pi-packages, on change-request merge) as a PRE-BUILT bundle — one self-contained, minified ESM file per extension (deps inlined; pi's own modules read `globalThis.__kortixPiHost`) plus the package's own files minus the code that file inlined, type declarations, source maps and the root README/CHANGELOG — and the installed `node_modules` as a fallback. The daemon starts the download with the service (beside the repo clone), unpacks to `<KORTIX_PI_PACKAGES_DIR>/<digest>` (outside the repo) and imports each extension natively: no jiti, no install (`extensions/prebuilt.ts`). A package with no pre-built form, one whose file throws on import, or an entry with its own `extensions` filter loads from the fallback (`KORTIX_PI_PACKAGES_FALLBACK_URL`, fetched only then) through pi's loader |
| repo-local | a `./` path in the agent's `extensions` (a file is one extension, anywhere in the repo) | the repo itself: a `./` path resolves against the config release root while a release runs, else the working tree (`packageRoot`); a release that changes a file in its folder restarts the runtime (`pi/config-release.ts` `startOnlyFiles`) |

A project entry for the same package overrides the system one. Nothing installs
at boot. pi installs a missing package on load (13.2 s for two packages,
measured), so `installedPackages()` drops an npm source that is not on disk at
its pinned version, refuses repository sources, and reports each drop under
`extensions.failed` in `[pi] runtime ready`. A package's extension loads through
pi's jiti loader. In the compiled daemon, pi supplies `typebox` and the
`@earendil-works/pi-*` peers as virtual modules: a compiled probe loaded a
TypeScript package importing both in 24 ms, and its tool ran.

In-process extensions are `InlineExtension`s (`{ name, factory }`): `kortix-subagents`,
`kortix-workflow`, `kortix-messaging` and `kortix-team-tasks` ("Agents working together" below),
the hidden `kortix-turn`, which adds a prompt's `system` field for that turn (and the
`ultracode` line),
the hidden `kortix-nested-calls` gate and `codemode`.

### codemode

pi-coding-agent's `createCodemodeExtension()` (`pi/codemode.ts`): one tool, `codemode`, whose
input is a JavaScript script that calls the other tools as `await tools.<name>(args)` in a
QuickJS VM (no Node, file system, network or timers; 256 MB). Only the script's output
returns to the model. The agent's kortix.yaml `codemode` (`KORTIX_PI_CODEMODE`, sent by the
API at session start; without the variable the session agent's compiled `codemode`) picks `on` (the
default: the other tools stay declared), `only` (requests declare codemode alone) or `off`
(the extension is not loaded). `models` stays off: it would call providers past the LLM gateway.

- **Policy.** A script's calls are nested calls (`ctx.executeTool`, id `<call>/<n>`, events with
  `parentToolCallId`). pi runs them through the extension `tool_call` handlers only, never
  `agent.beforeToolCall`, where the policy sits (`toolGate`). `nestedCallGate`, first in the
  extension list (pi stops at the first block), applies the root rule to every call with a
  parent: `deny` blocks, `ask` attaches to the call's own part when it has one (below), else to
  the codemode part. `agent`/`task` and `question` are refused from a script (a subagent thread
  links to its root `agent` call; a question needs the model-issued call it answers). A nested call
  runs in parallel with its siblings unless its tool is `sequential` (pi's `NestedToolCallRunner`):
  `Promise.all` over `tools.image_gen()` generates the images at the same time.
  A tool the agent's tool access turns off is not callable from a script either (pi offers
  scripts only active tools).
- **Subagents.** A child is a bare `core.Agent`: no extension loads and no tool gets a session
  context. When the subagent's own compiled agent sets `codemode: on` or `only` (omitted:
  none, whatever the session's mode), `spawnSession` adds
  pi's tool (`childCodemodeTool`, reached by a relative path into pi's
  `dist/extensions/codemode/tool.js`) with the context pi's executor reads: `tools`,
  `executeTool` and `sessionManager.getBranch()`. Each script call runs pi-agent-core's
  `runToolCall` with the child's own `beforeToolCall` and `afterToolCall`: validation, the
  subagent's and the session's rules (`deny` blocks, `ask` asks), and the extension handlers,
  one call at a time — as the child's own direct calls run. The permission checks are identical,
  and a script's call now carries its parent `codemode` call id (`parentToolCallId`, derived from
  pi's `<call>/<n>` nested id), so an extension `tool_call`/`tool_result` handler sees it as nested,
  as on the root; the child's own gate already policed it (stricter than the root rule), so
  `nestedCallGate` skips it (no double decision). An `ask` on a subagent call is not attached to the
  codemode part (`attachToPart: false`), as on every subagent call. A script reaches only the child's
  tools, so never `task` or `question`. `on` adds codemode beside the direct tools; `only` registers only
  codemode (and `show`, when the child has it) as the child's model-visible tools, so every call goes
  through a script, while scripts reach every other tool through the executor (no AgentSession loadout needed).
  The child's OWN tool access that merely omits `codemode`/`show` (the implicit `{'*': false}`
  default) still grants them — they are built-in controls, and denying an `only` child's codemode
  would hide its direct tools and refuse every call. This exemption is the subagent's allowlist
  only and NOT how the root behaves (the root denies a built-in its allowlist omits). The SESSION
  (root) agent's allowlist is still enforced, so delegating never unlocks codemode/show the session
  denies. To turn a subagent's codemode off, set its own `codemode: off`; a `deny` rule — a wildcard
  `permission: { '*': deny }` matches codemode too, so list `codemode: allow` to keep it — also turns
  them off, and `tools: none` (no tools at all) takes codemode with it. `codemode` is not a tool name,
  so do not list it in a `tools` allowlist or `exclude` (validate warns it is unknown). The subagent's mode comes from
  its OWN agent, independent of the session agent's codemode (`KORTIX_PI_CODEMODE`, which
  the API fills from the session agent): a lead set to `codemode: off` does not disable a
  subagent's own `only`. When a built-in is off, wiring is skipped and the child keeps its direct
  tools (a `log.warn` records it), never bricked. `show` stays a direct call: a script cannot call it.
  Limits: `store()` writes last one script (nothing appends them); the session log's code block has no
  `result.details` (pi's `nestedCalls` record is an AgentSession feature), only pi's live record in
  `ext.pi.data.details`.
- **Transcript.** A nested call is not a part, except a call to a native-part tool
  (`NATIVE_PART_TOOLS`: `show`, `image_gen`). pi emits a nested call's
  `tool_execution_start/update/end` on the session only, with `parentToolCallId`;
  `onSessionEvent` publishes those of a native-part tool through the same adapter as a direct
  call, so the card renders: a tool part on the script's message, `callID` = pi's nested id
  `<script call>/<n>`, with its input, output and times. The codemode part's `metadata.calls` is
  pi's live record of every nested call (`id`, `name`, `args` as JSON text,
  `running`/`ok`/`error`/`cancelled`, `durationMs`, `error`). The v2 live put fires when a call
  in it changes status. In `only` mode `show` and `image_gen` are model-only (pi hides a
  `direct` tool's declaration there), so a script cannot call them.
- **Session log.** The call is `kind: 'code'`. `result.details` is `{ calls, complete }` from
  pi's bounded `nestedCalls` (256 calls, 8 kB of input each, 32 kB in all, 500-character
  errors, no outputs): display data, never `tool_call` blocks, because the model never saw them.
  A nested native part is a model-invisible harness block after its parent's `tool_call` block:
  `{ harness: 'pi', kind: 'nested_part', data: { parent_call_id, part }, model_visible: false }`,
  `part` = the v1 part the runtime published, without ids (adapter 1.2.0). `toV1` gives `part`
  back under the block's ids, so a cold reload, a share and a restore draw the same card as the
  live turn, once (the log's row replaces the live row by message id). At rest a nested part
  still `pending`/`running` is closed as `error` "No result provided", like its parent. modelView
  and the restore's pi entries skip the block; the restore's v1 transcript keeps it, so the next
  export finds it again. A `tool_call` block takes the v1 part with its own call id first, then
  the first one with its tool name, so a direct call never takes a nested part's id.
  `store()` values fold into the root thread's `ext.pi.data.codemode_store`; the restore writes
  both back (`nestedCalls`, one `codemode-store` entry).
- **Build.** The compiled daemon embeds `quickjs-wasi/quickjs.wasm` (`setEmbeddedQuickJSWasmPath`,
  reached by a relative path into pi's `dist/config.js` because pi does not export it; a child's
  codemode sets it too, so it works with the session's codemode `off`) and builds
  `src/extensions/codemode/worker.ts` as a second entrypoint with `--root=.`: in a binary pi starts
  the worker as `./src/extensions/codemode/worker.ts`, resolved against the build root. Both fail
  only on the first script, never at boot: `pi-harness.test.ts` "pi codemode" runs scripts from
  source, and a compiled check is a real session (`RUN-20`). At most 2 script workers run per
  process.
Child sessions have no `AgentSession`; the runtime routes their tool, context and
provider hooks to the same runner. `ctx.ui` has no UI bound (`hasUI` is false):
tools and events work, TUI-only rendering does nothing.

`kortix-subagents` is the `agent` tool (OpenCode called it `task`): input `{
description, prompt, subagent_type?, agent?, task_id?, session?,
run_in_background? }`, the child id
in the part's `metadata.sessionId` (set while the child runs), output `task_id:
<id>`, a `session: separate|same` line (with the reason when a separate call
ran in this session), then `<task_result>`. It registers under two names with
one handler — `agent` (use this) and `task` (a deprecated alias kept so
OpenCode-era prompts and sessions keep working); both are callable and behave
identically.

`session` picks where each call runs, per call (`cloud-subagent.ts`
`routeSubagent`):

| `session` | Where the child runs | Use it for |
| --- | --- | --- |
| `separate` (default) | Its own new Kortix session and sandbox, linked to this session as its parent, listed in the sidebar, alive after this turn. | Real tasks, long or parallel work, a whole job handed to another agent. |
| `same` | In process, in a child session of this session. No boot, no extra sandbox. | Quick lookups and small sub-steps. |

A `separate` call runs as `same`, and the result says why, when the box has
no control plane (no
`KORTIX_API_URL`, project id or `KORTIX_TOKEN`). It never fails for that
reason. A `task_id` resumes the child in the mode it was created in: an id this
session holds in process is `same`, any other id is a separate session.

A `same` call
runs an in-process pi agent in a child session (`parentID` = root), with its
own wire transcript served by `/session` (the root and its children),
`/session/:id`, `/session/:id/message`, the state document and
`/kortix/runtime/messages/:id`, and persisted in the root's dump so `task_id`
resumes it after a restart. A call picks one of two sources. A named
`subagent_type`: `general` (all workspace and Kortix tools), `explore`
(`bash`/`read`/`glob`/`grep`), and every compiled agent with `mode: subagent`
or `all`; a kortix.yaml set (`schema: 3`) has only the declared agents. The calling agent's
`permission.task` rule (subject: `subagent_type`) removes a denied type from
the list and refuses a call to it. Or an inline ephemeral agent `agent: {
instructions, model?, tools?, description? }`, defined on the fly with no
manifest entry, run under the agent name `inline`; it has no name to deny, so
the session's own tool rules are its only gate. A `same` child gets no
`agent`/`task` (no nesting) and no `question`. On the root, several `agent`
calls in one message run concurrently; a batch that includes any other tool
stays sequential (see "Tool concurrency" below). A child runs its own calls one
at a time (`toolExecution: 'sequential'`). A child session is read-only
(prompts to it answer 501).
A child's calls are checked against the subagent's own rules and the session's
rules; a `deny` from either wins, so delegating never unlocks a denied call.

**Separate sessions** (`session: "separate"`, the default; no project
setting, the model picks per call). The
call is a real child session (`harness/pi/cloud-subagent.ts`):
`POST /v1/projects/:id/sessions` with the
box token, which links the child to this session and authorizes every later
read of it. A named agent runs as itself; `general`, `explore` and an inline
spec run as the parent's resolved agent (never the `default` sentinel; the
platform coordinator sends none), with the spec's instructions in
`initial_context`. Every child, named ones included, gets the parent agent's
effective tool list (the tools that pass `rootToolAllowed`), intersected with
the spec's list, in `runtime_context` `kortix.subagent.tools`. The child's
runtime narrows its tools to that list, so a child never has a tool its parent
lacks, as on the in-process path. `variant` and the spec `permission` are not
sent: the child applies its own agent's. The result text comes from
`GET …/sessions/:child/transcript?detail=full`, read only from the messages
after the last user message (the turn this call started): a failed last
assistant message is an error, and an earlier turn's report is never
returned. `task_id` sends a follow-up through `POST …/sessions/:child/prompts`
to a child of this session only. An aborted call, and a wait past the 30 min
ceiling, stop the child. Guardrails: at most
`KORTIX_PI_CLOUD_SUBAGENTS_MAX` (4) children wait at once per parent, and a
session at depth `KORTIX_PI_CLOUD_SUBAGENTS_MAX_DEPTH` (2, from
`kortix.subagent.depth`) starts no separate child. Both refuse the call with
an error that names `session: "same"` as the way to run it here. A separate
child runs its own pi with the `agent` tool, so it may delegate again up to
that depth.

**Background** (`run_in_background: true`, separate sessions only). The
default is `true` for a separate call from a session at depth 0 (a session a
person started, My Kortix included) and `false` deeper and for every
workflow `agent()`, so an orchestrator never blocks its own conversation. The create body carries `metadata.notify_parent: true` and the call
returns as soon as the child exists: output `task_id: <id>`, `session:
separate`, then `<task_started>` with the commands to check (`kortix sessions
info|log <id>`) and stop (`kortix sessions stop <id>`) it; the part's
`metadata.background` is `true`. The box does not wait. The API delivers the
child's report into this session when the child settles (apps/api
`projects/subagent-notice.ts`): one synthetic `steer` message per finished
turn, source `system:subagent-finished`, holding a `session-report` element
(the web transcript draws it as a "Worker complete / failed" card) and the
child's `<task_result>` or `<task_error>`. It wakes a stopped parent, so it
survives this box restarting. A `task_id` follow-up to a background child
returns at once too. A background call routed to `same` (asked for, or no
control plane) waits, and the result says so. The live cap counts this box's
slots plus the background children `GET …/sessions?parent=<this>` lists as
provisioning or working.

**Workflows.** The `workflow` tool (`pi/extensions/workflow.ts`) starts each
`agent()` through the same spawn, with three more inputs: `stallMs` (a child
whose transcript tail, `GET …/transcript?limit=3`, shows no change and no
running tool for that long is stopped; the result carries `stalled: true` and
the tool starts a new session), `waitMs` (the run's 2 h deadline replaces the
30 min ceiling), and `runtimeContext` (a background run's runner gets the
script, args and approved cap as `kortix.workflow.*` keys; the subagent keys
win, and the whole context stays within the API's 16 KiB). The run approval
asks through the question broker at depth 0 only. Run records for
`resume_run_id` live in `$KORTIX_RUNTIME_STATE_DIR/workflows/runs/`. Saved
workflows are `.kortix/workflows/<name>.js`: the checkout's working tree, or
the API's project files on a box without one. A background run's runner is a
background child (above): the parent hears the run's result once, when the
runner's turn ends, and a `resume_run_id` relaunch returns at once the same
way.

**Tool concurrency.** The root agent runs `toolExecution: 'parallel'`. Every
built-in tool is `executionMode: 'sequential'` except `PARALLEL_TOOLS`
(`image_gen`, `runtime.ts`); `agent` (and its `task` alias) is parallel too. pi-agent-core runs a
model step's calls concurrently only when none of them is `sequential`, so
several `image_gen` (or `agent`) calls in one step run at once and a mixed step
runs in order. A codemode script's nested calls follow the same per-tool mode
(pi's `NestedToolCallRunner`).

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
  one file name to the embedded copy.
- **Resize worker.** pi resizes each image in a worker thread that it starts per image. In a binary
  it starts `./src/utils/image-resize-worker.ts`, an extra entrypoint (`scripts/build.sh`, as
  codemode's worker). That worker is its own module graph, so it imports `pi/images.ts` for the wasm
  redirect, then pi's worker module. Before 2026-10-28 the binary had no such entrypoint, and pi
  resized on the daemon's event loop: a 6000x4000 PNG held `/kortix/health` and every SSE stream for
  about 0.9 s. In the worker the loop stays free, a worker costs about 12 ms to start, and its photon
  memory is freed when it exits. A worker that fails to start makes pi resize on the loop, as before. Built-in tools run one at a time, so a turn resizes one image at a time;
  parallel subagents or a codemode script can run several workers at once (about 450 MB peak each
  for a 6000x4000 PNG).
  `pi-images.test.ts` builds a binary with that worker against a copy of photon-node, deletes the
  copy, and runs pi's `read` and `promptImages` in it; photon must not load on the main thread.

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
only when the recovery fails). The wire carries it as a user message whose one
part is `compaction` (`auto`, `overflow`), an assistant
message flagged `summary` with the summary text or an error,
`time.compacting` on the session while it runs, and `session.compacted`. The
transcript keeps every message. pi's global settings (`<agentDir>/settings.json`,
the image's) set `compaction.enabled`, `reserveTokens` and `keepRecentTokens`; a
project sets none.
Subagent child sessions have no `AgentSession` and do not compact.

The threshold is `window - reserve`, and this daemon sets the reserve from the
catalog: the model's own output limit, floored at pi's 16,384 default and at the
`compaction.reserveTokens` pi's global settings configure, and capped at half the window
(`compactionSettings` in `pi/model.ts`). pi's default reserve alone lets a
request enter the window with less room left than the answer may use, so the
provider cuts the reply (`stopReason: length`, `output_length` on the wire) at a
context the meter still calls healthy. The reserve follows a catalog refresh
(`applyCompaction`), so a custom endpoint's real limits apply to a running
session. A model's `limit.output` therefore also decides when its session
compacts; the settings can only ask for an earlier cut, never a later one.

A transient model error is retried at pi's `agent_before_settle` boundary
(`turnExtension`), not after `session.prompt` returns. The retry therefore stays
inside pi's loop: every step after it runs pi's post-run checks, so a context
threshold, an overflow or a cut answer there still compacts. The boundary
appends a `context_edit` that omits the failed attempt, as pi's own retry does.
A child session has no loop to re-enter and keeps the out-of-loop retry
(`transient-retry.ts`).

A `/summarize` is a turn of its own, named by its compaction marker (the user
message with the `compaction` part): when the compaction that
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

Reasoning is display only across models (C3, P7.3). Since pi 1.3.0, pi-ai's
`transformMessages` drops the thinking another model wrote from each request
(same model = provider, api, model id), for the root and every child agent.
pi's summarizers (compaction, branch summary) send no thinking block of any
model since pi 1.2.0 (`serializeConversation`). `pi-session-log-restore.test.ts`
fails if either changes. A model switch (a prompt's
`model`, `POST /kortix/env`) and a restored log written by another model or
harness both go through it. The same model's thinking goes back unchanged, and
the store and the session log keep every block.
`PI_CAPABILITIES.native.reasoning_replay` is `same_model`. OpenCode showed
another model's reasoning as text (`lowers_to_text`), so the switch preflight
lists that in-context reasoning as a `lost` line on a switch from OpenCode to
pi. modelView compares
provider and model only, so the restore gives a `kortix` message without `api`
(a v1 or OpenCode-converted log) the gateway dialect `openai-completions`;
pi-ai then sees the same model and keeps its reasoning.

`GET /command` lists the compiled commands (see "kortix.yaml"), never pi's
prompt templates. `POST /session/:id/command` runs one: the runtime expands
its template, and the user message on the wire is the expanded text. An
unknown command is a 400. pi does not read a `commands/` or `prompts/`
directory.

Not supported by pi today (answered honestly, never silently): session rewind
(`/session/:id/revert`, 501 `feature_not_supported`), MCP/connector tools, todo
tools, `ctx.ui` prompts from extensions. `/kortix/health` reports `harness: 'pi'`
in the closed `harness` block ("Health and capabilities" above).

## Agents working together (`session.messaging`, `session.team_tasks`)

Kortix's version of Claude Code's subagents, agent teams, cross-session
messaging and dynamic workflows. The wire contract is
`@kortix/api-contract/multi-agent`; the tools reach the API with the session's
own token (`pi/extensions/control-plane.ts`), so every call acts as this
session for its person. No tool waits on another session: each call is one
API request (at most `CONTROL_PLANE_CALL_TIMEOUT_MS`, 10 s), and a person's
message during the turn is steered in at the next step as always.

| Tool | Where | What |
| --- | --- | --- |
| `send_message`, `list_agents` | a box with a control plane (`session.messaging`) | `POST …/sessions/:self/peer-messages`, `GET …/sessions/:self/reachable?scope=&project_id=`. `held`, `refused`, `dropped` and an ambiguous `to` (`409`) are results with a card, never errors. |
| `task_create`, `task_list`, `task_get`, `task_update` | flag `agent_teams`, a lead (depth 0) or a teammate (`kortix.team.lead` in `runtime_context`) (`session.team_tasks`) | the lead's list, `…/sessions/:lead/tasks`; `claim: true` is atomic in the API (`409 task_taken`/`task_blocked`). |
| `task_stop` | a box with a control plane | stop one child of this session by `task_id` or name (`cloudStopChild`). |
| `agent` | every session | `name` (metadata `agent_handle`, unique among live children), `fork` (`fork_from_session_id` = this session), `run_in_background` default true for a separate session at depth 0. In an `agent_teams` project a named, non-fork spawn at depth 0 is a teammate: metadata `team_lead`, always background, teammate instructions in `initial_context`. |
| `workflow` | every session | background by default at depth 0; refused in a turn whose prompt is a peer message, a room message or a trigger (`pi/prompt-origin.ts`); `ultracode` in the person's prompt adds a per-turn line asking for a workflow; a plan above 25 agents says "Large workflow" in the approval. |

Each result is a `KortixToolResult`-shaped document (`{ ok, tool, action, card,
data?, error? }`) as the tool's JSON output and its part `details`; the tools
are in `NATIVE_PART_TOOLS`, so a codemode script's call gets its own card. Their
grant follows the `agent` tool's unless the agent's `tools` names them; a
teammate always keeps messaging and the task list.

Workflow runs: `GET /kortix/runtime/workflows` → `{ runs: WorkflowRunMetadata[] }`
(the live runs, then every saved run, newest first; a background run is listed
on the parent with `background.sessionId`, its runner session, and its last
known state). `POST /kortix/runtime/workflows/:runId/control`
(`WorkflowControlBody`) → `200 { ok, paused }`: `pause` (no new `agent()`
starts; running agents finish), `resume`, `restart_agent` (stop that child and
start it again with the same prompt, counted as an attempt), `stop`. `404`
for an unknown run; `409 run_in_runner` with `runner_session_id` for a
background run (control it on the runner's box), `409 run_ended`, `409
agent_not_running`. Saved workflows of the checkout and the bundled
`deep-research` (`pi/extensions/bundled-workflows.ts`) are `/name` commands.

- **Names.** `agent({ name })` writes metadata `agent_handle` on the child;
  with flag `agent_teams` on, a named child of a depth-0 session is a
  teammate (metadata `team_lead` = this session). `to` resolves a handle, a
  session id or an 8+ character prefix, `parent`/`main`, or `@name`.
- **Delivery.** A delivered message reaches a working receiver as a steer at
  its next step and starts a turn on an idle one. It carries no authority: it
  never answers a permission request or a question.
- **Limits.** 16,000 characters, 30 messages per minute per sender, a duplicate
  within 60 s is dropped, a held message expires after 5 minutes, at most 100
  held, a `notify_when_idle` watch lapses after 12 hours.

Kortix differs from Claude Code's design on purpose: separate children nest
2 levels deep (not 3), a workflow runs 8 agents at once (not 16), every
session and teammate is a cloud session on its own computer, and teams have
no plan-approval step and no hooks.

## Hosted tools

A tool that is not a harness's own (`bash`, `read`, …) is written once, as a
harness-neutral module, and pi runs it in-process
(`../services/tools/`). No route runs a hosted tool from outside the daemon
process.

| Module | What |
| --- | --- |
| `services/tools/tool.ts` | The contract: a default export `{ description, parameters (JSON Schema), execute(args, context) }`, with `context` = `{ sessionId, agent, directory, env, signal }`. |
| `services/tools/kortix/<name>.ts` | The Kortix tools, one self-contained module each: `web_search` (Tavily), `image_search` (Serper), `scrape_webpage` (Firecrawl), `memory`, `show` (an entry whose `path` is an image file of at most 32 MiB gains `sha256`, hashed streamed and concurrently within 2 s; a read error or the deadline leaves it out), `image_gen` (any image model the project can use). Each follows the project tool contract and imports only `node:*`, so `kortix tools eject <name>` copies the file into a project unchanged (the CLI embeds the same bytes, `apps/cli/src/kortix-tools.generated.json`). The web tools read `KORTIX_API_URL` and `KORTIX_TOKEN` from `context.env` and call the API's billed router proxy (`/v1/router/{tavily,serper,firecrawl}`); a box with no control plane calls the upstream with the project's own key. `image_gen` takes 1–4 `prompts` and posts one request per prompt, all at once (`n: 1` each), to the LLM gateway (`KORTIX_LLM_BASE_URL` + `/images/{generations,edits}`, `KORTIX_TOKEN`); the platform picks the image model (`auto` or the one asked for) and resolves its credential. Each image is written under `<checkout>/output/images/<prompt slug>-<time>.{png,jpg,webp}` (the bytes decide the type; never overwriting). The output is `{ action, model, provider, images: [{ path, size, prompt, sha256 }], failed?: [{ prompt, error }] }` (`sha256`: hex digest of the saved bytes); when every prompt fails the call throws the first failure (`… [<code>]`). Code caps it at 10 images per turn and 50 per session, counted before the first await (a batch that would pass a cap is refused whole). The turn is `context.turnId` (pi: the turn's message id, `ToolContext.turnId` in `services/tools/tool.ts`), so direct, parallel, script, retried and subagent calls of one turn share the 10; a call that names no turn keys the turn cap on its abort signal; a reference image must be a real png/jpeg/webp inside the checkout. |
| `services/tools/host.ts` | `loadTools(root, compiled)`: the Kortix tools `CompiledAgentSet.kortix_tools` lists (all six when it is absent: no kortix.yaml `tools` key, or a config compiled before the key existed), then the project's (`project_tools`), imported from `root` (the working tree or the config release). A project tool replaces a Kortix tool of its name; a module that does not load is logged and skipped. `runTool` bounds the output (over 50 KB or 2000 lines: the whole text to a temp file, the head to the model). `sessionEnv` is `context.env`: the process env with the live agent env file over it. |

pi loads them at `start()` and registers each as an `AgentTool`
(`pi/tools.ts` `createWorkspaceTools`); subagents get them too. A release that
changes a project tool's declaration or a file in its module's folder restarts
the runtime in place (`pi/config-release.ts` `startOnlyFiles`).

**Tool access.** `CompiledAgent.tools` (kortix.yaml `agents.<name>.tools`) maps
a tool name to visible, with `*` for every tool not named; `toolAllowed`
(`@kortix/api-contract/runtime-relay`) reads it. pi filters the active tools
and denies a call to a hidden one, for the root and for a subagent (both
agents' maps must allow it).

## The workspace and config providers are host services, not harness logic

`src/services/workspace-provider/` (the `git` / `prefer-s3` / `require-s3`
project acquisition, #7221) and `src/services/config-provider/` (the config
release a boot needs) stay outside `src/harness/`. Each depends only on
`src/lib/` and knows nothing about any harness or about the other: both read
the S3 project snapshot through `src/lib/project-snapshot/`, each into its
own directory, in parallel. The config provider never reads `/workspace`
(`obtainRelease`: disk, snapshot, archive, git; the archive first from the
published release's signed store URL). The harness composes them.
`pi/boot.ts` calls `provideWorkspace(cfg, { onSummary })` at the point where the
cold boot acquires the workspace; pi does not wait for the checkout before its
proof. `contract/boot-state.ts` carries the outcome:
`workspaceProvider` (reported in `/kortix/health` as `workspace_provider`)
and `deferredHistoryBackfill` (`backfillAfterHydration` for an S3 start).

## Native features remain available

The common interface is not a feature limit. Host controllers register every
existing route and invoke named resolved operations. The compatibility proxy
port preserves catch-all forwarding: pi answers it with an in-process
dispatcher, so a native feature without a common method still reaches the
harness. pi's configuration, events and full lifecycle operations stay typed
inside `pi/`. No silent feature fallback or harness switching is added.

`createService` does not spawn a process or subscribe to events. Controllers
receive the resolved service through dependency injection; `/kortix/runtime/*`
is a URL, not an implementation selector. The adapter cannot
register routes or receive a Hono context.

## Unchanged contracts

- Project folders. The compiled agent set is the only config input ("kortix.yaml").
- Environment variable names, defaults and loaded values (pi adds `KORTIX_PI_*`).
- Routes, response/event payloads, diagnostics and durable state filenames.
- Readiness gates, timeout policy and update ordering.
- SDK/UI behavior, Docker images and sandbox image selection.
