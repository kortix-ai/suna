/**
 * A per-process budget for audit rows that carry no principal.
 *
 * Every request is audited, including ones nobody authenticated. Those rows
 * matter — a burst of 401s is what a credential-stuffing attempt looks like —
 * but they are also the one class an outsider can generate at will. The audit
 * queue is bounded and drops the OLDEST rows on overflow, so without a budget
 * an unauthenticated flood would evict real, attributed rows: log flooding to
 * hide tracks.
 *
 * So anonymous rows get their own budget. Up to `perSecond` are written as
 * they arrive. The rest are counted, never silently lost: one summary row per
 * `summaryEveryMs` states how many were suppressed and their status classes.
 * An anonymous row that resolved to an account through the project in its
 * URL is still anonymous and still budgeted. Attributed rows never pass
 * through this budget.
 */

export interface AnonymousAuditSummary {
  windowStartMs: number;
  windowEndMs: number;
  suppressed: number;
  byStatusClass: Record<string, number>;
}

export interface AnonymousAuditDecision {
  admit: boolean;
  /** A summary of suppressed rows that is due now. Write it alongside. */
  summary?: AnonymousAuditSummary;
}

export interface AnonymousAuditBudgetOptions {
  perSecond: number;
  summaryEveryMs: number;
}

const DEFAULT_PER_SECOND = 50;

function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

export class AnonymousAuditBudget {
  private secondStartMs = Number.NEGATIVE_INFINITY;
  private admittedThisSecond = 0;
  private summaryStartMs: number | null = null;
  private suppressed = 0;
  private byStatusClass: Record<string, number> = {};

  constructor(private readonly options: AnonymousAuditBudgetOptions) {}

  static perSecondFromEnv(value: string | undefined): number {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PER_SECOND;
  }

  admit(nowMs: number, status: number): AnonymousAuditDecision {
    const summary = this.dueSummary(nowMs);
    if (nowMs - this.secondStartMs >= 1_000) {
      this.secondStartMs = nowMs - (nowMs % 1_000);
      this.admittedThisSecond = 0;
    }
    if (this.admittedThisSecond < this.options.perSecond) {
      this.admittedThisSecond += 1;
      return summary ? { admit: true, summary } : { admit: true };
    }
    if (this.summaryStartMs === null) this.summaryStartMs = nowMs;
    this.suppressed += 1;
    const key = statusClass(status);
    this.byStatusClass[key] = (this.byStatusClass[key] ?? 0) + 1;
    return summary ? { admit: false, summary } : { admit: false };
  }

  /** Release whatever is pending regardless of the window. Shutdown path. */
  drainSummary(nowMs: number): AnonymousAuditSummary | undefined {
    if (this.suppressed === 0 || this.summaryStartMs === null) return undefined;
    return this.release(nowMs);
  }

  private dueSummary(nowMs: number): AnonymousAuditSummary | undefined {
    if (this.suppressed === 0 || this.summaryStartMs === null) return undefined;
    if (nowMs - this.summaryStartMs < this.options.summaryEveryMs) return undefined;
    return this.release(nowMs);
  }

  private release(nowMs: number): AnonymousAuditSummary {
    const summary: AnonymousAuditSummary = {
      windowStartMs: this.summaryStartMs as number,
      windowEndMs: nowMs,
      suppressed: this.suppressed,
      byStatusClass: this.byStatusClass,
    };
    this.summaryStartMs = null;
    this.suppressed = 0;
    this.byStatusClass = {};
    return summary;
  }
}
