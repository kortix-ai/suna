/**
 * The one-line readout under the transcript: what the SESSION is doing.
 *
 * Two regimes, one line:
 *  - booting (`session.phase === 'starting'`): a spinner with the boot stage
 *    in words (`boot-status.ts`) and the elapsed time. `/start` fired when the
 *    session opened, and this is where that shows.
 *  - ready: the agent's turn — "idle", or "working · 12s". `working` is the
 *    SDK's provenance-tagged projection, so the clock starts at
 *    `working.since` — the instant the DECIDING observation was made — not at
 *    whatever moment this component happened to mount.
 *  - error: "not running" — the error banner above it says why.
 *
 * The clock owns its own 1s tick. Nothing else in the transcript re-renders
 * per second, and a spinner's 80ms frame is internal to `<Spinner/>`.
 */

import { useEffect, useRef, useState } from 'react';

import { formatElapsed } from '../../../lib/transcript-view.ts';
import { theme } from '../../../theme.ts';
import { Spinner } from '../../../ui/index.ts';
import { type BootInput, bootStatus } from './boot-status.ts';

export interface WorkingLineProps {
  /** `session.working`. */
  working: { state: 'idle' | 'working'; since: number; pendingDelivery?: true };
  /** `session.isBusy`. */
  isBusy: boolean;
  /** `session.phase`. Omitted means ready, which is what every test session is. */
  phase?: BootInput['phase'];
  /** `session.stage`. */
  stage?: BootInput['stage'];
  /** `session.reason`. */
  reason?: BootInput['reason'];
  /** `session.failure`. */
  failure?: BootInput['failure'];
  /** Test seam for the clock. */
  now?: () => number;
}

export function WorkingLine({
  working,
  isBusy,
  phase = 'ready',
  stage,
  reason,
  failure,
  now = Date.now,
}: WorkingLineProps) {
  const booting = phase === 'starting';
  const active = booting || isBusy || working.state === 'working';
  const [, setTick] = useState(0);
  // When the boot began and when the current stage was first seen: the labels
  // split on time-in-stage, as the web app's do.
  const bootSinceRef = useRef<number | null>(null);
  const stageSinceRef = useRef<{ stage: BootInput['stage']; at: number } | null>(null);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);

  if (!booting) {
    bootSinceRef.current = null;
    stageSinceRef.current = null;
  }

  if (booting) {
    const at = now();
    bootSinceRef.current ??= at;
    if (!stageSinceRef.current || stageSinceRef.current.stage !== stage) {
      stageSinceRef.current = { stage, at };
    }
    const status = bootStatus({
      phase,
      stage,
      reason,
      failure,
      msInStage: at - stageSinceRef.current.at,
      msTotal: at - bootSinceRef.current,
      now: at,
    });
    if (status) {
      const elapsed = formatElapsed(at - bootSinceRef.current);
      return (
        <box flexDirection="column">
          <Spinner label={`${status.label} · ${elapsed}`} />
          {status.note ? (
            <text fg={theme.dim} wrapMode="word">
              {status.note}
            </text>
          ) : null}
        </box>
      );
    }
  }

  if (phase === 'error') return <text fg={theme.danger}>not running</text>;
  if (!active) return <text fg={theme.faint}>idle</text>;

  const elapsed = working.since > 0 ? formatElapsed(now() - working.since) : '0s';
  const what = working.pendingDelivery ? 'queued' : 'working';
  return <Spinner label={`${what} · ${elapsed}`} />;
}
