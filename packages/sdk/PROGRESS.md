# `@kortix/sdk` — progress

**Single source of truth for _state_** across every session and every plan. Not for
design (that's a spec) and not for _how_ (that's a plan). This file indexes them.

> **Multiple sessions run against this repo.** Read this file **before** starting
> work, and update it **before** ending your turn. Both are mandatory.

**Scope:** everything `@kortix/sdk`. The **Now** section below tracks one plan at a
time. Work outside that plan lives in **Next** and **Backlog** — it is real, it is
tracked, and it is not forgotten just because it isn't scheduled.

---

### 2026-08-24 — session `html-preview` — an HTML file is served, never injected — DONE

**Files:** `core/session/static-file-preview.ts` (NEW: `staticFilePreviewTargets`,
`shouldRetryStaticFileHealth`, `STATIC_FILE_HEALTH_RETRY_MS`,
`STATIC_FILE_HEALTH_MAX_ATTEMPTS`) + `static-file-preview.test.ts` (NEW, 7 tests) ·
`react/use-static-file-preview.ts` (NEW: `useStaticFilePreview`) ·
`react/index.ts` (+1 barrel line) · both public-surface snapshots.
**Public surface: additive only** — `useStaticFilePreview` plus the
`StaticFilePreview` / `StaticFilePreviewStatus` types on `./react`.

**What.** Reported from dev: "any html … renders the html directly in browser
hence things dont work". The session panel's file viewer framed an HTML file
with `srcDoc`, which gives the document no URL at all — so `./style.css`,
`img/logo.png` and `app.js` had nothing to resolve against and every page
arrived as unstyled text. `sandbox=""` made its scripts inert on top of that.
The sandbox already ships the server that fixes it (static file server, port
3211); only the files viewer was wired to it, and it had hand-rolled the wiring.

**Fix.** One hook owns reaching that server — proxied `/open?path=…` URL, the
preview session, a bounded liveness wait, and a `retry`. Two things it does that
the hand-rolled copy did not: it reads `useActiveSandboxProxyContext()` rather
than freezing `deriveSubdomainOpts()` on mount (the documented `sandboxId: ''`
freeze), and `staticFilePreviewTargets` returns `null` until a sandbox binds
instead of addressing `http://localhost:3211` — the VIEWER's own machine, which
a probe can answer `200` for. The probe is `probePreviewPort`, so `401/403` reads
as our auth gate catching up rather than a dead sandbox.

**Gates:** `typecheck` clean (both projects) · `bun test` 2443 pass / 0 fail ·
`smoke:install` passed.

---

### 2026-08-23 — session `session-memory-retention` — stop paying for the transcript twice a second — DONE

**Files:** `browser/cache/idb-write-policy.ts` (NEW: `idbFlushIntervalMs`,
`transcriptSignature`) + `idb-write-policy.test.ts` (NEW, 8 tests) ·
`browser/cache/idb-sync-cache.ts` (skips an unchanged write; a large transcript
writes less often). Internal module — not re-exported from the package barrel,
so no public surface change.

**What.** The IndexedDB transcript mirror rewrote the WHOLE transcript every
500ms for as long as a turn streamed, and `put()` structured-clones what it is
given — roughly 40MB/s of transient main-thread allocation on a 20MB transcript,
for a cache whose only job is to paint something on the next load. It is the
largest single allocator in a long session and a leading suspect for the tab
discards behind "my session reloaded itself".

**Fix.** Two levers, both pure and tested: do not write what is already written
(an O(messages) signature over counts and the tail id, never the bodies), and
write a transcript past 120 messages every 3s instead of every 500ms. A failed
flush drops its signatures so the mirror cannot get stuck claiming a write
landed.

**Gates:** `typecheck` clean (both projects) · `bun test` 2438 pass / 0 fail ·
`smoke:install` passed.

---

### 2026-08-23 — session `turn-end-flap-2` — the same flap, 42 seconds later — DONE

**Files:** `core/session/working.ts` (the veto is no longer gated on
`streamFresh`) + `working.test.ts` (+1 test, 1 rewritten) ·
`react/use-session-send.ts` (an abort TIMEOUT no longer settles the receipt).

**What.** An audit of the first fix found it incomplete. `idleFrame` was still
gated on `streamFresh`, so at `stream.atMs + STREAM_OBSERVATION_MAX_MS` the veto
vanished with no new input and a still-open ledger row put the composer back on
Stop — this time permanently, since an accepted turn's record is cleared only at
its deadline (240 minutes by default). Proven against the real function: idle at
+21s and +64s, `working` at +65.1s with identical inputs.

