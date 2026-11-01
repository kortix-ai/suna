---
title: Long-horizon runtime (retrieval instead of compaction, an orchestrator that never waits, background commands, workers that own their threads)
status: planned (branch `my-kortix-v2`); phase 1 decisions taken 2026-11-01; phases 3-4 parked
owner: Marko (decisions)
updated: 2026-11-01
---

# Long-horizon runtime

The follow-through work ([`long-horizon-follow-through/`](../long-horizon-follow-through/README.md))
made every agent set its own wake-ups. This topic makes the session itself
last: a context that fills never loses a fact, the orchestrator never blocks,
long commands run in the background, and the worker that owns a piece of work
hears its follow-ups first.

## The problem

1. **Compaction loses facts and costs a long model call.** pi compacts every
   root session at `window - reserve`, on a context overflow, on a cut reply
   and on `/compact` (`apps/kortix-sandbox-agent-server/src/harness/README.md`,
   "The conversation, compaction and slash commands"). Each compaction is a
   model call over the whole session that writes a summary. The summary
   paraphrases. The exact error message, path, id or number the next step
   needs is often gone. Mainplane measured this on a ~400k-token session
   with Opus 5.5: 38 s with a cold prompt cache, 29 s with a warm one, against
   15 s to continue from the full record.
2. **The orchestrator can block.** My Kortix's prompt says "Never wait, sleep
   or poll" (`apps/api/src/projects/lib/my-kortix-prompt.ts`), but nothing
   enforces it. pi's `bash` has no default timeout (pi-coding-agent 1.4.0,
   `core/tools/bash.js`: "Timeout in seconds (optional, no default timeout)").
3. **Workers block on long commands.** A build, a test run or a deploy holds
   the worker's turn until it ends. kortixd has no background command with a
   completion event.
4. **Every follow-up goes through the orchestrator.** A `wake_on` wakes My
   Kortix, which then relays to the worker. The API allows an agent session to
   manage loops and triggers on its own session only (`403 "An agent session
   can manage loops on its own session only"`,
   `apps/api/src/projects/routes/session-reminders.ts:63`). The only change
   request event is `merged` (`apps/api/src/projects/lib/change-request-triggers.ts`).

## Sources studied

- **Mainplane** (`github.com/mainplane-ai/mainplane` at `4e7ad5e`, MIT, Go).
  - No compaction. A session past its context limit is stopped with
    "context N exceeds limit N" (`pkg/harness/harness.go:299`). Presets cap the
    limit at 250,000 (`pkg/catalog/build/main.go:30`).
  - The full session record is a file: at each stop it is copied to
    `<scratch>/logs/<id>.log`, media bodies dropped (`pkg/harness/info.go:118`).
  - A person continues from the TUI. The new session's first message is "You are continuing session X. Retrieve key context from it as you go."
    (`pkg/connector/tui/commands.go:327`).
  - The system prompt documents the record format: one JSON header line per
    record (`n`, `kind`, `id`, `time`, `len`, `type`), then the body; `rg -n`
    finds text, and the header of a line is the nearest line above it that
    begins with `{"n":` (`pkg/harness/tools.go`, "Context Management").
  - Every tool result ends with "time 3m12s context 48210", computed from the
    file so the cached prefix holds (`pkg/harness/harness.go:420`).
  - A restart tells the model which jobs it lost contact with
    (`pkg/harness/session.go:479`).
