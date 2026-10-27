/**
 * An open session stream re-checks its caller's access on a timer and ends
 * when it is gone: removal from a private channel, a
 * revoked share, a deleted session. A check at open is not enough: a stream
 * can stay open for hours. A failed read keeps the stream (the next tick
 * retries); only a definite "no" ends it. Every session stream passes its
 * check through `sessionStreamAccessCheck` (`shared/space-access.ts`): no
 * query in a project without a private channel, and a failed read answers
 * "no" for a private channel's session only.
 */
export const STREAM_ACCESS_RECHECK_MS = 60_000;

/** Calls `onRevoked` once, the first time `check` resolves false. Returns the stop function. */
export function recheckStreamAccess(
  check: () => Promise<boolean>,
  onRevoked: () => void,
  intervalMs = STREAM_ACCESS_RECHECK_MS,
): () => void {
  let stopped = false;
  let running = false;
  const timer = setInterval(() => {
    if (running || stopped) return;
    running = true;
    check()
      .then(
        (allowed) => {
          if (allowed || stopped) return;
          stop();
          onRevoked();
        },
        () => undefined,
      )
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  return stop;
}

/**
 * `body` passed through unchanged until `check` resolves false; then the
 * stream ends and the upstream is cancelled. For a proxied runtime event
 * stream (`/p/<ext>/<port>/.../event`), which is otherwise checked only at
 * connect.
 */
export function endStreamOnRevoke(
  body: ReadableStream<Uint8Array>,
  check: () => Promise<boolean>,
  intervalMs = STREAM_ACCESS_RECHECK_MS,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let stop = () => {};
  const end = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    stop();
    try {
      controller.close();
    } catch {
      // Already closed or errored.
    }
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stop = recheckStreamAccess(check, () => {
        void reader.cancel('access revoked').catch(() => undefined);
        end(controller);
      }, intervalMs);
    },
    async pull(controller) {
      const next = await reader.read().catch(() => ({ done: true as const, value: undefined }));
      if (next.done) return end(controller);
      controller.enqueue(next.value);
    },
    cancel(reason) {
      stop();
      return reader.cancel(reason);
    },
  });
}
