import { setEventLoopLagSeconds } from '../lib/metrics';

// ─── Event-loop lag monitor → a real liveness signal ─────────────────────────
//
// The /health handlers in http/system.ts answer in <1ms even when the event
// loop is badly degraded. During the 2026-06-18 incident that meant k8s
// liveness NEVER fired and wedged pods were never restarted — a 90-minute
// outage instead of a ~45s self-heal. This samples ACTUAL event-loop lag (a
// healthy loop drifts a few ms; a starved one drifts into seconds) and exposes
// it at /health/live so a degraded-but-not-dead pod can be detected and
// restarted by the kubelet.
//
// NOTE: the chart's livenessProbe still points at the shallow /v1/health by
// default — flip health.livenessPath to /health/live only AFTER an image that
// serves this route is confirmed live (otherwise old pods 404 their liveness
// probe and crash-loop). See infra/k8s/charts/kortix-api.
export let eventLoopLagMs = 0;
let lagTimer: ReturnType<typeof setInterval> | null = null;

/** Every replica (bootstrap.ts startReplicaServices): /health/live reads it. */
export function startEventLoopLagSampler(): void {
  if (lagTimer) return;
  const SAMPLE_INTERVAL_MS = 1000;
  let lastSample = performance.now();
  lagTimer = setInterval(() => {
    const now = performance.now();
    // How much longer than the interval the loop took to come back to this tick.
    eventLoopLagMs = Math.max(0, now - lastSample - SAMPLE_INTERVAL_MS);
    lastSample = now;
    setEventLoopLagSeconds(eventLoopLagMs / 1000);
  }, SAMPLE_INTERVAL_MS);
  // Never keep the process alive just for the sampler.
  lagTimer.unref();
}

export function stopEventLoopLagSampler(): void {
  if (lagTimer) clearInterval(lagTimer);
  lagTimer = null;
}
