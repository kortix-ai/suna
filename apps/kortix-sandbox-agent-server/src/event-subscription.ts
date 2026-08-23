/**
 * Liveness of the daemon's OpenCode `/event` subscription, keyed by the
 * OpenCode URL it is subscribed to.
 *
 * "Live" has to mean "subscribed to the process that is serving NOW". A
 * verified reload (opencode.ts `reloadVerified`) promotes a NEW process on the
 * other half of the port pair and then kills the old one; until the loop
 * notices the drop and re-subscribes, a plain boolean would still read `true`
 * against a stream nobody will ever write to again. Keying by URL makes the
 * promotion itself flip the answer, before the drop is even observed.
 *
 * Consumers: the env route (`/kortix/env`) waits — bounded — for the
 * subscription to be live on the promoted process before it answers 200, so
 * the control plane forwards the prompt it pushed env for only after
 * `session.idle` has somewhere to land. This is the mid-session twin of the
 * boot-time "subscribe before prompt" rule in main.ts.
 */
export interface EventSubscriptionState {
  /** The loop subscribed to `/event` on this OpenCode URL. */
  markLive(url: string): void
  /** The subscription ended (drop, abort, error). */
  markDropped(): void
  /** The URL currently subscribed, or null. */
  liveUrl(): string | null
  isLiveFor(url: string): boolean
  /** Resolves true as soon as the subscription is live for `url`, false on timeout. */
  waitUntilLiveFor(url: string, timeoutMs: number): Promise<boolean>
  /**
   * Monotonic count of successful subscribes. A reload that keeps the process
   * AND the port (`/global/dispose` — verified live 2026-08-23: it emits
   * `server.instance.disposed` and ends every open /event stream) leaves the
   * URL unchanged, so "live for url" alone cannot tell the closing
   * subscription from its replacement. The generation can.
   */
  generation(): number
  /** Resolves true once a subscription NEWER than `sinceGeneration` is live for `url`; false on timeout. */
  waitUntilLiveAfter(sinceGeneration: number, url: string, timeoutMs: number): Promise<boolean>
}

export function createEventSubscriptionState(): EventSubscriptionState {
  let live: string | null = null
  let generation = 0
  const waiters = new Set<() => void>()
  const notify = () => {
    for (const waiter of [...waiters]) waiter()
  }
  const state: EventSubscriptionState = {
    markLive(url) {
      live = url
      generation += 1
      notify()
    },
    markDropped() {
      live = null
    },
    liveUrl: () => live,
    isLiveFor: (url) => live !== null && live === url,
    waitUntilLiveFor(url, timeoutMs) {
      return waitFor(() => state.isLiveFor(url), timeoutMs)
    },
    generation: () => generation,
    waitUntilLiveAfter(sinceGeneration, url, timeoutMs) {
      return waitFor(() => generation > sinceGeneration && state.isLiveFor(url), timeoutMs)
    },
  }
  function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    if (predicate()) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const check = () => {
        if (!predicate()) return
        waiters.delete(check)
        if (timer) clearTimeout(timer)
        resolve(true)
      }
      waiters.add(check)
      timer = setTimeout(() => {
        waiters.delete(check)
        resolve(false)
      }, Math.max(0, timeoutMs))
    })
  }
  return state
}

/** The process-wide state the real event loop and the env route share. */
export const eventSubscription: EventSubscriptionState = createEventSubscriptionState()
