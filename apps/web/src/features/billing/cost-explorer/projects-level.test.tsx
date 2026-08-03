import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { CostSummary, ProjectCostPage, ProjectCostSort } from '@kortix/sdk';

import { TooltipProvider } from '@/components/ui/tooltip';

import { CostExportButton } from './cost-export-button';
import { CostSortHeader } from './cost-sort-header';
import { collectElementsByType } from './react-element-tree';
import {
  applyProjectSort,
  buildProjectsLevelExportFilters,
  buildProjectTableRows,
  hasRecentSpendSignal,
  isProjectRowClickable,
  nextProjectSort,
  ProjectsLevelContent,
  projectSortDirection,
  type ProjectTableRow,
} from './projects-level';

const baseRange = { preset: '30d' as const, from: '2026-07-01T00:00:00.000Z', to: '2026-07-31T00:00:00.000Z' };

function summaryWithTotal(total_cost: number): CostSummary {
  return {
    totals: {
      llm_cost: 0,
      compute_cost: 0,
      total_cost,
      request_count: 0,
      compute_seconds: 0,
      session_count: 0,
      project_count: 0,
    },
    previous: { total_cost: 0 },
    series: [],
    models: [],
  };
}

// ── Pure function: buildProjectTableRows ────────────────────────────────────
// This is the load-bearing arithmetic the whole task exists to deliver — the
// footer must reconcile with the account total. Every guard gets its own
// test, and the mutation checks (see task report) confirm each one is
// actually load-bearing by deleting it and watching a test fail.

