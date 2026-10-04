/**
 * runtime-stream — what this app does around the live session stream.
 *
 * `@kortix/sdk` owns the stream (connect, reconnect, the reducer). The app
 * observes it (`subscribeRuntimeStream`) for two things the SDK does not do:
 * the sound and haptic of a live event (`event-cues.ts`), and the thread's
 * "Live updates paused" state (`live-updates.ts`). It also reports the two
 * facts React Native has no DOM event for: the app is in the foreground again,
 * and the network is back (`notifyHostSignal`).
 *
 * `createStreamSignalBridge` is the pure half (`bun test`).
 */
import type { RuntimeStreamSignal } from '@kortix/sdk/react';
import { createCueTracker, cueForEvent, type CueEvent, type EventCue } from './event-cues';
import type { StreamHealthEvent } from './live-updates';

export interface StreamSignalBridgeDeps {
  dispatch: (event: StreamHealthEvent) => void;
  playCue: (cue: EventCue) => void;
  isForeground: () => boolean;
  now?: () => number;
  /** Run `run` after the current signal burst. Returns the cancel. */
  defer?: (run: () => void) => () => void;
}

const deferToNextTick = (run: () => void) => {
  const timer = setTimeout(run, 0);
  return () => clearTimeout(timer);
};

/** Turns the SDK's stream signals into cues and stream-health events. */
export function createStreamSignalBridge(deps: StreamSignalBridgeDeps): (signal: RuntimeStreamSignal) => void {
  const now = deps.now ?? Date.now;
  const defer = deps.defer ?? deferToNextTick;
  let tracker = createCueTracker();
  /** Last frame received on the stream; null before any. */
  let lastEventAt: number | null = null;
  /** A `closed` that has not been followed by a new connection yet. */
  let cancelStop: (() => void) | null = null;

  return (signal) => {
    const at = now();
    switch (signal.type) {
      case 'event': {
        lastEventAt = at;
        const cue = cueForEvent(tracker, signal.event as CueEvent, { foreground: deps.isForeground() });
        if (cue) deps.playCue(cue);
        return;
      }
      case 'connecting':
        if (cancelStop) {
          // The SDK closed the stream only to open a fresh one (Reconnect, the
          // app back in the foreground): a reconnect, not a stop.
          cancelStop();
          cancelStop = null;
          deps.dispatch({ type: 'lost', at, lastEventAt });
        }
        deps.dispatch({ type: 'connecting', at });
        return;
      case 'open':
        lastEventAt = at;
        deps.dispatch({ type: 'open', at });
        return;
      case 'lost':
        deps.dispatch({ type: 'lost', at, lastEventAt });
        return;
      case 'parked':
        deps.dispatch({ type: 'parked', at, lastEventAt });
        return;
      case 'closed':
        cancelStop?.();
        cancelStop = defer(() => {
          cancelStop = null;
          // No stream is mounted: the next one starts with no turn in flight.
          tracker = createCueTracker();
          lastEventAt = null;
          deps.dispatch({ type: 'stopped' });
        });
        return;
    }
  };
}
