import type { SessionDisplayStatus } from '@/components/projects/session-label';

/**
 * Craft run reports — STATIC MOCK DATA for the UI/UX phase.
 *
 * Nothing here is fetched. A later phase replaces this module with the real
 * read (project sessions filtered by their craft, via the triggers/session
 * API), keeping the component tree untouched — the shape below is cut so that
 * swap is a data change, not a component change.
 *
 * Framework-free AND catalog-free: no icons, no React, no `Date.now()`. It
 * must stay that way — server components import it (the detail route 404s an
 * unknown craft here), and `crafts-catalog` imports Phosphor icon VALUES,
 * which call `createContext` at module scope and crash an RSC build. The join
 * of a report to its `Craft` therefore lives in `craft-report-entries.ts`,
 * which only client components import.
 *
 * Being `Date.now()`-free also means SSR and the client always agree.
 */

export interface CraftRun {
  /**
   * The project session this run created. The status circle links straight to
   * `/projects/<projectId>/sessions/<sessionId>` — a run IS a session, which is
   * why the report reuses the sidebar's session status glyph verbatim instead
   * of inventing a run-specific vocabulary.
   */
  sessionId: string;
  /**
   * The SAME five-state display status the sidebar paints. Reusing the union
   * (rather than a parallel `RunOutcome`) is deliberate: a user who learns
   * "filled green = live, muted check = done" in the sidebar reads this strip
   * with no new vocabulary.
   */
  status: SessionDisplayStatus;
  /**
   * MOCK: minutes before "now" as a fixed offset, not a timestamp.
   *
   * A real timestamp formatted against `Date.now()` renders one value during
   * SSR and a different one on the client seconds later, which is a hydration
   * mismatch on every row. An offset is deterministic on both sides. The real
   * implementation will carry `started_at` and format it client-side.
   */
  minutesAgo: number;
  /** Wall-clock length in minutes. `null` while the run is still open. */
  durationMin: number | null;
  /** One line: what this run actually delivered. Shown in the dot tooltip and
   *  in the detail page's run list. */
  summary: string;
}

export interface CraftReport {
  craftId: string;
  /**
   * Runs NEWEST FIRST — `runs[0]` is the latest. Strips render them
   * oldest→newest left to right (`craftRunStrip` does the reverse), so the
   * newest circle sits next to the row's relative-time column and the strip
   * reads as a timeline. Every status-history strip in the tools our users
   * already live in (Grafana, Datadog, CI checks) runs that direction.
   */
  runs: CraftRun[];
}

/** Build a run without repeating the id ceremony at every call site. */
const run = (
  craftId: string,
  index: number,
  status: SessionDisplayStatus,
  minutesAgo: number,
  durationMin: number | null,
  summary: string,
): CraftRun => ({
  sessionId: `mock-${craftId}-${String(index).padStart(2, '0')}`,
  status,
  minutesAgo,
  durationMin,
  summary,
});