describe('buildProjectTableRows', () => {
  test('appends unassigned spend as a row so the footer reconciles', () => {
    const rows = buildProjectTableRows(
      {
        projects: [
          {
            project_id: 'p1',
            project_name: 'Main',
            session_count: 2,
            llm_cost: 1,
            compute_cost: 1,
            total_cost: 2,
            last_activity_at: null,
          },
        ],
        total: 1,
        limit: 25,
        offset: 0,
        next_offset: null,
      },
      summaryWithTotal(670.35),
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ project_id: null, project_name: 'Unassigned', total_cost: 668.35 });
  });

  test('omits the unassigned row when everything is attributed', () => {
    const rows = buildProjectTableRows(
      {
        projects: [
          {
            project_id: 'p1',
            project_name: 'Main',
            session_count: 2,
            llm_cost: 1,
            compute_cost: 1,
            total_cost: 2,
            last_activity_at: null,
          },
        ],
        total: 1,
        limit: 25,
        offset: 0,
        next_offset: null,
      },
      summaryWithTotal(2),
    );
    expect(rows).toHaveLength(1);
  });

  test('never emits a negative unassigned row', () => {
    const rows = buildProjectTableRows(
      {
        projects: [
          {
            project_id: 'p1',
            project_name: 'Main',
            session_count: 1,
            llm_cost: 5,
            compute_cost: 0,
            total_cost: 5,
            last_activity_at: null,
          },
        ],
        total: 1,
        limit: 25,
        offset: 0,
        next_offset: null,
      },
      summaryWithTotal(4),
    );
    expect(rows).toHaveLength(1);
  });

  // Guard 1 (completeness), case A: a page after the first. It is a subset of
  // `projects`, so subtracting it from the account total yields "everything
  // not on this page", which is not a quantity the user has a name for. This
  // must hold even when the raw difference would be positive if the guard
  // were ignored. Pinned as pre-existing behavior — the guard that produces
  // it changed from `offset > 0` to `projects.length !== total`, the outcome
  // here did not (1 project rendered, total 40).
  test('omits the unassigned row on any page after the first, even though the raw difference is positive', () => {
    const rows = buildProjectTableRows(
      {
        projects: [
          {
            project_id: 'p26',
            project_name: 'Page 2 project',
            session_count: 1,
            llm_cost: 1,
            compute_cost: 1,
            total_cost: 2,
            last_activity_at: null,
          },
        ],
        total: 40,
        limit: 25,
        offset: 25,
        next_offset: null,
      },
      summaryWithTotal(670.35),
    );
    expect(rows).toHaveLength(1);
  });

  // Guard 1 (completeness), case B: the FIRST page, when it is shorter than
  // the whole result. This is the case that shipped broken — the guard used
  // to read `offset > 0`, which a short first page satisfies, so the
  // subtraction ran against 25 of 40 projects and rendered the other 15
  // projects' spend ($0.34425 on the seed account) under the "Unassigned"
  // label.
  //
  // Why 208 passing tests never saw it, stated correctly: it is NOT that no
  // fixture had this shape. The pagination test below (`total: 30, offset: 0`
  // over `twoProjectPage`) is exactly `projects.length < total` at
  // `offset === 0`. It stayed green because it goes through
  // `baseContentProps`, which defaults `summary: undefined`, so the `!summary`
  // half of the guard returns before the subtraction is ever reached. The
  // broken shape was fixtured; it was never fixtured together with a summary.
  // Hence this test supplies both.
  test('omits the unassigned row on a first page that is shorter than the whole result', () => {
    const rows = buildProjectTableRows(
      {
        projects: [
          {
            project_id: 'p1',
            project_name: 'Main',
            session_count: 2,
            llm_cost: 1,
            compute_cost: 1,
            total_cost: 2,
            last_activity_at: null,
          },
        ],
        total: 40,
        limit: 25,
        offset: 0,
        next_offset: 25,
      },
      summaryWithTotal(670.35),
    );
    expect(rows).toHaveLength(1);
    expect(rows.some((row) => row.project_id === null)).toBe(false);
  });

  // The positive half of the same guard: a single page that holds every
  // project in the result is the one shape where the subtraction is
  // meaningful, and there the row must still appear with the exact figure.
  // `next_offset: null` and `projects.length === total` together are what
  // "this page is the whole result" looks like on the wire.
  test('appends the unassigned row when one page holds every project in the result', () => {
    const rows = buildProjectTableRows(
      {
        projects: [
          {
            project_id: 'p1',
            project_name: 'Alpha',
            session_count: 2,
            llm_cost: 4,
            compute_cost: 1,
            total_cost: 5,
            last_activity_at: null,
          },
          {
            project_id: 'p2',
            project_name: 'Beta',
            session_count: 1,
            llm_cost: 2,
            compute_cost: 0.5,
            total_cost: 2.5,
            last_activity_at: null,
          },
        ],
        total: 2,
        limit: 25,
        offset: 0,
        next_offset: null,
      },
      summaryWithTotal(9),
    );
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ project_id: null, project_name: 'Unassigned', total_cost: 1.5 });
  });

  test('omits the unassigned row entirely when the summary has not loaded yet', () => {
    const rows = buildProjectTableRows(
      {
        projects: [
          {
            project_id: 'p1',
            project_name: 'Main',
            session_count: 1,
            llm_cost: 1,
            compute_cost: 1,
            total_cost: 2,
            last_activity_at: null,
          },
        ],
        total: 1,
        limit: 25,
        offset: 0,
        next_offset: null,
      },
      undefined,
    );
    expect(rows).toHaveLength(1);
  });

  // Exact arithmetic, including the float-noise case (0.1 + 0.2 !== 0.3 in
  // IEEE 754). Without the `.toFixed(10)` normalization in the
  // implementation, this would compute 0.6999999999999998, not 0.7.
  test('normalizes floating-point noise in the subtraction', () => {
    const rows = buildProjectTableRows(
      {
        projects: [
          {
            project_id: 'p1',
            project_name: 'A',
            session_count: 1,
            llm_cost: 0.1,
            compute_cost: 0,
            total_cost: 0.1,
            last_activity_at: null,
          },
          {
            project_id: 'p2',
            project_name: 'B',
            session_count: 1,
            llm_cost: 0.2,
            compute_cost: 0,
            total_cost: 0.2,
            last_activity_at: null,
          },
        ],
        total: 2,
        limit: 25,
        offset: 0,
        next_offset: null,
      },
      summaryWithTotal(1),
    );
    expect(rows).toHaveLength(3);
    expect(rows[2].total_cost).toBe(0.7);
  });

  test('the unassigned row carries zeroed session/llm/compute fields — only total_cost is real', () => {
    const rows = buildProjectTableRows(
      {
        projects: [
          {
            project_id: 'p1',
            project_name: 'Main',
            session_count: 2,
            llm_cost: 1,
            compute_cost: 1,
            total_cost: 2,
            last_activity_at: null,
          },
        ],
        total: 1,
        limit: 25,
        offset: 0,
        next_offset: null,
      },
      summaryWithTotal(670.35),
    );
    expect(rows[1]).toEqual({
      project_id: null,
      project_name: 'Unassigned',
      session_count: 0,
      llm_cost: 0,
      compute_cost: 0,
      total_cost: 668.35,
      last_activity_at: null,
    });
  });

  // Boundary cases right at the tolerance threshold, nearer to zero than the
  // existing -1 and 0.1+0.2 cases — the guard is `<=`, so the exact
  // threshold value itself must still be omitted.
  test('omits the unassigned row when the difference is exactly at the tolerance boundary (0.005)', () => {
    const rows = buildProjectTableRows(
      {
        projects: [
          {
            project_id: 'p1',
            project_name: 'Main',
            session_count: 1,
            llm_cost: 100,
            compute_cost: 0,
            total_cost: 100,
            last_activity_at: null,
          },
        ],
        total: 1,
        limit: 25,
        offset: 0,
        next_offset: null,
      },
      summaryWithTotal(100.005),
    );
    expect(rows).toHaveLength(1);
  });

  test('includes the unassigned row just above the tolerance boundary (0.006)', () => {
    const rows = buildProjectTableRows(
      {
        projects: [
          {
            project_id: 'p1',
            project_name: 'Main',
            session_count: 1,
            llm_cost: 100,
            compute_cost: 0,
            total_cost: 100,
            last_activity_at: null,
          },
        ],
        total: 1,
        limit: 25,
        offset: 0,
        next_offset: null,
      },
      summaryWithTotal(100.006),
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]!.total_cost).toBe(0.006);
  });
});