- **DeepSeek, "Exploring Super-agent Design"** (the article) and the research
  prototype `github.com/deepseek-ai/dsh-superagent-prototype` at `6337fc8`
  (MIT, TypeScript). The prototype has no compaction and no
  continue-in-a-new-session logic: one prompt line mentions compaction
  (`prompts/dispatch.md:44`).
  - **Router and Worker.** The Router talks to people and routes. "Workers
    investigate and implement; never add implementation plans."
    (`prompts/orchestrator.md:4`).
  - **The Router may not wait, enforced in code.** It is refused `sleep`, a
    bash timeout over 30 s and a job wait over 5 s (`src/app/sessions.ts:66-86`).
  - **Silence by default:** "Before sending, identify what the human can now
    review, use, decide or unblock; if nothing, send nothing."
  - **Hard reply cap.** An IM message over 100 words is rejected
    (`src/infra/text.ts:3,14`).
  - **Recovery after a restart.** A new assignment starts with a note to check
    the directory, git history and GitHub before repeating an outside action
    (`docs/003-execution.md:146`).
  - **Background jobs.** Bash has `run_in_background` and `job_output`. Work
    left running after a turn gets 30 min, then its shell jobs are killed
    (`docs/003-execution.md:35`).
  - **Subscriptions.** A worker subscribes to its thread. Later messages on it
    reach the worker directly, and the orchestrator gets a short `follow_up`
    notice. A worker hands back an unrelated message
    (`prompts/subscriptions.md`). A wrong attach is permanent, so attaching
    needs an explicit reference (`prompts/dispatch.md:10`).
  - **Admission.** A code gate runs first, then the model, with an `observe`
    mode that only records "would accept" (`src/policy.ts:191-211`).
  - The article's ablation used synthetic workloads, 5 runs per arm. A session
    with a neutral prompt never delegated (p95 29.5 min); a delegation-first
    prompt delegated in 4 of 5 runs; the two-layer design had a p95 of 15.7 min.
    Treat these as direction, not proof.

## Decisions taken (with the reason)