export const CRAFT_REPORTS: CraftReport[] = [
  {
    craftId: 'standup',
    runs: [
      run('standup', 12, 'running', 4, null, 'Collecting yesterday’s merged PRs.'),
      run('standup', 11, 'done', 1_444, 3, 'Posted standup to #eng — 6 shipped, 2 blocked.'),
      run('standup', 10, 'done', 2_884, 2, 'Posted standup to #eng — 4 shipped, 1 blocked.'),
      run('standup', 9, 'done', 4_324, 3, 'Posted standup to #eng — 9 shipped, 0 blocked.'),
      run('standup', 8, 'failed', 5_764, 1, 'Slack returned 429 — rate limited, nothing posted.'),
      run('standup', 7, 'done', 7_204, 2, 'Posted standup to #eng — 5 shipped, 3 blocked.'),
      run('standup', 6, 'done', 8_644, 3, 'Posted standup to #eng — 7 shipped, 1 blocked.'),
      run('standup', 5, 'done', 11_524, 2, 'Posted standup to #eng — 3 shipped, 0 blocked.'),
      run('standup', 4, 'stopped', 12_964, 1, 'Stopped by hand mid-run.'),
      run('standup', 3, 'done', 14_404, 3, 'Posted standup to #eng — 8 shipped, 2 blocked.'),
      run('standup', 2, 'done', 15_844, 2, 'Posted standup to #eng — 6 shipped, 1 blocked.'),
      run('standup', 1, 'done', 17_284, 3, 'Posted standup to #eng — 4 shipped, 2 blocked.'),
    ],
  },
  {
    craftId: 'error-triage',
    runs: [
      run('error-triage', 14, 'needs-you', 26, 18, 'Opened PR #4182 — awaiting your review.'),
      run('error-triage', 13, 'done', 172, 21, 'Grouped 41 errors into 6 causes, filed 6 issues.'),
      run('error-triage', 12, 'done', 384, 14, 'Grouped 12 errors into 2 causes, filed 2 issues.'),
      run('error-triage', 11, 'failed', 611, 4, 'Sentry token expired — no errors read.'),
      run('error-triage', 10, 'done', 908, 26, 'Grouped 63 errors into 9 causes, opened PR #4171.'),
      run('error-triage', 9, 'done', 1_265, 19, 'Grouped 22 errors into 4 causes, filed 4 issues.'),
      run('error-triage', 8, 'done', 1_622, 16, 'Grouped 9 errors into 2 causes, filed 2 issues.'),
      run(
        'error-triage',
        7,
        'done',
        2_048,
        23,
        'Grouped 38 errors into 7 causes, opened PR #4160.',
      ),
      run('error-triage', 6, 'failed', 2_465, 2, 'Datadog 503 for 5 straight retries.'),
      run('error-triage', 5, 'done', 2_902, 17, 'Grouped 15 errors into 3 causes, filed 3 issues.'),
      run('error-triage', 4, 'done', 3_344, 20, 'Grouped 29 errors into 5 causes, filed 5 issues.'),
      run('error-triage', 3, 'done', 3_781, 15, 'Grouped 7 errors into 1 cause, opened PR #4149.'),
      run('error-triage', 2, 'done', 4_216, 22, 'Grouped 34 errors into 6 causes, filed 6 issues.'),
      run('error-triage', 1, 'done', 4_655, 18, 'Grouped 18 errors into 4 causes, filed 4 issues.'),
    ],
  },
  {
    craftId: 'concierge',
    runs: [
      run('concierge', 9, 'done', 61, 6, 'Sent 14 welcome emails, 0 bounced.'),
      run('concierge', 8, 'done', 1_501, 5, 'Sent 9 welcome emails, 1 bounced.'),
      run('concierge', 7, 'done', 2_941, 7, 'Sent 21 welcome emails, 0 bounced.'),
      run('concierge', 6, 'done', 4_381, 4, 'Sent 6 welcome emails, 0 bounced.'),
      run('concierge', 5, 'done', 5_821, 6, 'Sent 17 welcome emails, 2 bounced.'),
      run('concierge', 4, 'failed', 7_261, 1, 'Resend rejected the sender domain.'),
      run('concierge', 3, 'done', 8_701, 5, 'Sent 11 welcome emails, 0 bounced.'),
      run('concierge', 2, 'done', 10_141, 6, 'Sent 15 welcome emails, 1 bounced.'),
      run('concierge', 1, 'done', 11_581, 5, 'Sent 8 welcome emails, 0 bounced.'),
    ],
  },
  {
    craftId: 'pentest',
    runs: [
      run('pentest', 10, 'needs-you', 188, 47, '2 medium findings filed — awaiting triage.'),
      run('pentest', 9, 'done', 1_628, 52, 'No new findings across 41 checks.'),
      run('pentest', 8, 'done', 3_068, 44, '1 low finding filed as issue #812.'),
      run('pentest', 7, 'done', 4_508, 49, 'No new findings across 41 checks.'),
      run('pentest', 6, 'stopped', 5_948, 12, 'Stopped — staging was mid-deploy.'),
      run('pentest', 5, 'done', 7_388, 51, 'No new findings across 41 checks.'),
      run('pentest', 4, 'done', 8_828, 46, '1 medium finding filed as issue #803.'),
      run('pentest', 3, 'done', 10_268, 48, 'No new findings across 39 checks.'),
      run('pentest', 2, 'failed', 11_708, 3, 'Target origin refused the connection.'),
      run('pentest', 1, 'done', 13_148, 45, 'No new findings across 39 checks.'),
    ],
  },
  {
    craftId: 'deps',
    runs: [
      run('deps', 8, 'done', 402, 31, 'Opened PR #4180 — 11 minors, tests green.'),
      run('deps', 7, 'done', 10_482, 28, 'Opened PR #4166 — 7 minors, tests green.'),
      run('deps', 6, 'failed', 20_562, 9, 'Two suites failed on the upgrade branch.'),
      run('deps', 5, 'done', 30_642, 34, 'Opened PR #4143 — 14 minors, tests green.'),
      run('deps', 4, 'done', 40_722, 26, 'Opened PR #4128 — 5 minors, tests green.'),
      run('deps', 3, 'done', 50_802, 29, 'Opened PR #4111 — 9 minors, tests green.'),
      run('deps', 2, 'done', 60_882, 33, 'Opened PR #4096 — 12 minors, tests green.'),
      run('deps', 1, 'done', 70_962, 27, 'Opened PR #4081 — 6 minors, tests green.'),
    ],
  },
  {
    craftId: 'support',
    runs: [
      run('support', 11, 'done', 34, 3, 'Tagged 8 conversations, drafted 8 replies.'),
      run('support', 10, 'done', 214, 2, 'Tagged 3 conversations, drafted 3 replies.'),
      run('support', 9, 'done', 401, 4, 'Tagged 12 conversations, drafted 11 replies.'),
      run('support', 8, 'done', 596, 3, 'Tagged 5 conversations, drafted 5 replies.'),
      run('support', 7, 'failed', 782, 1, 'Intercom webhook signature mismatch.'),
      run('support', 6, 'done', 968, 3, 'Tagged 7 conversations, drafted 7 replies.'),
      run('support', 5, 'done', 1_154, 2, 'Tagged 4 conversations, drafted 4 replies.'),
      run('support', 4, 'done', 1_341, 4, 'Tagged 10 conversations, drafted 9 replies.'),
      run('support', 3, 'done', 1_528, 3, 'Tagged 6 conversations, drafted 6 replies.'),
      run('support', 2, 'done', 1_714, 2, 'Tagged 2 conversations, drafted 2 replies.'),
      run('support', 1, 'done', 1_902, 3, 'Tagged 9 conversations, drafted 9 replies.'),
    ],
  },
  {
    craftId: 'seo',
    runs: [
      run('seo', 6, 'starting', 1, null, 'Reading Search Console.'),
      run('seo', 5, 'done', 10_081, 24, 'Opened PR #4174 — 9 titles, 4 metas rewritten.'),
      run('seo', 4, 'done', 20_161, 19, 'Opened PR #4157 — 3 titles rewritten.'),
      run('seo', 3, 'done', 30_241, 22, 'Opened PR #4139 — 6 titles, 2 metas rewritten.'),
      run('seo', 2, 'stopped', 40_321, 6, 'Stopped by hand — wrong property selected.'),
      run('seo', 1, 'done', 50_401, 21, 'Opened PR #4104 — 5 titles rewritten.'),
    ],
  },
];