// ── Sorting: the pure half ─────────────────────────────────────────────────
//
// `renderToStaticMarkup` cannot fire a click, so the effect of a header click
// is asserted here — on the functions the handler calls — rather than through
// the DOM. Each one is the single place its rule lives, which is what makes a
// mutation to it produce a NAMED failure rather than a diffuse one.

describe('nextProjectSort', () => {
  // Total toggles. Both directions are real questions ("what is eating the
  // budget", "what is nearly free") and the route serves both.
  test('Total toggles between the two directions the route accepts', () => {
    expect(nextProjectSort('total_desc', 'total')).toBe('total_asc');
    expect(nextProjectSort('total_asc', 'total')).toBe('total_desc');
  });

  test('a first click on Total lands on descending, from any other sort', () => {
    expect(nextProjectSort('name_asc', 'total')).toBe('total_desc');
    expect(nextProjectSort('recent', 'total')).toBe('total_desc');
  });

  // Project does NOT toggle. `GET /usage/cost-by-project` accepts `name_asc`
  // and has no `name_desc` (PROJECT_COST_SORTS, usage.ts:281), so a two-way
  // toggle would either send a token the route rejects or claim a direction it
  // is not applying. Clicking an already-ascending Project header is a no-op,
  // deliberately.
  test('Project is one-way — a repeat click never asks for a name_desc the API has no token for', () => {
    expect(nextProjectSort('total_desc', 'name')).toBe('name_asc');
    expect(nextProjectSort('name_asc', 'name')).toBe('name_asc');
  });

  // Whatever a click produces has to be a sort the route actually parses;
  // anything else is a 400 or a silently ignored parameter.
  test('every reachable result is a sort the route accepts', () => {
    const accepted: ProjectCostSort[] = ['total_desc', 'total_asc', 'recent', 'name_asc'];
    for (const active of accepted) {
      for (const column of ['name', 'total'] as const) {
        expect(accepted).toContain(nextProjectSort(active, column));
      }
    }
  });
});

describe('projectSortDirection', () => {
  test('reports the active column and nothing else', () => {
    expect(projectSortDirection('total_desc', 'total')).toBe('descending');
    expect(projectSortDirection('total_desc', 'name')).toBeUndefined();

    expect(projectSortDirection('total_asc', 'total')).toBe('ascending');
    expect(projectSortDirection('total_asc', 'name')).toBeUndefined();

    expect(projectSortDirection('name_asc', 'name')).toBe('ascending');
    expect(projectSortDirection('name_asc', 'total')).toBeUndefined();
  });

  // `recent` is a sort the route accepts but no header offers. No column may
  // claim it — a Total header reading "descending" under a date ordering
  // would be a lie about what the table is showing.
  test('claims nothing under a sort no header offers', () => {
    expect(projectSortDirection('recent', 'total')).toBeUndefined();
    expect(projectSortDirection('recent', 'name')).toBeUndefined();
  });

  // Undefined, never 'none'. `aria-sort="none"` on the other columns would
  // announce them as participating in the ordering.
  test('never returns the string "none"', () => {
    const columns = ['name', 'total'] as const;
    const sorts: ProjectCostSort[] = ['total_desc', 'total_asc', 'recent', 'name_asc'];
    for (const sort of sorts) {
      for (const column of columns) {
        expect(projectSortDirection(sort, column)).not.toBe('none');
      }
    }
  });
});

// ── The page reset — this is the mutation target ───────────────────────────
//
// An offset is an index into an ORDERED result, so it means something
// different under a different order. Re-sorting on page 2 of 40 projects
// without resetting drops the reader into the middle of a list whose start
// they have not seen, under a heading that just said the order changed.
//
// `applyProjectSort` is the only path that changes this level's sort, so the
// reset lives in exactly one place. Mutating its `offset: 0` back to
// `state.offset` must fail the named test below.

describe('applyProjectSort', () => {
  test('resets to page 1 — a mid-list offset does not survive a sort change', () => {
    expect(applyProjectSort({ sort: 'total_desc', offset: 50 }, 'total')).toEqual({
      sort: 'total_asc',
      offset: 0,
    });
  });

  test('resets to page 1 on the Project column too, not just Total', () => {
    expect(applyProjectSort({ sort: 'total_desc', offset: 25 }, 'name')).toEqual({
      sort: 'name_asc',
      offset: 0,
    });
  });

  // Even a click that does not change the sort resets the page. `name_asc` is
  // one-way, so clicking Project twice leaves the order alone — but the reader
  // still asked for "sort by name", and answering that from page 3 is the same
  // disorientation.
  test('resets the page even when the sort itself does not change', () => {
    expect(applyProjectSort({ sort: 'name_asc', offset: 75 }, 'name')).toEqual({
      sort: 'name_asc',
      offset: 0,
    });
  });

  test('carries the sort `nextProjectSort` chose, rather than deciding again', () => {
    const sorts: ProjectCostSort[] = ['total_desc', 'total_asc', 'recent', 'name_asc'];
    for (const sort of sorts) {
      for (const column of ['name', 'total'] as const) {
        expect(applyProjectSort({ sort, offset: 25 }, column).sort).toBe(
          nextProjectSort(sort, column),
        );
      }
    }
  });
});

