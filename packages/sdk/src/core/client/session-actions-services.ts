import { getClientForUrl } from '../runtime/client';


import { type EventStreamHandle, type RuntimeEvent, openEventStream } from '../stream/event-stream';

import type { SessionBindingContext } from './session-context';
export function bindSessionActionsServices(ctx: SessionBindingContext) {
  return {
    abort: async () => {
      const { runtimeSessionId, runtimeUrl } = await ctx.ensureReady();
      return getClientForUrl(runtimeUrl).session.abort({
        sessionID: runtimeSessionId,
      });
    },
    /**
     * Stage a reversible rollback at one user message on this same canonical
     * OpenCode session. The next prompt commits the new path.
     */
    rewind: async (messageId: string) => {
      const { runtimeSessionId, runtimeUrl } = await ctx.ensureReady();
      return getClientForUrl(runtimeUrl).session.revert({
        sessionID: runtimeSessionId,
        messageID: messageId,
      });
    },
    /** Restore the path removed by `rewind()` before another prompt commits it. */
    restoreRewind: async () => {
      const { runtimeSessionId, runtimeUrl } = await ctx.ensureReady();
      return getClientForUrl(runtimeUrl).session.unrevert({
        sessionID: runtimeSessionId,
      });
    },
    /**
     * Live SSE stream of THIS session's runtime events (message/part
     * updates, session status, permissions/questions, lsp diagnostics, …).
     * A thin facade over the framework-free `openEventStream` primitive
     * (`@kortix/sdk`'s `openEventStream`, also used verbatim by
     * `@kortix/sdk/react`'s `useRuntimeEventStream`): resolves THIS
     * handle's own runtime first (`ctx.ensureReady()`), then connects a client
     * bound to that runtime URL — never the module-global "active" one, so
     * two session handles on two different sandboxes never cross wires.
     * Framework-free — safe to call from a server-side "Kortix as a
     * Backend" wrapper (Node/Bun), a worker, a CLI, or any non-React host.
     *
     * Handles connect/reconnect/backoff, a 15s heartbeat watchdog, and
     * event coalescing internally. Call `handle.close()` to stop.
     *
     *   const handle = await session.stream({ onEvent: (e) => console.log(e) });
     *   // later
     *   handle.close();
     */
    stream: async (opts: {
      onEvent: (event: RuntimeEvent) => void;
      onGapRehydrate?: (gapMs: number) => void;
      signal?: AbortSignal;
    }): Promise<EventStreamHandle> => {
      const { runtimeUrl } = await ctx.ensureReady();
      return openEventStream({
        url: runtimeUrl,
        onEvent: opts.onEvent,
        onGapRehydrate: opts.onGapRehydrate,
        signal: opts.signal,
      });
    },
  };
}
