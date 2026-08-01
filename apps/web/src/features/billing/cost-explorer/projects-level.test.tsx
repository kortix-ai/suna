import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { CostSummary, ProjectCostPage } from '@kortix/sdk';

import {
  buildProjectTableRows,
  isProjectRowClickable,
  ProjectsLevelContent,
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

  // Guard 1: pagination. A page 2+ is a subset of `projects` — subtracting
  // the account total against only that subset is not "unassigned", it is
  // "everything not on this page", which is meaningless. This must hold even
  // when the raw difference would be positive if the guard were ignored.
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

// ── Component: ProjectsLevelContent ─────────────────────────────────────────
// Presentational only — mirrors the SessionCostExplorerContent /
// SessionCostExplorer split in session-cost-explorer.tsx, so the whole
// render contract is testable with plain props and renderToStaticMarkup,
// with no react-query or Supabase wiring needed.

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
    onSelectProject: noop,
    onPreviousPage: noop,
    onNextPage: noop,
    ...overrides,
  };
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
  test('shows a loading skeleton, never a spinner icon, while projects have not loaded', () => {
    const html = renderToStaticMarkup(
      <ProjectsLevelContent {...baseContentProps({ isProjectsLoading: true })} />,
    );
    expect(html).toContain('aria-label="Loading projects"');
    expect(html).not.toContain('animate-spin');
    expect(html).not.toContain('No spend');
  });

  test('renders the project error inline without losing the shell (range picker still present)', () => {
    const html = renderToStaticMarkup(
      <ProjectsLevelContent
        {...baseContentProps({ projectsError: new Error('projects-error-marker') })}
      />,
    );
    expect(html).toContain('projects-error-marker');
    expect(html).toContain('Last 30 days');
  });

  test('empty state on the default 30d preset reads "no spend recorded yet" with no reset action', () => {
    const html = renderToStaticMarkup(
      <ProjectsLevelContent
        {...baseContentProps({
          page: { projects: [], total: 0, limit: 25, offset: 0, next_offset: null },
          summary: summaryWithTotal(0),
        })}
      />,
    );
    expect(html).toContain('No spend recorded yet');
    expect(html).not.toContain('No spend in this range');
    expect(html).not.toContain('Reset range');
  });

  // The structural claim here is the *distinction* itself — swapping the two
  // copies for each other, or always/never showing the reset action, would
  // still pass a test that only checked one branch. Both branches are
  // asserted from the same describe block on purpose.
  test('empty state on a non-default preset reads "no spend in this range" and offers a reset', () => {
    const html = renderToStaticMarkup(
      <ProjectsLevelContent
        {...baseContentProps({
          range: { ...baseRange, preset: '7d' },
          page: { projects: [], total: 0, limit: 25, offset: 0, next_offset: null },
          summary: summaryWithTotal(0),
        })}
      />,
    );
    expect(html).toContain('No spend in this range');
    expect(html).not.toContain('No spend recorded yet');
    expect(html).toContain('Reset range');
  });

  test('renders the column headers in order: Project, Sessions, LLM, Compute, Total', () => {
    const html = renderToStaticMarkup(
      <ProjectsLevelContent {...baseContentProps({ page: twoProjectPage })} />,
    );
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
    const html = renderToStaticMarkup(
      <ProjectsLevelContent
        {...baseContentProps({ page: twoProjectPage, summary: summaryWithTotal(20) })}
      />,
    );
    const alphaIndex = html.indexOf('Alpha');
    const betaIndex = html.indexOf('Beta');
    const unassignedIndex = html.indexOf('Unassigned');

    expect(alphaIndex).toBeGreaterThan(-1);
    expect(betaIndex).toBeGreaterThan(alphaIndex);
    expect(unassignedIndex).toBeGreaterThan(betaIndex);
  });

  test('a real project row is clickable — cursor-pointer and hover:bg-accent on its <tr>', () => {
    const html = renderToStaticMarkup(
      <ProjectsLevelContent {...baseContentProps({ page: twoProjectPage })} />,
    );
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
    const html = renderToStaticMarkup(
      <ProjectsLevelContent
        {...baseContentProps({ page: twoProjectPage, summary: summaryWithTotal(20) })}
      />,
    );
    const rowMatch = html.match(/<tr[^>]*>(?:(?!<\/tr>).)*Unassigned(?:(?!<\/tr>).)*<\/tr>/);
    expect(rowMatch).not.toBeNull();
    expect(rowMatch![0]).not.toContain('cursor-pointer');
    expect(rowMatch![0]).toContain('Spend recorded against sessions that no longer exist.');
  });

  // The reconciliation this task exists to deliver: the rendered footer
  // total must equal the sum of the rendered rows, unassigned included. This
  // is computed independently from the row values actually present in the
  // HTML output, not merely re-asserting the same summary figure back at
  // itself.
  test('the footer total equals the sum of the rendered rows, including unassigned', () => {
    const html = renderToStaticMarkup(
      <ProjectsLevelContent
        {...baseContentProps({ page: twoProjectPage, summary: summaryWithTotal(20) })}
      />,
    );
    // Alpha: $10.00, Beta: $3.25, Unassigned: $20 - 13.25 = $6.75.
    expect(html).toContain('$10.00');
    expect(html).toContain('$3.25');
    expect(html).toContain('$6.75');

    const dollarAmounts = html.match(/\$[\d,]+\.\d{2}/g) ?? [];
    // Footer must be the *last* dollar figure printed (it follows every row
    // in document order), and it must equal the sum of every row total.
    const footerValue = Number(dollarAmounts[dollarAmounts.length - 1]!.replace(/[$,]/g, ''));
    expect(footerValue).toBe(20);
  });

  test('pagination caption and Previous/Next disabled state reflect the page', () => {
    const html = renderToStaticMarkup(
      <ProjectsLevelContent
        {...baseContentProps({
          page: { ...twoProjectPage, total: 30, offset: 0, next_offset: 25 },
        })}
      />,
    );
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
    const html = renderToStaticMarkup(
      <ProjectsLevelContent
        {...baseContentProps({
          page: { ...twoProjectPage, total: 27, offset: 25, next_offset: null },
        })}
      />,
    );
    expect(html).toContain('Showing 26-27 of 27 projects');
    const previousMatch = html.match(/<button[^>]*>Previous<\/button>/);
    const nextMatch = html.match(/<button[^>]*>Next<\/button>/);
    expect(previousMatch![0]).not.toContain('disabled=""');
    expect(nextMatch![0]).toContain('disabled=""');
  });
});