// ── The CSV export follows the active sort ─────────────────────────────────
//
// This was a fixed `total_desc` literal shared between the query and the
// export. Once the headers can re-sort, a constant means the file is ordered
// differently from the table it was taken from — silently, since a CSV carries
// no indication of what produced it.

describe('buildProjectsLevelExportFilters', () => {
  test('sends whichever sort is active, not a fixed default', () => {
    expect(buildProjectsLevelExportFilters('name_asc')).toEqual({ sort: 'name_asc' });
    expect(buildProjectsLevelExportFilters('total_asc')).toEqual({ sort: 'total_asc' });
    expect(buildProjectsLevelExportFilters('total_desc')).toEqual({ sort: 'total_desc' });
  });

  // `format=csv` hardcodes `limit: CSV_ROW_CAP, offset: 0` on the route, so a
  // page could not narrow an export even if one were sent. Pinned so nobody
  // starts forwarding the offset in the belief that it does something.
  test('carries no page — an export is the whole filtered query', () => {
    const filters = buildProjectsLevelExportFilters('total_desc');
    expect(filters).not.toHaveProperty('offset');
    expect(filters).not.toHaveProperty('limit');
  });
});

// ── Pure function: isProjectRowClickable ────────────────────────────────────

describe('isProjectRowClickable', () => {
  test('a row with a real project_id is clickable', () => {
    const row: ProjectTableRow = {
      project_id: 'p1',
      project_name: 'Main',
      session_count: 1,
      llm_cost: 1,
      compute_cost: 1,
      total_cost: 2,
      last_activity_at: null,
    };
    expect(isProjectRowClickable(row)).toBe(true);
  });

  test('the unassigned row (project_id: null) is not clickable', () => {
    const row: ProjectTableRow = {
      project_id: null,
      project_name: 'Unassigned',
      session_count: 0,
      llm_cost: 0,
      compute_cost: 0,
      total_cost: 668.35,
      last_activity_at: null,
    };
    expect(isProjectRowClickable(row)).toBe(false);
  });
});

// ── Pure function: hasRecentSpendSignal ─────────────────────────────────────
// A data question, not a UI-state proxy. Directly encodes the two false
// results the range-preset heuristic produced before this fix:
//   1. genuine history, but the *current* window is quiet — must not read
//      "no spend recorded yet" just because `previous.total_cost` is real.
//   2. a brand-new account looking at a non-default window — must not read
//      "no spend in this range" (and offer a dead-end reset) just because
//      neither figure is real.

describe('hasRecentSpendSignal', () => {
  test('no summary yet — no signal', () => {
    expect(hasRecentSpendSignal(undefined)).toBe(false);
  });

  test('both totals zero — no signal (a genuinely new account)', () => {
    expect(hasRecentSpendSignal(summaryWithTotal(0))).toBe(false);
  });

  test('the current window has spend — signal', () => {
    expect(hasRecentSpendSignal(summaryWithTotal(12.5))).toBe(true);
  });

  test('the current window is quiet but the previous window had spend — signal', () => {
    const summary: CostSummary = { ...summaryWithTotal(0), previous: { total_cost: 42 } };
    expect(hasRecentSpendSignal(summary)).toBe(true);
  });

  test('both windows have spend — signal', () => {
    const summary: CostSummary = { ...summaryWithTotal(5), previous: { total_cost: 5 } };
    expect(hasRecentSpendSignal(summary)).toBe(true);
  });
});

// ── Component: ProjectsLevelContent ─────────────────────────────────────────
// Presentational only — mirrors the SessionCostExplorerContent /
// SessionCostExplorer split in session-cost-explorer.tsx, so the whole
// render contract is testable with plain props and renderToStaticMarkup,
// with no react-query or Supabase wiring needed.
//
// `TooltipProvider` is supplied here, in the test harness — not inside the
// shipped component. The real app tree already has exactly one, at the
// root layout (`app/layout.tsx`, wrapping `children`), which is where
// `ProjectsLevel` actually mounts; a second one in this component would be
// redundant there. It is only `renderToStaticMarkup`'s isolation — no
// ancestor tree at all — that needs one supplied for `Hint` to not throw.

const noop = () => {};

function baseContentProps(overrides: Partial<Parameters<typeof ProjectsLevelContent>[0]> = {}) {
  return {
    range: baseRange,
    onRangeChange: noop,
    onResetRange: noop,
    summary: undefined,
    isSummaryLoading: false,
    summaryError: null,
    page: undefined,
    isProjectsLoading: false,
    projectsError: null,
    sort: 'total_desc' as const,
    onSort: noop,
    onSelectProject: noop,
    onPreviousPage: noop,
    onNextPage: noop,
    ...overrides,
  };
}

function renderContent(overrides: Partial<Parameters<typeof ProjectsLevelContent>[0]> = {}): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <ProjectsLevelContent {...baseContentProps(overrides)} />
    </TooltipProvider>,
  );
}

/** Extracts the `<tfoot>...</tfoot>` block so footer assertions are scoped
 *  to the footer specifically, rather than to "somewhere in the whole page"
 *  — the summary tiles above the table render the account-wide totals too,
 *  and a loose substring check could pass by matching those instead of the
 *  footer this task's reconciliation is actually about. */
