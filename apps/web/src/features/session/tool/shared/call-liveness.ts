import type { ToolCallBlock } from '@kortix/sdk';

/**
 * One rule for a tool call that never finished, whichever path served it.
 *
 * The v1 live view (`useSessionLogThread` while v2 is off) keeps such a call
 * `pending` or `running`, as the store holds it. The API's v2 page serves blocks
 * at rest, where the closure rule (C2/F11) closes it: `error`, `result.synthetic`,
 * `result.error.code: 'interrupted'`. A block cannot say whether its turn is still
 * live, so neither status is the verdict. `openCall` gives both paths the open
 * call, and the turn decides: an open call of a turn that is not live is
 * interrupted (`isInterruptedCall`), which `ToolPartRenderer` reads through
 * `TurnLiveContext`.
 *
 * Read every block a host renders through `openCall`. P5.2c replaces this module
 * with the derived liveness field of the SDK's block turn layer (P5.2b).
 */

const reopened = new WeakMap<ToolCallBlock, ToolCallBlock>();

/** The closure rule's shape: a call that never ended, closed at rest by the exporter. */
function closedByClosureRule(call: ToolCallBlock): boolean {
  return call.status === 'error' && (call.result?.synthetic === true || call.result?.error?.code === 'interrupted');
}

/**
 * The call as the live view holds it: a closure-rule call is open again, `running`
 * when it started, else `pending`, with no result; every other call as is. The
 * same object per call. Its residual still rebuilds the stored v1 part, so the
 * harness metadata (`toolCallMetadata`) is the live one.
 */
export function openCall(call: ToolCallBlock): ToolCallBlock {
  if (!closedByClosureRule(call)) return call;
  let open = reopened.get(call);
  if (!open) {
    const { result: _result, ...rest } = call;
    open = { ...rest, status: call.started_at ? 'running' : 'pending' };
    reopened.set(call, open);
  }
  return open;
}

/** An open call (`pending`/`running`, or closed by the closure rule) of a turn that is not live. */
export function isInterruptedCall(call: ToolCallBlock, turnLive: boolean): boolean {
  const { status } = openCall(call);
  return !turnLive && (status === 'pending' || status === 'running');
}
