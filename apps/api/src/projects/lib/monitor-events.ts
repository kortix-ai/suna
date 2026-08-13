/**
 * Pure helpers for the monitor event log — the ingest contract, the
 * platform-enforced bounds, and the payload/prompt rendering the observer
 * hands to `fireGitTrigger`.
 *
 * Deliberately free of `config`, `db`, and every other side-effecting import
 * (same rule as ./trigger-payload.ts) so the bounds are unit-testable without
 * booting the server environment. The DB halves live in ./monitor-ingest.ts
 * (write path) and ./monitor-observer.ts (drain path).
 *
 * Spec: docs/specs/2026-08-12-monitors.md §"Bounds (platform-enforced)".
 */
import type { GitTriggerSpec } from '../triggers';
import { isPlainPayloadObject, templateValue } from './trigger-payload';

/** Longest ingest batch one POST may carry (the runner batches on 200 ms). */
export const MONITOR_INGEST_MAX_EVENTS = 50;
/** Longest serialized line the log stores; longer lines truncate with a marker. */
export const MONITOR_LINE_MAX_BYTES = 8 * 1024;
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
/** Longest `box_epoch` the log stores (varchar(64)). */
export const MONITOR_BOX_EPOCH_MAX_LENGTH = 64;

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/**
 * The provenance preamble prepended to EVERY rendered monitor prompt, server
 * side. A monitor line is machine output from the project's own repo code, not
 * a human asking for something — the agent has to read it that way, and a
 * template author must not be able to forget to say so.
 */
export const MONITOR_PROMPT_PREAMBLE = '[MONITOR EVENT — automated, not user input]\n';

export type MonitorEventKind = 'event' | 'lifecycle';

export interface ParsedMonitorEvent {
  slug: string;
  seq: number;
  kind: MonitorEventKind;
  /** Already normalized to an object and truncated to the line bound. */
  line: Record<string, unknown>;
  emittedAt: Date;
}

export interface ParsedMonitorIngest {
  boxEpoch: string;
  events: ParsedMonitorEvent[];
}

/**
 * A line is stored as a jsonb object. The runner sends the parsed JSON when
 * the line parses and `{ raw: "<line>" }` when it does not; anything else that
 * reaches here is coerced rather than rejected — one odd line must never cost
 * the batch.
 */
