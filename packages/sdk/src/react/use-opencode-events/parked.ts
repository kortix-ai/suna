import { setOpenCodeHealth } from '../../browser/stores/sandbox-connection-store';
import type { EventStreamParkedInfo } from '../../core/stream/event-stream';

/**
 * A parked event stream hands control to the health probe loop.
 *
 * `openEventStream` parks — stops retrying — after N consecutive hard failures
 * on `/event` (a dead sandbox must not be hammered forever). But the stream is
 * opened from an effect keyed on `runtimeHealthy`, and the probe that drives
 * that flag addresses the DAEMON port: OpenCode can crash and restart behind a
 * daemon that answers every probe, so `healthy` never flips and nothing ever
 * re-opens the stream. The transcript then freezes until a hard refresh.
 *
 * So a park is reported as what it is — the browser cannot receive runtime
 * events — by marking the runtime unhealthy. That flips the UI to its
 * reconnecting state, moves the probe to its failing cadence, and the first
 * healthy probe re-runs the effect, which opens a FRESH stream (a parked
 * stream is terminal; see `onParked`). Sandbox `status` is left alone: only
 * the stream is known to be dead.
 */
export function handleEventStreamParked(info: EventStreamParkedInfo): void {
  const lastError =
    info.lastError instanceof Error
      ? info.lastError.message
      : info.lastError == null
        ? null
        : String(info.lastError);
  const reason = `event stream parked after ${info.consecutiveFailures} consecutive failures${
    lastError ? ` (${lastError})` : ''
  }`;
  setOpenCodeHealth(false, undefined, reason);
}