| # | Decision | Reason |
|---|---|---|
| T1 | **No Kortix default context cap.** A reset happens where compaction happens today: pi's `window - reserve` (`compactionSettings`, `harness/pi/model.ts`). | The 2026-10-22 learning ["Serve every model its real limits"](../../entries/2026-10-22T184919Z-serve-every-model-its-real-limits-never-cap-a-window-or-a-co.md) forbids a Kortix compaction budget: cost is controlled per project. Mainplane's 250k cap is a preset choice, not a requirement of the design. |
| T2 | **Reuse pi's compaction record for the reset.** The `session_before_compact` hook returns our own compaction, so pi makes no model call. | pi already calls the hook for all three triggers (`manual`, `threshold`, `overflow`) and appends `fromExtension: true` (pi-coding-agent 1.4.0, `core/agent-session.js:2230-2297`). The wire (`compaction` part, `summary` message), the turn relay, the session-log record and the restore stay unchanged: no client-facing contract change. |
| T3 | **Keep nothing (Mainplane's way)** (owner, 2026-11-01). The reset returns no `firstKeptEntryId`, so the fresh context is the system prompt plus the reset text. | The record holds everything, and the reset text gives its path. pi supports it as is: a compaction whose first kept entry is missing keeps nothing (`buildContextEntries`, pi-coding-agent 1.4.0 `core/session-manager.js:216-228`), and `appendCompaction` defaults to it (`firstKeptEntryId ?? id`, line 890). The restore already maps "the compaction itself, keeping none" (`harness/pi/session-log-restore.ts`). Risk: a reset in the middle of a tool chain loses the newest results from the context, so the reset text tells the agent to read the record's last entries first; the live check tests this case. |
| T4 | **A worker subscribes its own session.** Direct delivery means the worker sets its own wake-ups. My Kortix does not set triggers on other sessions. | The API already allows own-session triggers only (problem 4), and `notify_parent` delivers each finished child turn to the parent (`apps/api/src/projects/lib/session-metadata-keys.ts:115`). No new cross-session permission is needed. |

## Owner decisions (2026-11-01)

- O1: no default context cap (T1).
- O2: keep nothing (T3).
- O3: self-merge each phase to `dev` after the local check, then verify on dev.
- O4 (phase 3 limits): open; phases 3 and 4 are parked (see "Order and delivery").

## Phase 1: retrieval instead of compaction

### Behavior

- **The record.** kortixd keeps one file per session:
  `<KORTIX_PI_STATE_DIR>/records/<KORTIX_SESSION_ID>.log`. The state
  directory is outside `/workspace` (`harness/pi/runtime.ts:2688`), so the
  file is never in the project repo or a snapshot. Directory `0700`, file
  `0600`, the same as pi's state dump.
- It holds every entry of the root thread in order, including the entries
  before earlier resets. kortixd rewrites it atomically (temp file, then
  rename) at every turn end, inside the reset hook before the hook returns,
  and at boot after a restore.
- **Format** (Mainplane's format, proven with Opus). One JSON header line per
  entry, then the entry's text, then a newline:

  ```
  {"n":41,"kind":"call","time":"2026-11-01T14:02:15Z","name":"bash","id":"call_7"}
  {"command":"pnpm --filter kortix-api test src/x.test.ts"}
  {"n":42,"kind":"result","time":"2026-11-01T14:02:31Z","name":"bash","for":"call_7","exit":"error"}
  error: expected 402, received 500
  ```

  - `kind`: `user`, `assistant`, `thinking`, `call`, `result`, `event` (a loop fire, a notice, any automation message), `model`, `reset`.
  - `msg` carries the Kortix message id when known, so a line leads to the transcript.
  - A tool result is written whole: the record is where big outputs spill to.
  - An image is written as `[image: <mime>, <bytes> bytes, not in the record]`.
- **The reset.** When pi would compact, the `session_before_compact` handler:
  1. writes the record;
  2. returns `{ compaction: { summary, tokensBefore, details: { kind: "record", path, entries } } }` with no `firstKeptEntryId`, so no earlier entry is kept (T3);
  3. makes no model call.
- **The text the model reads** (pi wraps it in its compaction framing, `COMPACTION_SUMMARY_PREFIX`):

  ```
  You are continuing this conversation in a fresh context. Nothing was summarized.
  The full record of everything before this point is the file <path>: <N> entries,
  every message, tool call and tool result, word for word. Each entry starts with
  one JSON header line such as {"n":12,"kind":"result","time":"…"}; the lines after
  it, up to the next header, are the entry.
  Search it with grep and read the exact lines you need, when you need them: an
  error message, a path, an id, a number, what the person asked for. Never guess
  what it said, and never show the person this file or its path.
  The person's latest message (entry <n>), word for word:
  <message>
  …
  </message>
  ```

  - A reset during a turn (`threshold` or `overflow` inside a prompt) adds: "You were working on it when the context filled. Read the last entries of the record first: they show what you did last and where you stopped."
  - The latest message is capped at 8,000 characters. Beyond that the text says "(continues in the record at entry <n>)".
- **`/compact`**, the Compact dialog (`packages/ui/src/session/header/compact-modal.tsx`) and `kortix sessions compact` run the same reset, at once.
- **Repeated resets** work the same way: the record already holds the earlier ones as `reset` entries.

### Edge cases

| Case | Behavior |
|---|---|
| Session smaller than the tail | pi refuses before the hook ("Nothing to compact (session too small)"), as today. `PI_COMPACTION_REFUSALS` stays. |
| Overflow with retry (`willRetry`) | pi appends the reset and retries the request once; the retried request is the system prompt plus the reset text. |
| Box replaced (restore from the session log) | The restore writes the whole log into pi's entries unless the log is over the 24 MiB cap (`harness/README.md`, restore slice rule). Boot rebuilds the record from those entries. |
| Restore over the cap (`kept: model_view` or `newest`) | The record starts with a `reset` entry that says the earlier entries are not in this file and names the command that reads them. Verify first that `kortix sessions log` can page back to the start; add paging if it cannot. |
| Turn stopped during a reset | The hook checks `signal` before it returns; a stopped reset appends nothing, as a stopped compaction does today. |
| Secrets | The record holds what the context held, with the same file modes as the dump. No new exposure. |
| Subagents that run inside the parent session | They have no `AgentSession` and do not compact today; unchanged. Cloud subagents are root sessions in their own box and get the reset. |
| Claude subscription models (`claude-agent/<id>`) | Auto compaction is off in that harness (`harness/README.md`, Claude section). Out of scope; record what happens at a full context as a follow-up. |
| Old daemons | A box keeps its daemon until it restarts. Old boxes keep compacting; no API change depends on the new behavior. |

### A builtin you control like any other extension (owner, 2026-11-01: "make sure all these BUILTINS are perfectly controllable like all others")

Today the agent page's extension catalog lists 5 of the 9 extensions kortixd loads for every agent (`PLATFORM_EXTENSIONS`, `apps/api/src/projects/lib/agent-capabilities.ts:83-89`, against `harness/pi/runtime.ts:733`). Missing: `kortix-workflow`, `kortix-messaging`, `kortix-team-tasks`. A platform row gets a switch only through a tool (`controlled_by`, `packages/ui/src/customize/shared/capability-library.tsx:180-186`).

- **The catalog lists every builtin extension**, each with what controls it:
  - `kortix-workflow` (the `workflow` tool);
  - `kortix-messaging` (`send_message` and `list_agents`);
  - `kortix-team-tasks` (`task_create`, flag `agent_teams`);
  - the new `kortix-context-record`.

  A test pins the catalog to the list the runtime loads, so a new builtin cannot be left out again.
- **`kortix-context-record` is switched per agent the way `codemode` is:** an agent field, `agents.<name>.context: record | summary`, default `record`. Its catalog row has `controlled_by: 'context'`, and the agent page's switch writes the field, as the codemode row writes `codemode`.
  - Not the `extensions` grant: an omitted `extensions` grant means none (`OMITTED.extensions = 'none'`, `capability-library.tsx:67`), so a grant-based switch would turn the reset off for every agent without an explicit list.
  - `summary` means pi's own summary compaction, as before this change.
- **Delivery to the box:** the API resolves the field where it already resolves the agent's runtime settings (`apps/api/src/projects/lib/session-runtime-env.ts`) and sends `KORTIX_PI_CONTEXT=summary` only when it is off. The box loads the extension unless that is set.
- **Schema:** `packages/manifest-schema` gains the field, with its JSON-schema description and `kortix validate` errors for any other value.
- **Every surface shows it:** the agent page's Extensions list, `kortix agents show <name>` (or the capabilities read the CLI uses), and the agent's capabilities route.

### The compaction UI (owner, 2026-11-01: "UX/UI for the compaction has to be made sure to be made perfect")

A reset takes milliseconds, and its text is written for the model, not for a person. The UI is designed for that:

- **The transcript divider** (`packages/ui/src/session/turn/compaction-card.tsx`) for a reset:
  - one pill, no shimmer state: "Fresh context · full history kept";
  - opening it shows plain copy in the panel detail, not the model's text: "The conversation reached 182k tokens, so the agent continued in a fresh context. Nothing was summarized: it searches the full history (412 messages and tool results) when it needs a detail. Everything above stays as it was."
  - a manual reset reads "You started a fresh context".
  - An older compaction keeps "Context automatically compacted" and its summary.
- **The client field:** the v1 compaction part (`packages/api-contract/src/transcript.ts:321`) gains `mode?: 'record'` plus `tokens_before` and `entries`. All 3 are optional and additive. Old clients render a reset as a compaction. This is a client-facing runtime contract: verified through a real session locally and on dev (repo rule 6), with the `@kortix/sdk` rules (test first).
- **The Compact dialog** (`packages/ui/src/session/header/compact-modal.tsx`) becomes "Start a fresh context". Its body: "The agent continues with an empty context and searches the full history when it needs a detail. Nothing is summarized, and the conversation stays as it is." There is no progress state: the divider appears at once.
- **The context meter** (`packages/ui/src/session/composer/context-usage.ts`): any tooltip text that says "compacts at" says "starts a fresh context at".
- **TUI** `/compact` and `kortix sessions compact`: the same words, and output that names the reset.
- **All 9 locale catalogs.**
- **Brand gates:**
  - `.agents/skills/kortix-brand/scripts/audit.sh` clean on the touched files;
  - agent-browser on web: both themes, 720 × 480, the pill, the detail and the dialog, with the network request of the dialog;
  - desktop parity per the repo's UI gate;
  - mobile: check what `apps/mobile` renders for a compaction and give it the same label.

### Files

- New `apps/kortix-sandbox-agent-server/src/harness/pi/extensions/context-record.ts`: the record writer and the `session_before_compact` handler, registered in `runtime.ts` beside the other builtin extensions. It is skipped when the API says the agent has it off.
- `harness/pi/boot.ts`: rebuild the record after a restore.
- `apps/api/src/projects/lib/agent-capabilities.ts`, `session-runtime-env.ts`: the full builtin catalog and the off list.
- `packages/api-contract/src/transcript.ts` and the session-log mapping: `mode`, `tokens_before`, `entries`.
- `packages/ui/src/session/turn/compaction-card.tsx`, `header/compact-modal.tsx`, `customize/shared/capability-library.tsx`, the locale catalogs.
- `tests/spec/end-to-end.md` `RUN-13`: the summary text is the reset text.

### Verification

- **kortixd tests** (new `src/__tests__/pi-context-record.test.ts`, one file, seconds):
  - all three reasons append a compaction with no model call;
  - no earlier entry is kept, and the next request holds the system prompt plus the reset text only;
  - the record has every entry in order, including a result over 50 KB, a dropped image and an earlier reset;
  - after a restore, boot rebuilds the same record.
- **The real surface:**
  1. Measure today first: on `dev`, take a My Kortix session to about 100k tokens with tool output that holds 3 unique strings (an error text, a path, a number). Run `kortix sessions compact`. Record its time and model tokens, then ask for the 3 strings.
  2. Repeat on the local stack with this branch.
  3. Pass: the reset takes under 1 s, uses 0 model tokens, and the agent returns all 3 strings exactly, read with `grep` from the record.
  4. The same check on dev after the merge.
- **Log:** `[pi] context reset` with `reason`, `tokens_before`, `entries`, `record_bytes`, `ms`. Check these on dev 1 week after the merge.

### Docs

- Harness README section "The conversation, compaction and slash commands": rewrite.
- `apps/web/content/docs/developers.mdx`, wherever it mentions compaction.
- This topic's status.

## Phase 2: an orchestrator that never waits, stays quiet and never repeats an outside action

1. **No waiting, in code.** A pi `tool_call` handler for My Kortix sessions:
   - blocks `bash` that runs `sleep` at a command position (DeepSeek's regex, `src/app/sessions.ts:70`);
   - sets `timeout` to 30 when it is missing, by mutating `event.input` (`ToolCallEventResult`, pi-coding-agent 1.4.0: "To modify arguments, mutate `event.input` in place");
   - blocks a larger timeout;
   - says why in the reason: "My Kortix never waits: hand the work off, or set a follow-up."

   Workers are not affected until phase 3 exists.
2. **Silence on a woken turn.** Add to the My Kortix prompt (FOLLOW_THROUGH) and to the managed `kortix-system` skill: "A woken turn that finds nothing the person can review, use, decide or unblock sends nothing: update or remove the follow-up and end the turn without text." Before shipping, verify how the web UI shows a woken turn with no text.
3. **No repeated outside action after a restart.** Add this rule to the starter `worker.md`, to the My Kortix prompt and to the lost-turn notice text: before you repeat any action outside the box (an email, a post, a payment, a merge), check whether it already happened, in the record, the workspace, git history and the outside system.
4. **Verification:**
   - a unit test of the guard (blocked, rewritten and allowed calls);
   - a live My Kortix session asked to "wait 2 minutes and check again" sets a follow-up instead of sleeping;
   - a woken follow-up with no news ends with no text.

## Phase 3: background commands for every agent

- `bash` gains `run_in_background: true`. The call returns at once with a job id and the path of the job's output file under `<KORTIX_PI_STATE_DIR>/jobs/`.
- New tools:
  - `job_output { id }`: the tail and the state, never blocking;
  - `job_stop { id }`: kills the job's process group.
- **Completion is an event.** When a job exits, kortixd adds a message to the session: "[job <id> `<command>` exited <code> after <duration>]" with the last 20 lines and the output path. An idle session starts a turn; a busy one gets it after the current step. Verify which pi entry point to use. The intent is the same `automation` message kind a loop fire uses, so the restore maps it already.
- **Limits** (O4): 8 jobs per box, 2 h maximum, all jobs killed when the box stops.
- **After a restart**, boot adds Mainplane's message for each job that was running: "[job <id>: the box restarted, so its result is lost. Check its output file and rerun it if needed]".
- **UI:** the bash card shows "running in background" and links the completion message. **SDK:** narration for `job_output` reads as a check.
- **Docs:**
  - the harness README;
  - `developers.mdx`;
  - the `kortix-system` skill: "a build, test or deploy longer than about 30 s runs in the background; set nothing else: its exit wakes you".
- **Verification:**
  - a kortixd test with a fake clock for start, completion message, stop, the limit and a restart notice;
  - live: a worker runs a 3-minute build in the background, answers a side question meanwhile, and reports when the build exits.

## Phase 4: workers own their threads

- **New event:** `cr-changes-requested`.
  - The `request-changes` route (`/{projectId}/change-requests/{crId}/request-changes`) fires matching `change_request` triggers, the way the merge route calls `fireChangeRequestMergedTriggers`.
  - The trigger filter gains the event name, so the default stays `merged`.
  - CLI: `kortix triggers add … --on cr-changes-requested --cr <id>`.
  - `kortix_schedules` `wake_on`: `cr_changes_requested`.
- **The worker subscribes itself** (T4).
  - Rule in `worker.md` and the `kortix-system` skill: the agent that opens a change request sets its own wake-ups on it (`cr-changes-requested` and `cr-merged`), handles the follow-up itself, and removes them when the request is merged or closed.
  - Its finished turn reaches My Kortix through `notify_parent`, so My Kortix hears the conclusion only.
- **Ownership rule** for My Kortix (DeepSeek's "who owns it"): when a hand-off owns a change request, do not set your own wake-up on it.
- **Permissions:** an own-session trigger needs `PROJECT_SESSION_START` in the agent's grant (`authorizeReminderSession`). Verify with a default worker agent; if the grant lacks it, decide whether own-session loops should need it.
- **Verification:**
  - a REST flow: `request-changes` fires a matching trigger and does not fire a `merged` one;
  - a CLI black-box test of the new flag;
  - a `platform-tools` test;
  - live: a worker opens a change request, a person requests changes, and the worker fixes it and My Kortix gets one notice.

## Later, or not adopted

| Idea | Source | Decision |
|---|---|---|
| Watchdog: a scheduled session that checks running work for no progress, drift and expired loops | DeepSeek article | Later, opt-in: each run uses a turn. |
| Code-then-model admission with an `observe` mode | DeepSeek `src/policy.ts` | Later, with proactive listening; connector events stay behind `event_triggers` (off by default). |
| 100-word cap on chat replies | DeepSeek `src/infra/text.ts` | Later: first check whether a channel session knows its channel. |
| My Kortix without `bash` | DeepSeek, Mainplane | Later: needs a session file-copy tool first (`kortix sessions cp` runs in the shell today). |
| `time … context N` note on every tool result | Mainplane | Not now: it adds tokens to every result, and the reset is automatic and loses nothing. |
| Router batching of events | DeepSeek article | No: one person's chat does not reach the rates where it helps (about 40 triggers per minute in their test). |
| Speculative work in the background | DeepSeek article | Not by default: it spends on work nobody asked for. |
| Bring your own machine | DeepSeek article, Mainplane | A product decision, outside this topic. |

## Order and delivery

1. Phase 1, then phase 2. Each is one pull request from `my-kortix-v2`, checked locally, self-merged to `dev`, then checked on dev.
   - Phase 3 (background commands) is parked until phase 1 is live. It closes a real gap: pi's `bash` blocks the turn. But the idea is not new, since Claude Code, DeepSeek Harness and Mainplane all have background jobs. Decide then, with O4.
   - Phase 4 (workers own their threads) is parked. It saves the orchestrator a relay step, and Kortix has no evidence yet that the relay costs anything.
2. Announce phase 1 in the changelog: "A long session no longer forgets. When the context fills, the agent continues at once with the full record, searchable word for word, instead of a summary."
3. Follow-ups after phase 1: read the `[pi] context reset` log lines on dev after 1 week, and record the Claude subscription harness's full-context behavior.
