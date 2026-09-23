'use client';

import dynamic from 'next/dynamic';

/**
 * /debug/session-fixture/bench — render-cost benchmark for the transcript.
 *
 * Seeds a synthetic transcript (`?messages=`, default 100) into the SDK session
 * store and renders it through the same pieces as the parity fixture
 * (`TurnViewport` + `FixtureTurn` → `ThrottledMarkdown` → Streamdown → Shiki),
 * then replays `?deltas=` (default 200) `message.part.delta` events into the
 * last assistant message, one per 16 ms — the sync store's batch cadence.
 *
 * Results land in `window.__sessionBench` and in the `bench-result` block:
 * React commit count and total actual render time (Profiler), long tasks,
 * long animation frames, and the JS heap after the transcript settles.
 * `?autorun=1` starts the replay once the transcript has settled.
 *
 * Synthetic content only. No network, no runtime.
 */
const SessionFixtureBench = dynamic(() => import('./bench').then((m) => m.SessionFixtureBench), {
  ssr: false,
});

export default function SessionFixtureBenchPage() {
  return <SessionFixtureBench />;
}