**Fix.** The freshness bound is about testifying to the PRESENT, and the veto is
not asked about the present: a turn that started before the frame has ended, and
that stays true however old the statement gets. A turn which resumed would have
produced a newer, non-idle frame — at which point it is not an idle frame at all.
The bound still gates every branch that reads `working` out of the stream.

Also: `awaitAbortSettlement` resolves `timed-out` when nobody answered, and that
was written into `AbortReceipt.settledAtMs` — 5s of clock in an evidence field,
which cleared `abortFloor` and brought the Stop button back mid-cancel.
`OPTIMISTIC_ABORT_MAX_MS` bounds an unanswered abort instead; that is what it is
for.

**Gates:** `typecheck` clean (both projects) · `bun test` 2427 pass / 0 fail.

---

### 2026-08-23 — session `turn-end-flap` — a finished turn does not un-finish itself — DONE

**Files:** `core/session/working.ts` (`endedByRuntime` is causal; `workingExpiryAtMs`
schedules no flip) + `working.test.ts` (+2 tests, 2 rewritten). No public surface
change — `TURN_END_LEDGER_LAG_MS` stays exported, now as a measurement rather
than a rule.

**What.** Reported from dev with three screenshots a second apart: the answer is
on screen and the composer is idle, then "Gathering thoughts…" and the Stop
button come BACK for a couple of seconds, then leave again. The runtime's idle
frame outranked the still-open ledger row for exactly `TURN_END_LEDGER_LAG_MS`
(3s) and then handed authority back. When the `kind:"end"` relay is DROPPED —
the documented failure mode, closed by a reconciliation sweep 15.1s late in this
file's own measurement — the row is still open for that whole window, so the UI
re-announced a turn that had already finished.

**Fix.** Time is not evidence. The veto now holds for as long as the idle frame
is the newest runtime observation; a turn that is really still running says so,
and any newer non-idle frame (`busy`/`retry`) hands the ledger back immediately
with no window to tune. A runtime that goes silent instead is still bounded by
`STREAM_OBSERVATION_MAX_MS`.

**Gates:** `typecheck` clean (both projects) · `bun test` 2426 pass / 0 fail ·
`smoke:install` passed.

---

### 2026-08-23 — session `terminal-ws-wake` — a terminal attach may wake a parked box — DONE

**Files:** `core/runtime/pty.ts` (`getKortixPtyWebSocketUrl` takes `{ wake }`) +
`core/runtime/pty.test.ts` (NEW, 3 tests) · `react/use-opencode-pty.ts`
(`getPtyWebSocketUrl` passes it through). Additive optional argument — no
export added, no signature broken.

**What.** The session Terminal panel looped `Reconnecting in Ns (code 1006)`
forever. A sandbox that idle-parks answers a WebSocket UPGRADE with
`503 sandbox not ready` (`resolvePreviewWsUpstream` in `apps/api`), and a
browser can only report a refused upgrade as close code `1006`. The HTTP data
path wakes a parked box on explicit user intent; the WebSocket path had no wake
branch at all, so nothing in the retry loop could ever resume the box — and the
panel's own `GET /kortix/pty` is a GET on a session-data port, which by policy
also never resumes. Reloading the page did not help.

**Fix.** A USER-INITIATED attach (panel mount, "Reconnect now") carries
`wake=1`; the API resumes a stopped box for a marked PTY attach only
(`shouldWakeStoppedSandboxForWsAttach`). Automatic backoff retries stay
unmarked, so polling and background reconnects still cannot resurrect a box.

**Gates:** `typecheck` clean (both projects) · `bun test` 2424 pass / 0 fail ·
verified live in a browser: parked box → `1006` loop → Reconnect now → row
`stopped`→`active` → `WebSocket connected` → `echo` executed in the shell.

---

### 2026-08-23 — session `commands-not-iterable` — a list endpoint must never hand back a non-list — DONE

**Files:** `react/use-opencode-sessions/shared.ts` (NEW internal `asRuntimeList`,
`cachedRuntimeList`) + `shared.test.ts` (+9 tests) ·
`react/use-opencode-sessions/commands.ts` (`useOpenCodeCommands` normalizes the
response and the localStorage placeholder). No public surface change — both
helpers stay inside `./shared`, which the barrel deliberately does not re-export.

**What.** `dev.kortix.com` threw `TypeError: t is not iterable` from a `useMemo`
and the session view fell into its error boundary ("Something went wrong").
Deminified, the frame is `detectCommandFromText`'s `for (const cmd of commands)`
in `apps/web` — so `commands` was TRUTHY but not iterable. It comes from
`useRuntimeCommands()` → `useOpenCodeCommands()`, which returned
`unwrap(client.command.list())` verbatim. `GET /command` is typed `Command[]`;
a runtime or proxy that answers a list route with an object body breaks that
type at runtime, and the bad value was also written to the localStorage
placeholder cache, so the crash survived a reload.

