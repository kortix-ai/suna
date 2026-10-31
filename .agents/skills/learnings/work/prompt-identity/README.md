---
title: One prompt, one id, visible from accept to answer
status: building (branch `prompt-identity`): phases 1–3; phase 4 (web) after
owner: Marko (decisions), agent sessions (build)
updated: 2026-10-31
---

# One prompt, one id, visible from accept to answer

## Problem

A prompt carries up to six ids: `client_message_id`, `prompt_id`, `wireMessageId`,
`redeliveredMessageId(s)`, `forwarded_message_id`, and the turn token. It lives in two
places, and neither one shows it for its whole life:

| When | Inbox (`kortix.control.queue`, `GET …/prompts`) | Log (`GET …/log`, `log.message`) |
|---|---|---|
| accepted, box booting | yes; an `initial_prompt` is not an inbox row (`activeTurns` metadata) | no |
| forwarded, not accepted | yes (`delivering`) | no |
| accepted by the runtime | **no**: the row leaves the queue at `delivered` | only after pi's journal posts (≤ 5 s mid-turn) or a live frame the client was connected for |
| journaled | no | yes, under the re-minted id |

Symptoms (TUI, 2026-10-30): the first prompt is absent while the box starts ("No messages
yet"); a first message missing until the turn end; every prompt drawn twice for a turn
(optimistic id ≠ re-minted id). Hosts patch it: `claimFirstTurnRow`,
`registerOptimisticEcho` (`packages/ui`), text pairing (`7000e36b4e`, branch
`tui-session-first`).

Why: the re-mint exists for OpenCode ≤ 1.18.14, which ordered messages by id
(`apps/api/src/projects/session-lifecycle/inbox-placement.ts`). kortixd has no OpenCode
harness since 2026-10-30. pi uses a given `message_id` (`harness/pi/runtime.ts` `admit`),
orders by position, and answers a known id `deduplicated`.

## Decisions (2026-10-31, Marko)

1. A provisional prompt is marked `ext.kortix.delivery` (`queued` | `delivering` | `sent`)
   on a `kortix.session/2` user message. No contract version bump; an old reader shows a
   normal user message.
2. Own branch `prompt-identity`, not the TUI PR.
3. Phases 1–3 now; phase 4 (web deletes its host workarounds) as a follow-up PR.

## Design

Nothing is written into the log tables: the daemon owns `seq`, and with restore on a
pre-written user message is deduplicated into "no turn runs".

1. **API, `sent`:** the inbox views (`kortix.control.queue`, `GET …/prompts`) gain `sent`:
   prompts the runtime accepted, and the `initial_prompt`, while the log holds no message
   with their `message_id` (tombstones count as held). Additive field.
2. **API, stable ids:** no re-mint where the runtime lists the stable-id capability; a
   redelivery reuses the id (pi dedupes). An old daemon keeps the re-mint.
3. **SDK:** one pure merge (`core/session-log/`): thread + inbox `prompts` + `sent` as
   provisional user messages under their own `message_id`, replaced in place when the log
   holds that id. Opt-in on `useSessionLogThread`. The optimistic send uses the id it
   POSTs.
4. **Web (later):** `session-chat.tsx` reads the merge; `claimFirstTurnRow`, the echo maps
   and the queue-row dedupe go.

## Pick it up

- Worktree `../suna-prompt-identity`, branch `prompt-identity`.
- Learnings that bind this: 2026-09-06 (the durable row carries what the bubble draws),
  2026-09-17 (an inbox prompt is superseded only by its own id), 2026-08-23 (an initial
  prompt is submitted exactly once), 2026-08-21 (OpenCode id order).
