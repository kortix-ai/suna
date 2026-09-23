/**
 * The thread's live-update state (COR-144): whether updates stopped arriving,
 * the header's "Last update 6 min ago" line, and Reconnect. The decisions are
 * pure in `lib/opencode/stream-health.ts`; this hook only re-reads the clock
 * while the stream is down, so the relative time and the stall threshold move
 * without a stream event.
 */

import { useEffect, useState } from 'react';
import {
  lastUpdateLabel,
  liveUpdatesView,
  useStreamHealthStore,
} from '@/lib/opencode/stream-health';

/** How often the "… min ago" line and the stall check re-read the clock. */
export const LIVE_UPDATES_TICK_MS = 30_000;

export interface LiveUpdates {
  paused: boolean;
  /** "Last update 6 min ago"; meaningful only while `paused`. */
  statusLabel: string;
  reconnect: () => void;
}

export function useLiveUpdates(): LiveUpdates {
  const health = useStreamHealthStore((state) => state.health);
  const reconnect = useStreamHealthStore((state) => state.reconnect);
  const down = health.phase !== 'connected' && health.phase !== 'idle';
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!down) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), LIVE_UPDATES_TICK_MS);
    return () => clearInterval(timer);
  }, [down]);

  const view = liveUpdatesView(health, now);
  return {
    paused: view.paused,
    statusLabel: lastUpdateLabel(view.lastEventAt, now),
    reconnect,
  };
}