**Fix.** Normalize at the seam. `asRuntimeList` coerces a non-array list
response to `[]`; `cachedRuntimeList` treats a cached non-array as a MISS so a
poisoned placeholder refetches instead of painting. Every consumer
(`detectCommandFromText`, the slash menu's `slash-items`, `composer-logic`,
`command-attachments`) iterates the list unconditionally, so the guard belongs
here — one place — not at four call sites. `apps/web`'s `detectCommandFromText`
also grew an `Array.isArray` guard for defense in depth, matching its existing
per-item non-string `template` guard.

**Gates:** `typecheck` clean (both projects) · `bun test` — see PR.

---

### 2026-08-21 — session `session-busy-flicker` — display order was not an order — DONE

**Files:** `core/turns/grouping.ts` (`compareMessagesForDisplay` rewritten as two
segments) + `core/turns/display-order.test.ts` (new, 7 tests). No public surface
change.

**What.** Three prompts sent "who", "are", "you" rendered "who", "you", "are",
and assistant replies attached to the wrong user messages.

`compareMessagesForDisplay` switched ordering PER PAIR: wire-id order when both
ids were well-formed wire ids, `time.created` for every pair involving anything
else. A queued row carries a host-fabricated stamp, so two placed messages A, B
and one queued row S compared as A < B (by id), S < A (by time), B > S (by
time) — a cycle. `Array.prototype.sort` may emit any permutation of a cyclic
comparator and V8 switches algorithm with input length, which is why the order
looked random. `groupMessagesIntoTurns` walks the same sorted list to attach
assistant messages with no `parentID`, so the replies re-parented too, and a
queued row could sort ABOVE the entire transcript.

**Fix.** Two disjoint segments, each internally a total order: everything the
server has PLACED (it has a wire id) first, in wire-id order; everything still
only LOCAL (an optimistic stub, a queued inbox row) after all of it, by send
instant, untimed last. A local placeholder exists precisely because the server
has not placed it, and gains a wire id the moment it is echoed. No fabricated
timestamps anywhere, so no clock skew can reorder a conversation.

Two untimed messages stay a TIE so the stable sort keeps the host's input order
— an id tiebreak there regrouped `groupMessagesIntoTurns`' own sequential
fallback (`u1`, `a1`, `a2` → `a1`, `a2`, `u1`), caught by its existing test.

**Gates:** `typecheck` clean (both projects) · `bun test --isolate src` 2426
pass / 0 fail · surface snapshots unchanged.

---

### 2026-08-21 — session `changes-truth` — the Changes surface has ONE source of truth — DONE

**Files:** `react/use-opencode-sessions/vcs.ts` (NEW: `useOpenCodeVcsDiff`,
`VcsDiffMode`, re-exported `VcsFileDiff`) + `vcs.test.ts` (NEW, 8 tests) ·
`react/use-opencode-sessions/keys.ts` (+`opencodeKeys.vcsDiff`, `vcsDiffAll`) ·
`react/use-opencode-sessions/index.ts` (barrel) · `react/opencode.ts`
(+`useRuntimeVcsDiff` alias) · `react/use-opencode-events/handle-event.ts`
(+5 invalidation points) + `handle-event.test.ts` (+5 tests) · both surface
snapshots. Additive only — no rename, no breaking change, no new subpath.

**What.** A fresh session showed a tab badge reading "Changes 32" directly above
a body reading "No changes yet". Two sources of truth, contradicting each other
on screen at the same moment:

- the badge counted `GET /file/status` (`git status --porcelain -uall`);
- the body read `client.session.diff({ sessionID })`, which answers "what did
  ONE user message change". Zero user messages on a fresh session → `[]`.

`session.diff` is a message-scoped endpoint, so `useRuntimeSessionDiff` was a
misnomer for what the panel wanted. The correct endpoint is `GET /vcs/diff`,
already in the pinned `@opencode-ai/sdk@1.18.19`. `useOpenCodeVcsDiff` wraps it
with ONE query key per (mode, sandbox), so every Changes surface reads the same
cache entry and they cannot disagree by construction.

**Mode is `branch`, not `git`.** `git` is the working tree alone and drops to
zero the moment the agent commits — the badge and the "Propose changes" CTA
vanished while the work still was not in the base version, which is the exact
opposite of what the surface's own copy promises. `branch` = branch commits +
working tree. Verified live against a real `opencode-ai@1.18.19` server: on a
branch with one commit plus one untracked file, `mode=git` returned 1 entry
(the untracked file) and `mode=branch` returned 2.

