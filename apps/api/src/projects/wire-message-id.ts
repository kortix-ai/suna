/**
 * The OpenCode wire message-id clock, under the names the control plane uses.
 *
 * The implementation is `@kortix/sdk/wire-message-id`
 * (`packages/sdk/src/core/session/wire-message-id.ts`). That subpath is a
 * single file with no imports, so the API loads it without the SDK's root
 * barrel. This module only maps the SDK names onto the ones API callers
 * already use; it holds no arithmetic of its own.
 *
 * The clock wraps every ~2.2 years. API code never compares two clocks with
 * `>`, `<` or `<=`: it uses `wireIdClockDelta(a, b)` (signed distance on the
 * ring) and `maxWireIdClock(clocks)`. `WIRE_ID_TIME_SCALE` is re-exported only
 * to convert the tolerance to milliseconds.
 *
 * WHY THE ID IS A POSITION AND NOT JUST A NAME:
 *
 *  - opencode <= 1.18.14 (the baked 1.17.11 on every box provisioned before
 *    2026-08-20): the loop resolves "has this prompt already been answered?"
 *    by ID ORDER. A user message whose id sorts below the assistant replies
 *    already on record is read as answered and its turn NEVER RUNS.
 *  - opencode >= 1.18.15: the loop exits on `lastAssistant.parentID ===
 *    lastUser.id`, and `latest()` orders by `time.created`. A low id no longer
 *    drops a prompt on its own.
 *
 * The id clock still orders the TRANSCRIPT in both versions: `MessageV2.page()`
 * runs `orderBy(desc(time_created), desc(id))`, so the id is the
 * sub-millisecond tiebreak and a wrong one reorders messages on screen.
 *
 * A prompt carries the id its client minted (`wireMessageId`). The API mints
 * a new one only for a runtime that orders by id (OpenCode): a prompt that
 * waited behind a turn, a redelivery, a released Stop batch row and a
 * stranded prompt (`session-lifecycle/inbox-placement.ts`
 * `remintWireMessageId`), and a stale direct send through the proxy
 * (`sandbox-proxy/prompt-wire-id-repair.ts`). A runtime that lists
 * `RUNTIME_STABLE_MESSAGE_ID_CAPABILITY` (pi) orders by position and keeps
 * the id; the API re-mints there only a continuation, a held redelivery and
 * an id the web would sort above an earlier prompt
 * (`keepsWireIdOnStableRuntime`).
 */
export {
  WIRE_ID_CLOCK_TOLERANCE as MAX_WIRE_ID_CLOCK_CORRECTION,
  WIRE_ID_TIME_SCALE,
  WIRE_MESSAGE_ID,
  isWireIdAheadOf,
  maxWireIdClock,
  mintWireMessageIdAbove as mintWireMessageId,
  newestWireIdClock as newestWireIdTime,
  wireIdClock as wireIdTime,
  wireIdClockAt,
  wireIdClockDelta,
} from '@kortix/sdk/wire-message-id';
