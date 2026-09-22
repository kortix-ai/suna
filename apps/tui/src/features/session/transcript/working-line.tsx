/**
 * The one-line "the agent is working" readout under the transcript.
 *
 * `working` is the SDK's provenance-tagged projection, so the elapsed clock
 * starts at `working.since` — the instant the DECIDING observation was made —
 * not at whatever moment this component happened to mount.
 *
 * The clock owns its own 1s tick. Nothing else in the transcript re-renders
 * per second, and a spinner's 80ms frame is internal to `<Spinner/>`.
 */

import { useEffect, useState } from 'react';

import { formatElapsed } from '../../../lib/transcript-view.ts';
import { theme } from '../../../theme.ts';
import { Spinner } from '../../../ui/index.ts';

export interface WorkingLineProps {
  /** `session.working`. */
  working: { state: 'idle' | 'working'; since: number; pendingDelivery?: true };
  /** `session.isBusy`. */
  isBusy: boolean;
}

export function WorkingLine({ working, isBusy }: WorkingLineProps) {
  const active = isBusy || working.state === 'working';
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);

  if (!active) return <text fg={theme.faint}>idle</text>;

  const elapsed = working.since > 0 ? formatElapsed(Date.now() - working.since) : '0s';
  const what = working.pendingDelivery ? 'queued' : 'working';
  return <Spinner label={`${what} · ${elapsed}`} />;
}
