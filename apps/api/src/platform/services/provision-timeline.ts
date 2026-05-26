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

  get totalMs(): number {
    return Math.round(performance.now() - this.startedAt);
  }

  summary(): TimelineSummary {
    return { id: this.id, kind: this.kind, totalMs: this.totalMs, marks: [...this.marks] };
  }

  /** One-line structured log: `[provision-timeline] <kind> <id> total=Xms a=+deltaMs(@t) ...`. */
  log(extra?: Record<string, unknown>): TimelineSummary {
    const summary = this.summary();
    const parts = summary.marks.map((m) => `${m.label}=+${m.deltaMs}ms(@${m.atMs})`).join(' ');
    console.log(
      `[provision-timeline] ${this.kind} ${this.id.slice(0, 8)} total=${summary.totalMs}ms ${parts}`,
      extra && Object.keys(extra).length ? extra : '',
    );
    return summary;
  }
}