export function normalizeMonitorLine(value: unknown): Record<string, unknown> {
  if (isPlainPayloadObject(value)) return value;
  if (typeof value === 'string') return { raw: value };
  return { raw: templateValue(value) };
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

/**
 * Parse + validate an ingest body. Returns a plain error string so the route
 * can shape its own 400 — a malformed batch is the runner's bug, not a
 * partially-acceptable payload.
 */
export function parseMonitorIngestBody(raw: unknown): ParsedMonitorIngest | { error: string } {
  if (!isPlainPayloadObject(raw)) return { error: 'body must be an object' };

  const boxEpoch = typeof raw.box_epoch === 'string' ? raw.box_epoch.trim() : '';
  if (!boxEpoch) return { error: 'box_epoch is required' };
  if (boxEpoch.length > MONITOR_BOX_EPOCH_MAX_LENGTH) {
    return { error: `box_epoch must be at most ${MONITOR_BOX_EPOCH_MAX_LENGTH} characters` };
  }

  if (!Array.isArray(raw.events)) return { error: 'events must be an array' };
  if (raw.events.length === 0) return { error: 'events must not be empty' };
  if (raw.events.length > MONITOR_INGEST_MAX_EVENTS) {
    return { error: `events must contain at most ${MONITOR_INGEST_MAX_EVENTS} entries` };
  }

  const events: ParsedMonitorEvent[] = [];
  for (const [index, entry] of raw.events.entries()) {
    if (!isPlainPayloadObject(entry)) return { error: `events[${index}] must be an object` };

    const slug = typeof entry.slug === 'string' ? entry.slug.trim() : '';
    if (!SLUG_RE.test(slug)) return { error: `events[${index}].slug is not a valid slug` };

    const seq = typeof entry.seq === 'number' ? entry.seq : Number.NaN;
    if (!Number.isSafeInteger(seq) || seq < 0) {
      return { error: `events[${index}].seq must be a non-negative integer` };
    }

    const kind = entry.kind === 'lifecycle' ? 'lifecycle' : entry.kind === 'event' ? 'event' : null;
    if (!kind) return { error: `events[${index}].kind must be "event" or "lifecycle"` };

    const emittedAtRaw = typeof entry.emitted_at === 'string' ? entry.emitted_at.trim() : '';
    const emittedAtMs = Date.parse(emittedAtRaw);
    if (!emittedAtRaw || Number.isNaN(emittedAtMs)) {
      return { error: `events[${index}].emitted_at must be an ISO-8601 datetime` };
    }
    if (entry.line === undefined) return { error: `events[${index}].line is required` };

    events.push({
      slug,
      seq,
      kind,
      line: truncateMonitorLine(normalizeMonitorLine(entry.line)),
      emittedAt: new Date(emittedAtMs),
    });
  }
  return { boxEpoch, events };
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
 * The delivery payload a monitor fire renders against — the same shape the
 * `filter` and the prompt template both read.
 * Spec: docs/specs/2026-08-12-monitors.md §"Event payload".
 */
export function buildMonitorPayload(event: {
  slug: string;
  seq: number;
  kind: MonitorEventKind;
  line: Record<string, unknown>;
  emittedAt: Date;
}): Record<string, unknown> {
  return {
    line: event.line,
    monitor: {
      slug: event.slug,
      seq: event.seq,
      emitted_at: event.emittedAt.toISOString(),
      kind: event.kind,
    },
    trigger: { slug: event.slug, type: 'monitor', kind: 'git' },
  };
}

/**
 * The platform-rendered prompt for a `lifecycle` event.
 *
 * Lifecycle events do NOT use the author's template: a monitor that died must
 * produce a legible "your monitor died" turn even when the template only knows
 * how to format a healthy line. They also bypass the author's `filter` —
 * silence must not be filterable by accident.
 */
export function renderMonitorLifecyclePrompt(
  spec: Pick<GitTriggerSpec, 'slug' | 'name' | 'run'>,
  line: Record<string, unknown>,
): string {
  const event = typeof line.event === 'string' ? line.event : 'unknown';
  const detail = typeof line.detail === 'string' && line.detail.trim() ? line.detail.trim() : null;
  const command = spec.run ? `\`${spec.run}\`` : 'its command';
  const what: Record<string, string> = {
    exited: `The monitor process exited. ${command} is no longer running, so this monitor is producing no events.`,
    restart_budget_exhausted: `The monitor exhausted its restart budget: ${command} kept failing on restart, so the platform stopped restarting it and moved to slow retries.`,
    silent: `The monitor produced no event inside its \`expect_event_within\` window. ${command} is running but silent, which usually means the source it watches is stalled — or the monitor is.`,
    suppressed: `The monitor breached its event-rate bound and is suppressed. Events are still logged but no longer fire sessions until the suppression window ends.`,
    budget_exceeded: `The project's monitor box was STOPPED because this month's monitor compute budget is spent. No monitor in this project is running until the budget is raised or the billing month rolls over.`,
  };
  const lines = [
    `Monitor "${spec.name}" (${spec.slug}) reported a lifecycle event: ${event}.`,
    what[event] ?? `The platform reported "${event}" for this monitor.`,
  ];
  if (detail) lines.push(`Detail: ${detail}`);
  lines.push(
    'Investigate the monitor command in the repo, fix the cause, and ship the fix. Do not assume the source it watches is healthy — nothing is watching it right now.',
  );
  return lines.join('\n\n');
}
