/**
 * Lightweight provisioning timeline for benchmarking session boot.
 *
 * Session creation fans out across several detached steps (branch push,
 * snapshot resolve, Daytona create, in-sandbox boot, opencode ready). Until now
 * there was no end-to-end timing, so "new session takes 30s" was unattributable.
 * This records monotonic marks (perf.now) at each step, emits one structured log
 * line, and returns a serializable summary that gets persisted into the sandbox
 * row metadata so the frontend can show the host-side breakdown alongside its
 * own marks.
 *
 * Overhead is negligible (a push + a subtraction per mark) so it's always on.
 */

import { logger } from '../../lib/logger';

export interface TimelineMark {
  label: string;
  /** ms since the timeline started. */
  atMs: number;
  /** ms since the previous mark — the cost of the step that just finished. */
  deltaMs: number;
}

export interface TimelineSummary {
  id: string;
  kind: string;
  totalMs: number;
  marks: TimelineMark[];
}

export class ProvisionTimeline {
  private readonly startedAt: number;
  private last: number;
  private readonly marks: TimelineMark[] = [];

  constructor(
    readonly id: string,
    readonly kind: string = 'session',
  ) {
    this.startedAt = performance.now();
    this.last = this.startedAt;
  }

  /** Record the completion of a step. */
  mark(label: string): void {
    const now = performance.now();
    this.marks.push({
      label,
      atMs: Math.round(now - this.startedAt),
      deltaMs: Math.round(now - this.last),
    });
    this.last = now;
  }

  /**
   * Record a step that finished on a PARALLEL branch (e.g. image resolution,
   * which runs alongside the row insert and token mint). `deltaMs` is measured
   * from the start of the timeline, and the sequential cursor `mark()` uses is
   * left alone, so the main path's deltas stay truthful.
   */
  note(label: string): void {
    const atMs = Math.round(performance.now() - this.startedAt);
    this.marks.push({ label, atMs, deltaMs: atMs });
  }

  get totalMs(): number {
    return Math.round(performance.now() - this.startedAt);
  }

  summary(): TimelineSummary {
    return { id: this.id, kind: this.kind, totalMs: this.totalMs, marks: [...this.marks] };
  }

  /**
   * One-line structured log: `[provision-timeline] <kind> <id> total=Xms a=+deltaMs(@t) ...`.
   * Ships through the api logger — the logger patches only console.error/warn
   * to Better Stack, so the console.log this used kept every timeline line off
   * prod telemetry (0 rows in 8 days, KRTX-471).
   */
  log(extra?: Record<string, unknown>): TimelineSummary {
    const summary = this.summary();
    const parts = summary.marks.map((m) => `${m.label}=+${m.deltaMs}ms(@${m.atMs})`).join(' ');
    logger.info(
      `[provision-timeline] ${this.kind} ${this.id.slice(0, 8)} total=${summary.totalMs}ms ${parts}`,
      extra && Object.keys(extra).length ? extra : undefined,
    );
    return summary;
  }
}

// Surfacing a timeline on the wire (the turn-latency spec (PR #7840) §5) is done via
// `lib/server-timing.ts`'s `recordTurnStageMarks` — the SAME always-on
// `Server-Timing` mechanism `total`/`auth`/`db`/`git`/`http`/`up`/`api` already
// use, not a second header. See `sandbox-proxy/forward/upstream.ts`'s call to
// `recordTurnStageMarks(provisionTimelineSummary.marks)`.