/** Report ids, MOST RECENTLY RUN FIRST. The recency order lives here, beside
 *  the data, so the home panel and the index page cannot disagree about which
 *  five crafts are "most recent". */
export function craftReportsByRecency(): CraftReport[] {
  return CRAFT_REPORTS.filter((report) => report.runs.length > 0)
    .slice()
    .sort((a, b) => (a.runs[0]?.minutesAgo ?? 0) - (b.runs[0]?.minutesAgo ?? 0));
}

/** One report by craft id, or `null` for an unknown id. Catalog-free, so a
 *  server component can use it to decide a 404. */
export function craftReportById(craftId: string): CraftReport | null {
  return CRAFT_REPORTS.find((report) => report.craftId === craftId) ?? null;
}

/**
 * The last `limit` runs in strip order — OLDEST first, so the newest circle
 * lands at the right end, next to the row's relative-time column.
 */
export function craftRunStrip(report: CraftReport, limit: number): CraftRun[] {
  return report.runs.slice(0, limit).slice().reverse();
}

export interface CraftReportStats {
  total: number;
  /** Finished cleanly. `needs-you` is NOT counted here — it is actionable, not done. */
  done: number;
  failed: number;
  /** `done / (done + failed)` as a 0-100 integer, or `null` with no settled run.
   *  Live and stopped runs are excluded from both sides: neither is a verdict. */
  successRate: number | null;
  /** Mean `durationMin` over runs that have one, rounded. `null` if none do. */
  avgDurationMin: number | null;
}

export function craftReportStats(report: CraftReport): CraftReportStats {
  const runs = report.runs;
  const done = runs.filter((item) => item.status === 'done').length;
  const failed = runs.filter((item) => item.status === 'failed').length;
  const settled = done + failed;
  const timed = runs.filter((item) => item.durationMin !== null);
  return {
    total: runs.length,
    done,
    failed,
    successRate: settled === 0 ? null : Math.round((done / settled) * 100),
    avgDurationMin:
      timed.length === 0
        ? null
        : Math.round(timed.reduce((sum, item) => sum + (item.durationMin ?? 0), 0) / timed.length),
  };
}

/**
 * Compact relative label for a run — `now`, `12m`, `3h`, `2d`, `5w`.
 *
 * Deliberately the same vocabulary and the same fixed-width shape as the
 * sidebar's `shortRelative`, so a session reads the same age in both places.
 * Pure over `minutesAgo`, so SSR and the client always agree.
 */
export function agoLabel(minutesAgo: number): string {
  if (minutesAgo < 1) return 'now';
  if (minutesAgo < 60) return `${minutesAgo}m`;
  const hours = Math.round(minutesAgo / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(minutesAgo / 1_440);
  if (days < 7) return `${days}d`;
  const weeks = Math.round(minutesAgo / 10_080);
  if (weeks < 5) return `${weeks}w`;
  return `${Math.round(minutesAgo / 43_800)}mo`;
}

/** `18m` -> `18 min`, `null` -> `—`. Detail-page column, not the strip. */
export function durationLabel(durationMin: number | null): string {
  if (durationMin === null) return '—';
  if (durationMin < 60) return `${durationMin} min`;
  const hours = Math.floor(durationMin / 60);
  const rest = durationMin % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** Where a run's circle navigates: a run IS a session. */
export const craftRunHref = (projectId: string, item: CraftRun): string =>
  `/projects/${projectId}/sessions/${item.sessionId}`;

/** The craft's own report page. */
export const craftReportHref = (projectId: string, craftId: string): string =>
  `/projects/${projectId}/craft-reports/${craftId}`;

/** The index of every craft report in the project. */
export const craftReportsHref = (projectId: string): string =>
  `/projects/${projectId}/craft-reports`;
