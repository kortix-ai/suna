import type { PromptRow } from './session-prompt-view';
import { isForwarded, isHeld } from '../session-lifecycle/delivery-state';

/**
 * Map a durable command row onto the inbox's four user-visible states.
 *
 * `succeeded` no longer means "never appears". A FORWARDED row is `succeeded`
 * so the drain can never re-claim it, and still unanswered: OpenCode has
 * persisted the message and queued it behind the turn in flight. It reads
 * `delivering` until the `session_turns` ledger confirms a turn consumed it —
 * which is what keeps the composer working across that interval instead of
 * showing the user nothing. Only a `delivered` row disappears; it IS the
 * transcript by then.
 */
export function promptState(row: Pick<PromptRow, 'status' | 'result'>): {
  state: 'queued' | 'delivering' | 'waiting' | 'failed';
  reason: string | null;
} {
  const result = (row.result ?? {}) as Record<string, unknown>;
  // TERMINAL FIRST, above every marker on the row. A row can be given up on
  // while it still carries `forwarded` — `deadLetter` (redelivery.ts) is
  // exactly that — and reading the marker first made it `delivering` for ever:
  // the strip filters in-flight rows out, `countLiveInboxPrompts` counts them
  // as live work, and the sweep scans `succeeded` only. Nothing could close it.
  // `failed` is the state that carries the retry, which is the way out.
  if (row.status === 'failed' || row.status === 'dead_lettered') {
    return { state: 'failed', reason: null };
  }
  // Then HELD: a held row is waiting on the USER, not on the session — the stop
  // button put it there, and only an explicit send or "send now" takes it out.
  // It outranks the markers below: a held row is not in line at all, and that
  // is true of a forwarded row Stop paused just as much as of a queued one.
  if (isHeld(result)) return { state: 'waiting', reason: 'held' };
  // Then FORWARDED, above `running`: this is a `succeeded` row, so every branch
  // below would otherwise fall through to `queued` and show a prompt that is
  // already at OpenCode as if it had never been sent.
  if (isForwarded(result)) return { state: 'delivering', reason: 'forwarded' };
  // A claim only checks admission. It must not flash Sending during a live turn.
  if (row.status === 'running' && typeof result.delivery_started_at === 'string') {
    return { state: 'delivering', reason: null };
  }
  const admission = result.admission_reason;
  if (typeof admission === 'string') return { state: 'waiting', reason: admission };
  // Parked on a DOWN runtime. Still `queued` — the row IS in line and the server
  // re-attempts it (on a wake, or on its backoff ladder), so anything else would
  // be a lie in the direction that lost the message before: `failed` invited a
  // manual retry for work the server was already doing. The reason names WHAT it
  // is waiting for, and `runtime_retries` says how much patience is left.
  if (result.delivery_blocked === 'runtime_unreachable') {
    return { state: 'queued', reason: 'runtime_unreachable' };
  }
  return { state: 'queued', reason: null };
}