`useRuntimeSessionDiff` / `useOpenCodeSessionDiff` stay exported — public API.

**Gates:** `typecheck` clean (both projects) · `bun test --isolate src` 2401
pass / 2 skip / 0 fail · `smoke:install` passed.

---

### 2026-08-21 — session `session-busy-flicker` — the ledger is not timely about the END of a turn — DONE

**Files:** `core/session/working.ts` (`endedByRuntime`, all-rows `openTurn`),
`react/use-session-working.ts` (+`streamTurnPhase`, phase-keyed invalidation),
`react/use-session-prompts.ts` (`sessionPromptsPollMs` believed-pending arg)
+ 4 test files. **No public surface change** — both snapshots are byte-identical.

**What.** The agent finished, the reply was on screen, and the spinner and Stop
button came BACK about 200ms later and stayed for up to 18s.

`projectWorking` ranked its observations by wall-clock: a newer read beat an
older frame. That is wrong here, because the two observers do not learn the
same fact at the same time. `session.idle` comes straight off the runtime over
SSE; the ledger row is closed by a SEPARATE daemon relay
(`POST .../turn-stream` `kind:"end"`). The idle frame ALSO triggers an immediate
`/turn` refetch (`use-session-working.ts`), and that refetch is stamped after
the frame while still reporting the turn the frame just ended → `working`.

MEASURED, local stack, five consecutive turns: ledger lag behind the runtime of
**6.9s, 10s, 15.2s and 18.5s**, and only ONE of the five turns produced a relay
POST at all — the rest were closed late by a reconciliation sweep. One captured
transition: idle frame 00:03:59.964 → `working` again at 00:04:00.150 (read
stamped +44ms, turn still `active`) → idle at 00:04:15.248. 15.1s of false busy.

**Fix.** A turn whose `started_at` PREDATES the freshest idle frame is the turn
that frame ended, and no ledger read may report it as working. A turn that
started after the frame is a new one the frame knows nothing about and keeps the
ledger's full authority — so a queued prompt draining, a trigger, or a second
device still lights the composer immediately, with no window and no delay. The
rule scans every open row, not `turns[0]`: the ledger holds two open turns while
a prompt is forwarded under a running one, and the list is not newest-first.
`serverOpenTurnToken` deliberately does NOT move — it answers "does the control
plane still hold authority", which is what an admission-gate-less `/` command
checks.

**Also.** (a) `streamTurnPhase` keys the SSE-triggered invalidation on the
idle/active PHASE instead of the observation instant: the runtime alternates
`busy`→`retry` about every 140ms mid-turn (measured), and each flip was
re-invalidating `/turn` AND `/prompts`, once per mount, three mounts per session.
(b) `sessionPromptsPollMs` now counts what the tab BELIEVES is pending, not only
the fetched list length — a first read that landed before the row existed
answered zero, locked the 15s idle cadence, and let the 10s
`INBOX_OBSERVATION_MAX_MS` belief die under a prompt that was still queued
(captured: `inbox=1@10004` → `idle`).

**Tried and reverted.** Excluding FORWARDED (`delivering`) inbox rows on the same
idle frame. A prompt queued behind a running turn is handed to OpenCode early and
sits in `delivering` ACROSS the turn boundary, so that frame says nothing about
it; the change put the composer back on Send for 13.8s with the user's queued
prompt still waiting. Reverted whole, including its `countForwardedInboxPrompts`
export — the hypothesis it was built on (rows closing late) is also false: rows
leave `GET .../prompts` at acceptance, ~1.7s after the turn opens.

**Open, server side, NOT fixed here.** The daemon's `kind:"end"` relay is
missing for most turns on the local stack, which is what makes the ledger 7-18s
late and also delays `reconcileForwardedTurnsAtEnd` — a prompt queued behind a
running turn was stranded and re-queued, starting 13.6s after the turn ahead of
it ended. The client is now correct regardless, but the relay gap is worth its
own investigation.

**Verification.** Real turns against a live Platinum sandbox, UI sampled at 100ms
on `[data-testid="session-busy-indicator"]` + the Stop control: **0 busy
reversals in 1133 samples** on a turn whose ledger lagged 18.5s. Before the fix
the same measurement showed idle→working→idle with a 15.1s false-busy leg.

**Gates:** `typecheck` clean (both projects) · `bun test --isolate src`
2402 pass / 2 skip / 0 fail · `smoke:install` — see below.

---
