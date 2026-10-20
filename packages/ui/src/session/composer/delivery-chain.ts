/**
 * One FIFO delivery chain per session: every prompt POST of a session leaves in
 * the order its Send was pressed.
 *
 * Why the order matters: an idle session admits a prompt the moment the POST
 * lands, so a send that POSTs before an earlier one runs first. On
 * opencode <= 1.18.14 sandboxes the earlier prompt then carries an Enter-minted
 * wire id below the new assistant ids, and its turn never runs
 * (`apps/api/src/projects/wire-message-id.ts`).
 *
 * A link covers one send's whole delivery: the wait for its uploads and its
 * POST. The link is reserved at Send, so a text-only send made while an earlier
 * send still uploads waits behind it. A link settles on success and on failure
 * alike, so a failed send never blocks the sends after it. Chains are keyed by
 * the Kortix session id, and one session never waits on another.
 *
 * Host code on purpose, beside `deliverAfterPaint`; the POSTs themselves stay
 * SDK calls. Moving the chain into `@kortix/sdk` is a recorded follow-up.
 */

interface DeliveryChain {
  /** Settles when the newest link settles. */
  tail: Promise<void>;
  /** Links not settled yet, the running one included. */
  pending: number;
}

const chains = new Map<string, DeliveryChain>();

/**
 * Run `deliver` once every earlier delivery of `sessionKey` has settled. With
 * nothing ahead, `deliver` starts in the same tick. The result is `deliver`'s
 * own, rejection included. Never call this from inside a delivery of the same
 * session: that link would wait on itself.
 */
export function deliverInOrder<T>(sessionKey: string, deliver: () => Promise<T>): Promise<T> {
  const chain = chains.get(sessionKey) ?? { tail: Promise.resolve(), pending: 0 };
  chains.set(sessionKey, chain);
  const ahead = chain.pending > 0 ? chain.tail : null;
  chain.pending += 1;
  let settleLink!: () => void;
  // Reserved before `deliver` runs: a send made meanwhile queues behind this one.
  chain.tail = new Promise<void>((resolve) => {
    settleLink = resolve;
  });
  const delivered = ahead ? ahead.then(() => deliver()) : start(deliver);
  const settle = () => {
    chain.pending -= 1;
    if (chain.pending === 0 && chains.get(sessionKey) === chain) chains.delete(sessionKey);
    settleLink();
  };
  // Registered before the caller's own handlers, so a caller that sees this
  // delivery settle also sees the chain without it.
  delivered.then(settle, settle);
  return delivered;
}

/** Whether a delivery of `sessionKey` still waits or runs. */
export function deliveryPending(sessionKey: string): boolean {
  return (chains.get(sessionKey)?.pending ?? 0) > 0;
}

function start<T>(deliver: () => Promise<T>): Promise<T> {
  try {
    return Promise.resolve(deliver());
  } catch (error) {
    return Promise.reject(error);
  }
}
