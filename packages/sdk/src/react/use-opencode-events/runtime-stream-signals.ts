/**
 * What a host may observe of the live runtime stream, for its own side effects:
 * a sound or haptic on an event, a "live updates paused" indicator. The SDK has
 * already applied each event to its stores when a subscriber sees it. This is
 * an observer, never a second reducer.
 */
import type { HostSignal } from '../../core/session/host-signals';
import type { RuntimeEvent } from '../../core/stream/event-stream';

export type RuntimeStreamSignal =
  /** One live event, after the SDK applied it. */
  | { type: 'event'; event: RuntimeEvent }
  /** A connection attempt starts. */
  | { type: 'connecting' }
  /** The connection delivered its first frame. */
  | { type: 'open' }
  /** The connection dropped; the SDK reconnects by itself. */
  | { type: 'lost' }
  /** The SDK stopped retrying after consecutive hard failures; it revives on a host signal or a timer. */
  | { type: 'parked' }
  /** No stream is mounted (no runtime, or the view closed). */
  | { type: 'closed' };

const listeners = new Set<(signal: RuntimeStreamSignal) => void>();

/** Observe the live runtime stream. Returns the unsubscribe. */
export function subscribeRuntimeStream(listener: (signal: RuntimeStreamSignal) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** @internal Called by `useRuntimeEventStream` only. */
export function emitRuntimeStreamSignal(signal: RuntimeStreamSignal): void {
  for (const listener of [...listeners]) {
    try {
      listener(signal);
    } catch {
      // A host side effect must not break the stream.
    }
  }
}

/** Silence after which a foreground or online signal earns a fresh connection. */
const STALE_EVIDENCE_MS = 60_000;

/**
 * Whether a host signal opens a fresh connection. A manual retry always does.
 * `visible` and `online` do only when the runtime has been silent for 60 s (or
 * was never heard): a stream that is delivering frames needs no reconnect.
 */
export function shouldReconnectOnHostSignal(
  signal: HostSignal,
  lastRuntimeEvidenceAt: number | null,
  now: number,
): boolean {
  if (signal === 'retry') return true;
  return lastRuntimeEvidenceAt === null || now - lastRuntimeEvidenceAt >= STALE_EVIDENCE_MS;
}
