/**
 * Observability for the provider-migration workflow: Prometheus series (rendered
 * on the shared /metrics endpoint) + structured log events, plus an in-memory
 * snapshot for tests. Every event the spec calls for is emitted here so the
 * cold-fallback rate (which MUST be 0 after a prepared activation) and the
 * time-to-ready quantiles are observable.
 */
import { Counter, Gauge, Histogram, registerMetricRenderer } from '../../lib/metrics';
import { logger } from '../../lib/logger';

const transitionsTotal = new Counter(
  'provider_transitions_total',
  'Provider-migration transitions by event and target provider.',
);
const buildDurationSeconds = new Histogram(
  'provider_transition_build_duration_seconds',
  'Wall-clock duration of the target ppwarm image build, seconds.',
  [5, 15, 30, 60, 120, 300, 600, 1200],
);
const queueDurationSeconds = new Histogram(
  'provider_transition_queue_duration_seconds',
  'Time a transition waited pending before its build started, seconds.',
  [1, 5, 15, 30, 60, 120, 300, 600],
);
const timeToReadySeconds = new Histogram(
  'provider_transition_time_to_ready_seconds',
  'End-to-end request→ready time (feeds p50/p95/p99), seconds.',
  [5, 15, 30, 60, 120, 300, 600, 1200, 2400],
);
const inFlight = new Gauge(
  'provider_transitions_in_flight',
  'Live (non-terminal) provider-migration transitions currently tracked.',
);

registerMetricRenderer(() =>
  [
    transitionsTotal.render(),
    buildDurationSeconds.render(),
    queueDurationSeconds.render(),
    timeToReadySeconds.render(),
    inFlight.render(),
  ].join('\n\n'),
);

export type ProviderTransitionEvent =
  | 'requested'
  | 'build_started'
  | 'existing_image_reused'
  | 'build_succeeded'
  // Healthy async build still in progress (provider `building`) — a heartbeat,
  // NOT a failed attempt (BUILDING ≠ FAILURE).
  | 'build_waiting'
  // Blocked on provider/account capacity (429 / quota) rather than a build fault.
  | 'waiting_for_capacity'
  | 'preparation_failed'
  | 'stale_build_superseded'
  | 'rebuild_new_identity'
  | 'activation_completed'
  | 'activation_lost_cas'
  | 'cancelled'
  | 'first_session_warm_hit'
  | 'first_session_warm_miss'
  | 'cold_fallback'
  // FIX-M1: the prepared warm image covers ONLY the default template, so a
  // project that declares custom (non-default-slug) templates migrates on the
  // default warm image and its custom-template sessions cold-boot on first use
  // after the switch. This makes that (deliberately un-prepared) cold boot
  // visible without blocking the switch on custom templates.
  | 'custom_template_cold_boot';

// Test-visible tallies. Never used to drive control flow — pure observability.
const eventCounts = new Map<string, number>();

export function providerTransitionMetricsSnapshot(): Record<string, number> {
  return Object.fromEntries(eventCounts);
}

export function resetProviderTransitionMetricsForTest(): void {
  eventCounts.clear();
}

function bump(event: ProviderTransitionEvent, target: string): void {
  const key = `${event}:${target}`;
  eventCounts.set(key, (eventCounts.get(key) ?? 0) + 1);
  eventCounts.set(event, (eventCounts.get(event) ?? 0) + 1);
}

export function emitProviderTransitionEvent(
  event: ProviderTransitionEvent,
  fields: {
    target: string;
    source?: string;
    projectId?: string;
    transitionId?: string;
    generation?: number;
    snapshotName?: string;
    externalTemplateId?: string | null;
    attempts?: number;
    error?: string;
    buildSeconds?: number;
    queueSeconds?: number;
    timeToReadySeconds?: number;
  },
): void {
  transitionsTotal.inc({ event, target: fields.target });
  if (typeof fields.buildSeconds === 'number') {
    buildDurationSeconds.observe(fields.buildSeconds, { target: fields.target });
  }
  if (typeof fields.queueSeconds === 'number') {
    queueDurationSeconds.observe(fields.queueSeconds, { target: fields.target });
  }
  if (typeof fields.timeToReadySeconds === 'number') {
    timeToReadySeconds.observe(fields.timeToReadySeconds, { target: fields.target });
  }
  bump(event, fields.target);
  const level = event === 'preparation_failed' || event === 'cold_fallback' ? 'warn' : 'info';
  logger[level](`[provider-transition] ${event}`, {
    event,
    ...fields,
  });
}

export function setProviderTransitionsInFlight(count: number): void {
  inFlight.set(count);
}