function extractFooterHtml(html: string): string {
  const match = html.match(/<tfoot[^>]*>[\s\S]*?<\/tfoot>/);
  if (!match) throw new Error('expected a <tfoot> in the rendered output');
  return match[0];
}

const twoProjectPage: ProjectCostPage = {
  projects: [
    {
      project_id: 'p1',
      project_name: 'Alpha',
      session_count: 4,
      llm_cost: 6,
      compute_cost: 4,
      total_cost: 10,
      last_activity_at: '2026-07-15T00:00:00.000Z',
    },
    {
      project_id: 'p2',
      project_name: 'Beta',
      session_count: 2,
      llm_cost: 3,
      compute_cost: 0.25,
      total_cost: 3.25,
      last_activity_at: '2026-07-10T00:00:00.000Z',
    },
  ],
  total: 2,
  limit: 25,
  offset: 0,
  next_offset: null,
};

describe('ProjectsLevelContent', () => {
  test('offers the CSV export beside the range picker', () => {
    const html = renderContent({ page: twoProjectPage });
    expect(html).toContain('Export CSV');
  });

  // The builder above proves the shape; this proves the WIRING — that the
  // active sort actually reaches the export button, rather than the constant
  // that used to be there. The filters are props, not markup, so this reads
  // the element tree instead of the HTML.
  test('the export button is handed the active sort, not a fixed default', () => {
    for (const sort of ['total_desc', 'total_asc', 'name_asc', 'recent'] as const) {
      const tree = ProjectsLevelContent(baseContentProps({ page: twoProjectPage, sort }) as never);
      const exports = collectElementsByType(tree, CostExportButton);
      expect(exports, `expected one export button under sort ${sort}`).toHaveLength(1);
      expect(exports[0]!.props.kind).toBe('projects');
      expect(exports[0]!.props.filters).toEqual({ sort });
    }
  });

  test('keeps the CSV export available while the table is still loading', () => {
    // The export is a server-side re-run of the same filtered query, not a
    // dump of the rendered rows — so it does not depend on this page having
    // arrived, and gating it on the table would only make it flicker.
    const html = renderContent({ isProjectsLoading: true });
    expect(html).toContain('Export CSV');
  });

  test('shows a loading skeleton, never a spinner icon, while projects have not loaded', () => {
    const html = renderContent({ isProjectsLoading: true });
    expect(html).toContain('aria-label="Loading projects"');
    expect(html).not.toContain('animate-spin');
    expect(html).not.toContain('No spend');
  });

  test('renders the project error inline without losing the shell (range picker still present)', () => {
    const html = renderContent({ projectsError: new Error('projects-error-marker') });
    expect(html).toContain('projects-error-marker');
    expect(html).toContain('Last 30 days');
  });

  // ── "no page was ever read" is not "this account has no spend" ───────────
  //
  // Same defect class as `SessionsLevelTable`'s (see the note in
  // sessions-level.test.tsx, and its reproduction against a real
  // `QueryObserver`): `isProjectsLoading` is React Query's `isPending &&
  // isFetching`, so it is FALSE in every pending-but-not-fetching state —
  // query disabled while the billing account id resolves, fetch cancelled,
  // or a retry loop paused because the document is hidden / the browser is
  // offline. There `page` is undefined and `projectsError` is null, and
  // `rows.length === 0` used to render "No spend recorded yet" — a factual
  // claim about spend that was never read.
  test('renders the loading state, not a "no spend" claim, when no page has been read and nothing is in flight', () => {
    const html = renderContent({ page: undefined, isProjectsLoading: false, projectsError: null });
    expect(html).toContain('aria-label="Loading projects"');
    expect(html).not.toContain('No spend recorded yet');
    expect(html).not.toContain('No spend in this range');
  });

  // Ordering lock: a failed refetch on top of an already-read empty page has
  // BOTH an error and zero rows. The error must win.
  test('a failed refetch over an already-read empty page shows the error, not a "no spend" claim', () => {
    const html = renderContent({
      page: { projects: [], total: 0, limit: 25, offset: 0, next_offset: null },
      summary: summaryWithTotal(0),
      projectsError: new Error('projects-error-marker'),
    });
    expect(html).toContain('projects-error-marker');
    expect(html).not.toContain('No spend recorded yet');
    expect(html).not.toContain('No spend in this range');
  });

  // Scenario 1 from the fix-round review: the account has genuine spend
  // history (the *previous* window had real spend), but the *current*
  // default 30d window happens to be quiet. Before this fix, the branch
  // keyed on `range.preset !== '30d'` — since this is the default preset, it
  // always read "no spend recorded yet" here, which is false: the account
  // has history, the user just isn't looking at it. This is on the default
  // preset specifically, to prove the preset itself no longer drives the
  // decision.
  test('a quiet default-range window with a real previous-window total reads "no spend in this range", not "no spend recorded yet"', () => {
    const summary: CostSummary = { ...summaryWithTotal(0), previous: { total_cost: 42 } };
    const html = renderContent({
      range: baseRange, // preset: '30d', the default
      page: { projects: [], total: 0, limit: 25, offset: 0, next_offset: null },
      summary,
    });
    expect(html).toContain('No spend in this range');
    expect(html).not.toContain('No spend recorded yet');
    expect(html).toContain('Reset range');
  });

  // Scenario 2 from the fix-round review: a brand-new account (no signal in
  // either window) looking at a non-default range. Before this fix, the
  // branch keyed on the preset alone — any non-default preset always read
  // "no spend in this range" and offered a reset that could not help, since
  // there was nothing to reset to. This is on a non-default preset
  // specifically, to prove the preset itself no longer drives the decision.
  test('a non-default range with no spend signal in either window reads "no spend recorded yet", not "no spend in this range"', () => {
    const html = renderContent({
      range: { ...baseRange, preset: '7d' },
      page: { projects: [], total: 0, limit: 25, offset: 0, next_offset: null },
      summary: summaryWithTotal(0),
    });
    expect(html).toContain('No spend recorded yet');
    expect(html).not.toContain('No spend in this range');
    expect(html).not.toContain('Reset range');
  });

  // ── Sortable headers ──────────────────────────────────────────────────
  //
  // Only Project and Total are sortable, because those are the only two
  // orderings `GET /usage/cost-by-project` accepts. The rest must stay plain:
  // a header that looks clickable and reorders nothing is worse than one that
  // never invited the click.

  test('Project and Total are buttons; Sessions, LLM and Compute are not', () => {
    const html = renderContent({ page: twoProjectPage });
    const header = html.match(/<thead[\s\S]*?<\/thead>/)![0];

    // Two sortable columns, so exactly two buttons in the header row.
    expect((header.match(/<button/g) ?? []).length).toBe(2);

    // Scoped per cell: a whole-header check would pass with the buttons on
    // the wrong two columns.
    const cells = header.match(/<th[\s\S]*?<\/th>/g) ?? [];
    expect(cells).toHaveLength(5);
    const hasButton = cells.map((cell) => cell.includes('<button'));
    expect(hasButton).toEqual([true, false, false, false, true]);
  });

  test('the sortable headers are real buttons with a visible focus ring', () => {
    const html = renderContent({ page: twoProjectPage });
    const header = html.match(/<thead[\s\S]*?<\/thead>/)![0];
    for (const button of header.match(/<button[^>]*>/g) ?? []) {
      expect(button).toContain('type="button"');
      expect(button).toContain('focus-visible:ring-2');
    }
  });

  // `aria-sort` is the only thing that tells assistive technology which column
  // orders the table. It must be on the active column and ABSENT elsewhere —
  // `aria-sort="none"` on every other column would say all five participate.
  test('aria-sort marks only the active column, descending by default', () => {
    const html = renderContent({ page: twoProjectPage, sort: 'total_desc' });
    const header = html.match(/<thead[\s\S]*?<\/thead>/)![0];
    expect((header.match(/aria-sort=/g) ?? []).length).toBe(1);
    expect(header).toContain('aria-sort="descending"');
  });

  test('aria-sort flips to ascending on the Total column', () => {
    const header = renderContent({ page: twoProjectPage, sort: 'total_asc' }).match(
      /<thead[\s\S]*?<\/thead>/,
    )![0];
    expect((header.match(/aria-sort=/g) ?? []).length).toBe(1);
    expect(header).toContain('aria-sort="ascending"');
  });

  test('aria-sort moves to the Project column under name_asc', () => {
    const header = renderContent({ page: twoProjectPage, sort: 'name_asc' }).match(
      /<thead[\s\S]*?<\/thead>/,
    )![0];
    const projectCell = (header.match(/<th[\s\S]*?<\/th>/g) ?? [])[0]!;
    expect(projectCell).toContain('aria-sort="ascending"');
    expect((header.match(/aria-sort=/g) ?? []).length).toBe(1);
  });

  // `recent` is reachable through the API but no header selects it, so no
  // column may claim it.
  test('no column claims aria-sort under a sort no header offers', () => {
    const header = renderContent({ page: twoProjectPage, sort: 'recent' }).match(
      /<thead[\s\S]*?<\/thead>/,
    )![0];
    expect(header).not.toContain('aria-sort=');
  });

  // Right-aligned numeric columns keep their alignment — the indicator sits
  // inside it rather than being floated out of the flow.
  test('the Total header keeps the numeric right alignment', () => {
    const header = renderContent({ page: twoProjectPage }).match(/<thead[\s\S]*?<\/thead>/)![0];
    const totalCell = (header.match(/<th[\s\S]*?<\/th>/g) ?? [])[4]!;
    expect(totalCell).toContain('text-right');
    expect(totalCell).not.toContain('float');
  });

  // The click contract itself. renderToStaticMarkup strips handlers from its
  // HTML, so this calls the (hook-free) component function directly and reads
  // the element tree the same way sessions-level.test.tsx does.
  test('clicking a sortable header reports which column was clicked', () => {
    const clicked: string[] = [];
    const tree = ProjectsLevelContent(
      baseContentProps({ page: twoProjectPage, onSort: (column) => clicked.push(column) }) as never,
    );

    const headers = collectElementsByType(tree, CostSortHeader);
    expect(headers.map((header) => header.props.label)).toEqual(['Project', 'Total']);

    (headers[0]!.props.onSort as () => void)();
    (headers[1]!.props.onSort as () => void)();
    expect(clicked).toEqual(['name', 'total']);
  });

  test('renders the column headers in order: Project, Sessions, LLM, Compute, Total', () => {
    const html = renderContent({ page: twoProjectPage });
    const projectIndex = html.indexOf('>Project<');
    const sessionsIndex = html.indexOf('>Sessions<');
    const llmIndex = html.indexOf('>LLM<');
    const computeIndex = html.indexOf('>Compute<');
    const totalIndex = html.indexOf('>Total<');

    expect(projectIndex).toBeGreaterThan(-1);
    expect(sessionsIndex).toBeGreaterThan(projectIndex);
    expect(llmIndex).toBeGreaterThan(sessionsIndex);
    expect(computeIndex).toBeGreaterThan(llmIndex);
    expect(totalIndex).toBeGreaterThan(computeIndex);
  });

  test('renders project rows in the order the page provides, with unassigned always last', () => {
    const html = renderContent({ page: twoProjectPage, summary: summaryWithTotal(20) });
    const alphaIndex = html.indexOf('Alpha');
    const betaIndex = html.indexOf('Beta');
    const unassignedIndex = html.indexOf('Unassigned');

    expect(alphaIndex).toBeGreaterThan(-1);
    expect(betaIndex).toBeGreaterThan(alphaIndex);
    expect(unassignedIndex).toBeGreaterThan(betaIndex);
  });

  test('a real project row is clickable — cursor-pointer and hover:bg-accent on its <tr>', () => {
    const html = renderContent({ page: twoProjectPage });
    const rowMatch = html.match(/<tr[^>]*>(?:(?!<\/tr>).)*Alpha(?:(?!<\/tr>).)*<\/tr>/);
    expect(rowMatch).not.toBeNull();
    expect(rowMatch![0]).toContain('cursor-pointer');
    expect(rowMatch![0]).toContain('hover:bg-accent');
  });

  // Mutation target #3: "make the unassigned row clickable". If the
  // clickability class ever leaks onto the unassigned row (whether by
  // bypassing isProjectRowClickable or by a copy/paste of the real-row
  // className), this must fail.
  test('the unassigned row is not clickable — no cursor-pointer on its <tr>, and it carries the reason as an aria-label', () => {
    const html = renderContent({ page: twoProjectPage, summary: summaryWithTotal(20) });
    const rowMatch = html.match(/<tr[^>]*>(?:(?!<\/tr>).)*Unassigned(?:(?!<\/tr>).)*<\/tr>/);
    expect(rowMatch).not.toBeNull();
    expect(rowMatch![0]).not.toContain('cursor-pointer');
    expect(rowMatch![0]).toContain('Spend recorded against sessions that no longer exist.');
  });

  // The reconciliation this task exists to deliver: the rendered footer must
  // equal the sum of the rendered rows, unassigned included — on all four
  // numeric columns, not just Total. This is computed independently from the
  // row values actually present in the HTML output, not merely re-asserting
  // the same summary figure back at itself.
  //
  // NOTE on why this alone is not sufficient: on this fixture (first page,
  // unassigned computed as `summary.totals.total_cost - attributed`), the
  // rows' own total and `summary.totals.total_cost` are mathematically
  // identical by construction — Alpha $10 + Beta $3.25 + Unassigned $6.75
  // *is* $20, the fixture's own total. A footer that silently read
  // `summary.totals.total_cost` instead of summing the rendered rows would
  // still pass this test. The next test below is what actually
  // distinguishes the two: a page where they diverge.
  test('the footer reconciles on all four numeric columns, including unassigned', () => {
    const html = renderContent({ page: twoProjectPage, summary: summaryWithTotal(20) });
    // Alpha: $10.00, Beta: $3.25, Unassigned: $20 - 13.25 = $6.75.
    expect(html).toContain('$10.00');
    expect(html).toContain('$3.25');
    expect(html).toContain('$6.75');

    const footerHtml = extractFooterHtml(html);
    // Sessions: 4 + 2 + 0 (unassigned) = 6.
    expect(footerHtml).toContain('>6<');
    // LLM: $6 + $3 + $0 (unassigned) = $9.00.
    expect(footerHtml).toContain('$9.00');
    // Compute: $4 + $0.25 + $0 (unassigned) = $4.25.
    expect(footerHtml).toContain('$4.25');
    // Total: $10 + $3.25 + $6.75 (unassigned) = $20.00 — the account total.
    expect(footerHtml).toContain('$20.00');

    // Read the four assertions above literally: each footer cell equals the
    // sum of ITS column. They do not equal each other across the row —
    // $9.00 + $4.25 = $13.25, not $20.00. That is not a defect in the sum; the
    // API reports unassigned spend without an LLM/compute split, so the row
    // contributes to Total alone and renders the other two cells as an em
    // dash. "The footer adds up to itself" is a claim that holds only in the
    // row-HIDDEN state. See `buildProjectTableRows`' consequence 2.
  });

  // The test that actually proves the footer sums the *rendered rows*,
  // rather than re-reading `summary.totals.total_cost` — see the note above.
  // On a page after the first, `buildProjectTableRows` never appends an
  // unassigned row (guard 1), so `rows` is a small subset of the account,
  // while `summary.totals.total_cost` stays account-wide and much larger.
  // The two computations diverge here, which is the only way this
  // assertion can fail a footer that reads from the wrong source.
  test('on a page after the first, the footer sums the rendered rows — not the account-wide summary total', () => {
    const html = renderContent({
      page: {
        projects: [
          {
            project_id: 'p26',
            project_name: 'Page 2 project',
            session_count: 3,
            llm_cost: 2.5,
            compute_cost: 1.5,
            total_cost: 4,
            last_activity_at: null,
          },
        ],
        total: 40,
        limit: 25,
        offset: 25,
        next_offset: null,
      },
      // Deliberately far from the page's own total (4) — if the footer ever
      // read this figure instead of summing `rows`, the assertions below
      // would see 999, not 4.
      summary: summaryWithTotal(999),
    });

    const footerHtml = extractFooterHtml(html);
    expect(footerHtml).toContain('>3<');
    expect(footerHtml).toContain('$2.50');
    expect(footerHtml).toContain('$1.50');
    expect(footerHtml).toContain('$4.00');
    expect(footerHtml).not.toContain('999');
  });

  // The rendered half of the guard-1 fix. `total: 40` with two rows on
  // screen is a first page that does not cover the result; the account-wide
  // summary is deliberately far above the page's own $13.25 so a leaked
  // subtraction would be unmissable ($62.52 - $13.25 = $49.27).
  test('a first page shorter than the whole result renders no Unassigned row, and the footer sums only that page', () => {
    const html = renderContent({
      page: { ...twoProjectPage, total: 40, offset: 0, next_offset: 25 },
      summary: summaryWithTotal(62.52),
    });

    expect(html).not.toContain('Unassigned');
    expect(html).not.toContain('$49.27');

    const footerHtml = extractFooterHtml(html);
    // Alpha $10.00 + Beta $3.25 — the two rows actually on screen.
    expect(footerHtml).toContain('$13.25');
    expect(footerHtml).not.toContain('$62.52');
  });

  // Defect 2, projects level. The footer sums one page; the Total tile above
  // the table is the whole window from `/usage/cost-summary`. They diverge
  // whenever the result paginates, so they must not both read "Total".
  test('the footer row is labelled "Page total", never a bare "Total"', () => {
    const html = renderContent({
      page: { ...twoProjectPage, total: 40, offset: 0, next_offset: 25 },
      summary: summaryWithTotal(62.52),
    });
    const footerHtml = extractFooterHtml(html);
    expect(footerHtml).toContain('Page total');
    expect(footerHtml).not.toContain('>Total<');
  });

  // Defect 3. Project names are user-supplied and unbounded; at 1440px a
  // 69-character name widened the Project column to 582px and clipped 52px
  // off the Total column. The cell caps and truncates instead, and keeps the
  // full name reachable on hover through `title`. "On hover" is the whole of
  // it: truncation is visual, so the text node is intact and a screen reader
  // still announces the full name — the gap is sighted keyboard-only users,
  // and `title` does not close it.
  test('a long project name is truncated in its own cell rather than widening the column', () => {
    const longName = 'A'.repeat(69);
    const html = renderContent({
      page: {
        ...twoProjectPage,
        projects: [{ ...twoProjectPage.projects[0]!, project_name: longName }],
        total: 1,
      },
    });

    const nameMatch = html.match(/<p[^>]*>A{69}<\/p>/);
    expect(nameMatch).not.toBeNull();
    expect(nameMatch![0]).toContain('truncate');
    expect(nameMatch![0]).toContain('max-w-[280px]');
    expect(html).toContain(`title="${longName}"`);
  });

  test('pagination caption and Previous/Next disabled state reflect the page', () => {
    const html = renderContent({ page: { ...twoProjectPage, total: 30, offset: 0, next_offset: 25 } });
    expect(html).toContain('Showing 1-2 of 30 projects');
    const previousMatch = html.match(/<button[^>]*>Previous<\/button>/);
    const nextMatch = html.match(/<button[^>]*>Next<\/button>/);
    expect(previousMatch).not.toBeNull();
    expect(nextMatch).not.toBeNull();
    // `class="disabled:pointer-events-none …"` is present on every button
    // regardless of state — the literal HTML attribute is `disabled=""`.
    expect(previousMatch![0]).toContain('disabled=""');
    expect(nextMatch![0]).not.toContain('disabled=""');
  });

  test('Previous is enabled and Next is disabled on the last page', () => {
    const html = renderContent({ page: { ...twoProjectPage, total: 27, offset: 25, next_offset: null } });
    expect(html).toContain('Showing 26-27 of 27 projects');
    const previousMatch = html.match(/<button[^>]*>Previous<\/button>/);
    const nextMatch = html.match(/<button[^>]*>Next<\/button>/);
    expect(previousMatch![0]).not.toContain('disabled=""');
    expect(nextMatch![0]).toContain('disabled=""');
  });
});
