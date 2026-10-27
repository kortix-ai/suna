/**
 * Pure helpers for the event log that App events (`type: app`) write — the
 * platform-enforced bounds and the payload/prompt rendering the observer hands
 * to `fireGitTrigger`. The names keep the monitor prefix of the table.
 *
 * Deliberately free of `config`, `db`, and every other side-effecting import
 * (same rule as ./trigger-payload.ts) so the bounds are unit-testable without
 * booting the server environment. The DB halves live in ./monitor-ingest.ts
 * (write path) and ./monitor-observer.ts (drain path).
 */

import {
  MONITOR_INGEST_MAX_EVENTS,
  MONITOR_LINE_MAX_BYTES,
  type MonitorEventKind,
} from '@kortix/api-contract/runtime-relay';

export { MONITOR_INGEST_MAX_EVENTS, MONITOR_LINE_MAX_BYTES, type MonitorEventKind };
/** Sustained event rate per monitor, over a trailing hour. */
export const MONITOR_RATE_SUSTAINED_PER_HOUR = 60;
/** Burst ceiling per monitor, over the trailing {@link MONITOR_BURST_WINDOW_MS}. */
export const MONITOR_RATE_BURST = 30;
export const MONITOR_BURST_WINDOW_MS = 60_000;
export const MONITOR_RATE_WINDOW_MS = 3_600_000;
/** How long a rate breach suppresses the monitor. */
export const MONITOR_SUPPRESSION_MS = 10 * 60_000;
/** Suppression episodes inside {@link MONITOR_SUPPRESSION_WINDOW_MS} that auto-disable. */
export const MONITOR_AUTO_DISABLE_SUPPRESSIONS = 3;
export const MONITOR_SUPPRESSION_WINDOW_MS = 24 * 60 * 60_000;
/**
 * The provenance preamble prepended to EVERY rendered App-event prompt, server
 * side. An event is machine output from the project's own App code, not a human
 * asking for something — the agent has to read it that way, and a template
 * author must not be able to forget to say so.
 */
export const APP_EVENT_PROMPT_PREAMBLE = '[APP EVENT — automated, not user input]\n';

export interface ParsedMonitorEvent {
  slug: string;
  seq: number;
  kind: MonitorEventKind;
  /** Already normalized to an object and truncated to the line bound. */
  line: Record<string, unknown>;
  emittedAt: Date;
}

/**
 * Bound one line at {@link MONITOR_LINE_MAX_BYTES}. An oversize line keeps its
 * head under `raw` and gains a `truncated: true` marker — it is never dropped,
 * and it never rejects the batch it arrived in.
 */
export function truncateMonitorLine(line: Record<string, unknown>): Record<string, unknown> {
  const encoded = JSON.stringify(line);
  if (Buffer.byteLength(encoded, 'utf8') <= MONITOR_LINE_MAX_BYTES) return line;
  // Reserve room for the `{"raw":…,"truncated":true}` envelope itself.
  const budget = MONITOR_LINE_MAX_BYTES - 64;
  const source = typeof line.raw === 'string' ? line.raw : encoded;
  return { raw: truncateToBytes(source, budget), truncated: true };
}

function truncateToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  // Cut on a character boundary: slice by codepoints, then shrink until the
  // encoded form fits (a multi-byte tail can still overshoot).
  let out = value.slice(0, maxBytes);
  while (out.length > 0 && Buffer.byteLength(out, 'utf8') > maxBytes) {
    out = out.slice(
      0,
      Math.max(0, out.length - Math.ceil((Buffer.byteLength(out, 'utf8') - maxBytes) / 2)),
    );
  }
  return out;
}

export interface MonitorRateWindow {
  /** Events already stored for this monitor in the trailing hour, any status. */
  hourCount: number;
  /** Events already stored in the trailing burst window. */
  burstCount: number;
  /** `project_trigger_runtime.suppressed_until` for this monitor. */
  suppressedUntil: Date | null;
}

/**
 * The rate verdict for ONE event. Over-limit events are stored `suppressed`,
 * never dropped: the log is the contract, and "we silently ate your events"
 * is exactly the failure mode monitors exist to remove.
 */
export function monitorRateVerdict(window: MonitorRateWindow, now: Date): 'accept' | 'suppress' {
  if (window.suppressedUntil && window.suppressedUntil.getTime() > now.getTime()) return 'suppress';
  if (window.hourCount >= MONITOR_RATE_SUSTAINED_PER_HOUR) return 'suppress';
  if (window.burstCount >= MONITOR_RATE_BURST) return 'suppress';
  return 'accept';
}

export interface MonitorSuppressionState {
  suppressedUntil: Date;
  suppressionCount: number;
  /** Third episode in 24 h ⇒ the monitor is disabled with a `last_error`. */
  autoDisable: boolean;
  /** False when an episode was already open — nothing to write. */
  opensNewEpisode: boolean;
}

/**
 * Advance the suppression bookkeeping on a rate breach.
 *
 * The episode START is derived from `suppressed_until` minus the suppression
 * window, so the 24 h auto-disable horizon needs no extra column: an episode
 * whose window closed more than 24 h ago restarts the count at 1.
 */
export function nextMonitorSuppression(input: {
  now: Date;
  suppressedUntil: Date | null;
  suppressionCount: number | null;
}): MonitorSuppressionState {
  const nowMs = input.now.getTime();
  const previousUntil = input.suppressedUntil?.getTime() ?? null;
  const currentCount = input.suppressionCount ?? 0;

  if (previousUntil !== null && previousUntil > nowMs) {
    // Already suppressed — the same episode, not a new breach.
    return {
      suppressedUntil: new Date(previousUntil),
      suppressionCount: currentCount,
      autoDisable: false,
      opensNewEpisode: false,
    };
  }

  const previousEpisodeStart =
    previousUntil === null ? null : previousUntil - MONITOR_SUPPRESSION_MS;
  const withinWindow =
    previousEpisodeStart !== null && nowMs - previousEpisodeStart <= MONITOR_SUPPRESSION_WINDOW_MS;
  const suppressionCount = withinWindow ? currentCount + 1 : 1;
  return {
    suppressedUntil: new Date(nowMs + MONITOR_SUPPRESSION_MS),
    suppressionCount,
    autoDisable: suppressionCount >= MONITOR_AUTO_DISABLE_SUPPRESSIONS,
    opensNewEpisode: true,
  };
}

/**
 * The delivery payload of an App event (`type: app`): `event.name`,
 * `event.data`, `event.id` as the App sent them. The `filter` and the prompt
 * template read this shape.
 */
export function buildAppEventPayload(event: {
  slug: string;
  app: string;
  line: Record<string, unknown>;
  emittedAt: Date;
}): Record<string, unknown> {
  return {
    event: { ...event.line, emitted_at: event.emittedAt.toISOString() },
    app: { slug: event.app },
    trigger: { slug: event.slug, type: 'app', kind: 'git' },
  };
}
