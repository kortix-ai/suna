'use client';

import { useState, type ReactNode } from 'react';

import type { CostSummary, ProjectCostPage, ProjectCostSort } from '@kortix/sdk';
import { ReceiptIcon as ReceiptText } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import { resolvePreset, type CostRange } from '@/components/ui/date-range-picker';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/features/layout/section/empty-state';
import { COST_PAGE_SIZE, useCostByProject, useCostSummary } from '@/hooks/billing/use-cost-explorer';

import { CostExportButton } from './cost-export-button';
import { CostLevelShell } from './cost-level-shell';
import { CostSortHeader } from './cost-sort-header';
import { formatSessionCostUsd } from '../session-cost-format';

/** The whole explorer's default landing preset (`parseExplorerState` in the
 *  forthcoming explorer shell — see the plan's Task 15 — defaults new URL
 *  state to it too). Used here only as the target `onResetRange` resets to. */
const DEFAULT_RANGE_PRESET = '30d';

/** Where this level opens: most expensive project first, which is the question
 *  the screen exists to answer. Also what a header click falls back to. */
const DEFAULT_PROJECTS_SORT: ProjectCostSort = 'total_desc';

/**
 * The columns `GET /usage/cost-by-project` can actually order by.
 *
 * NOT every column in the table. The route accepts `total_desc`, `total_asc`,
 * `recent` and `name_asc` (`PROJECT_COST_SORTS`, `apps/api/src/router/routes/
 * usage.ts:281`) — so Sessions, LLM and Compute have no server sort and stay
 * plain headers. Making them look clickable and then not reordering anything
 * is worse than leaving them alone; sorting one page of 25 client-side would
 * be worse still, since it would silently reorder a slice of a larger result
 * under a control that reads as ordering the whole thing.
 */
export type ProjectSortColumn = 'name' | 'total';

/**
 * The sort a click on `column` selects.
 *
 * Total toggles, because "who costs the most" and "what is nearly free" are
 * both real questions. Project does not: the route has no `name_desc`, so a
 * two-way toggle there would either send a token the API rejects or fake a
 * direction it is not applying.
 *
 * A first click on Total lands on `total_desc` from any other sort — descending
 * is the useful default for money, and it is also where the level opens.
 */
export function nextProjectSort(
  active: ProjectCostSort,
  column: ProjectSortColumn,
): ProjectCostSort {
  if (column === 'name') return 'name_asc';
  return active === 'total_desc' ? 'total_asc' : 'total_desc';
}

/** `aria-sort` for `column`, or `undefined` when it is not the active sort.
 *  Undefined rather than `'none'`: the attribute's absence is what marks the
 *  other columns as not participating. */
export function projectSortDirection(
  active: ProjectCostSort,
  column: ProjectSortColumn,
): 'ascending' | 'descending' | undefined {
  if (column === 'name') return active === 'name_asc' ? 'ascending' : undefined;
  if (active === 'total_asc') return 'ascending';
  if (active === 'total_desc') return 'descending';
  return undefined;
}

/** The sort and page this level's table query is built from. One object
 *  because the two always move together — see `applyProjectSort`. */
export interface ProjectsLevelQueryState {
  sort: ProjectCostSort;
  offset: number;
}

/**
 * Applies a sort-header click.
 *
 * **The page reset is the point of this function existing.** Offset is an
 * index into an ordered result, so it means something different under a
 * different order: re-sorting while on page 2 of 40 projects lands the reader
 * in the middle of a list they have not seen the start of, under a heading
 * that says the order changed. Every path that changes the sort goes through
 * here, so the reset cannot be forgotten at one call site.
 */
export function applyProjectSort(
  state: ProjectsLevelQueryState,
  column: ProjectSortColumn,
): ProjectsLevelQueryState {
  return { sort: nextProjectSort(state.sort, column), offset: 0 };
}

/**
 * This level's CSV export filters — the active sort, so the file is ordered
 * the way the table on screen is.
 *
 * This used to be a fixed `total_desc` literal shared with the query. Once the
 * headers can re-sort, a constant would mean an export silently ordered
 * differently from the table it was taken from. Deliberately carries no page:
 * `format=csv` hardcodes `limit: CSV_ROW_CAP, offset: 0` on the route, so an
 * export is always the whole filtered query.
 */
export function buildProjectsLevelExportFilters(sort: ProjectCostSort): { sort: ProjectCostSort } {
  return { sort };
}

const UNASSIGNED_LABEL = 'Unassigned';
const UNASSIGNED_TOOLTIP_COPY = 'Spend recorded against sessions that no longer exist.';

// Rounding-noise guard: half a hundredth of a cent. Anything at or below
// this is treated as "fully attributed" and never surfaced as a row.
const UNASSIGNED_TOLERANCE_USD = 0.005;

export interface ProjectTableRow {
  project_id: string | null;
  project_name: string;
  session_count: number;
  llm_cost: number;
  compute_cost: number;
  total_cost: number;
  last_activity_at: string | null;
}

/**
 * Appends a synthetic "Unassigned" row so the table's Total column reconciles
 * with the account total — when the row is shown at all, and on that one
 * column only. Both qualifications are load-bearing; see the two paragraphs
 * at the end of this comment.
 *
 * `/usage/cost-by-project` sums only spend the API can attribute to a project
 * that still exists; `/usage/cost-summary` totals every dollar the account was
 * billed, including spend whose session (and therefore project) no longer
 * resolves. The gap between the two is unassigned spend, and it belongs in the
 * table — not a banner that never reconciles with the rows beneath it (design
 * spec, defect #7).
 *
 * The subtraction only means "unassigned" when `page.projects` holds EVERY
 * project in the result. Both guards below are required:
 *
 *  - **Only a page that covers the whole result** (`projects.length ===
 *    total`). Against any partial page — a later page, or a first page
 *    shorter than `total` — `summary.totals.total_cost` minus that subset is
 *    "everything not on this page", which is not a quantity the user has a
 *    name for. Measured on the 40-project seed account at `COST_PAGE_SIZE =
 *    25`: the first page rendered $0.34425 under the Unassigned label, which
 *    was exactly the spend of the 15 projects sitting on page 2. True
 *    unassigned spend on that data is $0.00.
 *  - **Only when positive.** Floating-point noise between two independently
 *    computed rollups must never invent a negative (or effectively-zero) row.
 *
 * **Consequence 1, and it is deliberate:** any account whose spending projects
 * exceed one page never sees this row, on any page. How common that is in
 * production is not known from here and is not claimed — the local seed data
 * has one such account out of four with spend, which establishes nothing about
 * the real distribution. What is certain is the mechanism, and that showing no
 * number beats showing a wrong one on a cost tool, so the row's absence is a
 * correctness decision rather than an oversight. The complete fix is for the
 * API to return the unassigned total as its own field — then the client never
 * subtracts one query's result from another's — and that is filed separately,
 * not done here.
 *
 * **Consequence 2, a residual this function does not close:** even in the
 * row-SHOWN state the footer reconciles on Total only, not across the row. The
 * API reports unassigned spend as one figure with no LLM/compute split, so
 * this row carries `llm_cost: 0` and `compute_cost: 0` and `ProjectRow`
 * honestly renders those cells as an em dash — but the footer sums them as
 * zero. `projects-level.test.tsx`'s own reconciliation fixture shows it: footer
 * LLM $9.00 + Compute $4.25 = $13.25 against a Total cell of $20.00. Only the
 * row-HIDDEN state has a footer that adds up across its own columns. Splitting
 * unassigned spend by kind needs the same API change as consequence 1.
 */
export function buildProjectTableRows(
  page: ProjectCostPage,
  summary: CostSummary | undefined,
): ProjectTableRow[] {
  const rows: ProjectTableRow[] = page.projects.map((project) => ({ ...project }));

  if (!summary || page.projects.length !== page.total) return rows;

  const attributed = page.projects.reduce((sum, project) => sum + project.total_cost, 0);
  const unassigned = Number((summary.totals.total_cost - attributed).toFixed(10));

  if (unassigned <= UNASSIGNED_TOLERANCE_USD) return rows;

  return [
    ...rows,
    {
      project_id: null,
      project_name: UNASSIGNED_LABEL,
      session_count: 0,
      llm_cost: 0,
      compute_cost: 0,
      total_cost: unassigned,
      last_activity_at: null,
    },
  ];
}

/** A row drills into a project only when it resolves to a real
 *  `project_id` — the synthetic Unassigned row has nowhere to go. */
export function isProjectRowClickable(
  row: ProjectTableRow,
): row is ProjectTableRow & { project_id: string } {
  return row.project_id !== null;
}

/**
 * Whether there is a data signal that this account has real spend history,
 * even though the current page shows zero rows. Drives the empty-state copy:
 * a signal means "you're just not looking at it right now" (offer a reset),
 * no signal means "this account has never spent anything" (nothing to reset
 * to). This is a data question, not a UI-state guess — it does not look at
 * which range preset happens to be selected.
 *
 * Two components, either sufficient:
 *  - The current window itself has spend. Normally this is impossible to
 *    see as "zero rows" on the first page — a positive `totals.total_cost`
 *    with no attributed projects would itself become the Unassigned row via
 *    `buildProjectTableRows` — but it is a real, if defensive, signal on a
 *    paginated page slice beyond the first, where the account-wide total is
 *    independent of which page came back empty.
 *  - The immediately preceding window of equal length had spend — the same
 *    `previous.total_cost` figure the period-over-period delta tile already
 *    computes, from the `useCostSummary` call this component already makes.
 *    No extra request.
 *
 * Still imperfect: spend older than two windows back is invisible to this
 * check, so a truly quiet two-window stretch on an account with real history
 * further back still reads as "no spend recorded yet".
 */
export function hasRecentSpendSignal(summary: CostSummary | undefined): boolean {
  return (summary?.totals.total_cost ?? 0) > 0 || (summary?.previous.total_cost ?? 0) > 0;
}

function sumBy(rows: ProjectTableRow[], pick: (row: ProjectTableRow) => number): number {
  return rows.reduce((sum, row) => sum + pick(row), 0);
}

export interface ProjectsLevelContentProps {
  range: CostRange;
  onRangeChange: (next: CostRange) => void;
  onResetRange: () => void;
  summary: CostSummary | undefined;
  isSummaryLoading: boolean;
  summaryError: Error | null;
  page: ProjectCostPage | undefined;
  isProjectsLoading: boolean;
  projectsError: Error | null;
  /** The active sort, so the headers can show which column orders the table
   *  and the export can follow it. */
  sort: ProjectCostSort;
  onSort: (column: ProjectSortColumn) => void;
  onSelectProject: (projectId: string) => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
}

/**
 * Presentational half of the projects level — mirrors the
 * `SessionCostExplorerContent` / `SessionCostExplorer` split this replaces
 * (`session-cost-explorer.tsx`), so the whole render contract is testable
 * with plain props via `renderToStaticMarkup`, with no react-query or
 * Supabase account context required.
 */
export function ProjectsLevelContent({
  range,
  onRangeChange,
  onResetRange,
  summary,
  isSummaryLoading,
  summaryError,
  page,
  isProjectsLoading,
  projectsError,
  sort,
  onSort,
  onSelectProject,
  onPreviousPage,
  onNextPage,
}: ProjectsLevelContentProps) {
  const rows = page ? buildProjectTableRows(page, summary) : [];

  const offset = page?.offset ?? 0;
  const total = page?.total ?? 0;
  const start = total === 0 ? 0 : offset + 1;
  const end = page ? Math.min(offset + page.projects.length, total) : 0;

  let tableSlot: ReactNode;
  if (projectsError) {
    tableSlot = (
      <InfoBanner tone="destructive" title="Failed to load project costs">
        {projectsError.message}
      </InfoBanner>
    );
  } else if (isProjectsLoading || !page) {
    // `!page` — not `isProjectsLoading && !page`. Both empty states below are
    // factual claims about spend ("no spend recorded yet" / "nothing in this
    // window"), so neither may render for a page that was never read.
    // `isProjectsLoading` is React Query's `isPending && isFetching`, which is
    // false in every pending-but-not-fetching state: query disabled while the
    // billing account id resolves, a cancelled fetch, or a retry loop paused
    // because the document is hidden / the browser is offline. Same defect
    // that made a failed `/usage/session-costs` request read as "No sessions"
    // (see sessions-level.tsx).
    tableSlot = (
      <div className="space-y-2" aria-label="Loading projects">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full rounded-md" />
        ))}
      </div>
    );
  } else if (rows.length === 0) {
    const hasSpendSignal = hasRecentSpendSignal(summary);
    tableSlot = hasSpendSignal ? (
      <EmptyState
        size="sm"
        icon={ReceiptText}
        title="No spend in this range"
        description="Nothing was recorded for the selected window."
        action={
          <Button type="button" variant="outline" size="sm" onClick={onResetRange}>
            Reset range
          </Button>
        }
      />
    ) : (
      <EmptyState
        size="sm"
        icon={ReceiptText}
        title="No spend recorded yet"
        description="Project costs appear here once a session starts running."
      />
    );
  } else {
    tableSlot = (
      <Table>
        <TableHeader>
          <TableRow>
            {/* Only Project and Total are sortable — those are the two the
                route can order by (see `ProjectSortColumn`). Sessions, LLM and
                Compute stay plain `TableHead`s rather than dead controls. */}
            <CostSortHeader
              label="Project"
              direction={projectSortDirection(sort, 'name')}
              onSort={() => onSort('name')}
            />
            <TableHead className="text-right">Sessions</TableHead>
            <TableHead className="text-right">LLM</TableHead>
            <TableHead className="text-right">Compute</TableHead>
            <CostSortHeader
              label="Total"
              align="right"
              direction={projectSortDirection(sort, 'total')}
              onSort={() => onSort('total')}
            />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <ProjectRow
              key={row.project_id ?? UNASSIGNED_LABEL}
              row={row}
              onSelectProject={onSelectProject}
            />
          ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            {/* "Page total", not "Total" — this row sums the rows rendered
                above it, which is one page of `total` projects. The Total
                tile above the table is the whole window for this scope, from
                a different query (`/usage/cost-summary`). Both figures are
                correct and they differ whenever the result paginates.
                Measured at 1440px on the 40-project seed account over
                2026-07-03..2026-08-02: this row read $62.18 against the
                tile's $62.53, the difference being the $0.34425 that the 15
                projects on page 2 account for. Two quantities that are not
                the same quantity do not get the same label. */}
            <TableCell className="font-medium">Page total</TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {sumBy(rows, (row) => row.session_count).toLocaleString('en-US')}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {formatSessionCostUsd(sumBy(rows, (row) => row.llm_cost))}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {formatSessionCostUsd(sumBy(rows, (row) => row.compute_cost))}
            </TableCell>
            <TableCell className="text-right font-mono font-medium tabular-nums">
              {formatSessionCostUsd(sumBy(rows, (row) => row.total_cost))}
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    );
  }

  return (
    <CostLevelShell
      range={range}
      onRangeChange={onRangeChange}
      summary={summary}
      isSummaryLoading={isSummaryLoading}
      summaryError={summaryError}
      controls={
        <CostExportButton
          kind="projects"
          range={range}
          filters={buildProjectsLevelExportFilters(sort)}
        />
      }
    >
      <div className="space-y-3">
        {tableSlot}
        {total > 0 ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-muted-foreground text-xs tabular-nums">
              Showing {start}-{end} of {total} projects
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={onPreviousPage}
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page?.next_offset == null}
                onClick={onNextPage}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </CostLevelShell>
  );
}

function ProjectRow({
  row,
  onSelectProject,
}: {
  row: ProjectTableRow;
  onSelectProject: (projectId: string) => void;
}) {
  const clickable = isProjectRowClickable(row);

  // The unassigned row has no session/LLM/compute breakdown to show — the
  // API folds it into the account total without a split (see the SDK
  // comment on `ProjectCostRow`). Showing "$0.00" there would imply a real
  // zero rather than "not broken down", so those cells read as an em dash;
  // only Total carries the real figure.
  const cells = (
    <>
      {/* Project names are user-supplied and unbounded. Left to size the
          column, a long one pushes the money columns past the table's
          `overflow-x-auto` edge — measured at 1440px, a 69-character name
          widened this column to 582px and clipped 52px off Total, the one
          column the surface exists to show.

          The cap sits on the inner block, NOT on the `<TableCell>`. Under
          `table-layout: auto` a `max-width` on a `<td>` is advisory: the
          browser may render the cell wider than declared, which is precisely
          what makes an uncapped name able to shove a column off-screen. Two
          Chromium measurements, both at 1440px: this inner cap binds exactly
          — the `<p>` reports clientWidth 280 against scrollWidth 546 on the
          69-character name — while a `<td>` declaring `max-w-[180px]` was
          measured during review rendering at 333px and at 237px depending on
          its content.

          This is deliberately NOT the shape used by the Session and Owner
          cells in sessions-level.tsx, which cap the `<TableCell>`
          (`max-w-[200px]` / `max-w-[180px]`) and put a bare `truncate` on the
          inner `<p>`. Those cells hold bounded content — a 36-character
          session id, a display name — so the advisory cap has never been
          tested by anything long enough to break it. A project name has no
          such bound, so the cap has to be the binding one. */}
      <TableCell>
        {/* `title` only on real projects. The unassigned row is the fixed
            10-character `UNASSIGNED_LABEL`, so it never truncates and has
            nothing to reveal — and its whole `<tr>` is already a `Hint`
            trigger, so a native tooltip here would open a second one over
            the same hover. */}
        <p className="max-w-[280px] truncate" title={clickable ? row.project_name : undefined}>
          {row.project_name}
        </p>
      </TableCell>
      <TableCell className="text-right font-mono tabular-nums">
        {clickable ? row.session_count.toLocaleString('en-US') : '—'}
      </TableCell>
      <TableCell className="text-right font-mono tabular-nums">
        {clickable ? formatSessionCostUsd(row.llm_cost) : '—'}
      </TableCell>
      <TableCell className="text-right font-mono tabular-nums">
        {clickable ? formatSessionCostUsd(row.compute_cost) : '—'}
      </TableCell>
      <TableCell className="text-right font-mono font-medium tabular-nums">
        {formatSessionCostUsd(row.total_cost)}
      </TableCell>
    </>
  );

  if (!clickable) {
    return (
      <Hint label={UNASSIGNED_TOOLTIP_COPY} side="top">
        <TableRow aria-label={UNASSIGNED_TOOLTIP_COPY} className="text-muted-foreground">
          {cells}
        </TableRow>
      </Hint>
    );
  }

  return (
    <TableRow
      className="cursor-pointer hover:bg-accent"
      onClick={() => onSelectProject(row.project_id)}
    >
      {cells}
    </TableRow>
  );
}

export interface ProjectsLevelProps {
  range: CostRange;
  onRangeChange: (next: CostRange) => void;
  onSelectProject: (projectId: string) => void;
}

/**
 * The Projects level of the Project -> Sessions -> Session drill-down — the
 * screen the whole cost explorer opens on. Owns sort and pagination state and
 * the two queries (`useCostSummary`, `useCostByProject`); rendering itself is
 * `ProjectsLevelContent`.
 *
 * Sort and offset are ONE state object, not two `useState`s. They are not
 * independent: an offset is an index into an ordered result, so it is only
 * meaningful under the sort it was taken against. Holding them together makes
 * `applyProjectSort` the single place the "reset to page 1" rule lives, instead
 * of a rule each call site has to remember.
 */
export function ProjectsLevel({ range, onRangeChange, onSelectProject }: ProjectsLevelProps) {
  const [query, setQuery] = useState<ProjectsLevelQueryState>({
    sort: DEFAULT_PROJECTS_SORT,
    offset: 0,
  });

  const summaryQuery = useCostSummary({ from: range.from, to: range.to });
  const projectsQuery = useCostByProject({
    from: range.from,
    to: range.to,
    sort: query.sort,
    offset: query.offset,
  });

  const handleRangeChange = (next: CostRange) => {
    setQuery((current) => ({ ...current, offset: 0 }));
    onRangeChange(next);
  };

  const handleResetRange = () => {
    setQuery((current) => ({ ...current, offset: 0 }));
    onRangeChange(resolvePreset(DEFAULT_RANGE_PRESET, new Date()));
  };

  return (
    <ProjectsLevelContent
      range={range}
      onRangeChange={handleRangeChange}
      onResetRange={handleResetRange}
      summary={summaryQuery.data}
      isSummaryLoading={summaryQuery.isLoading}
      summaryError={summaryQuery.error instanceof Error ? summaryQuery.error : null}
      page={projectsQuery.data}
      isProjectsLoading={projectsQuery.isLoading}
      projectsError={projectsQuery.error instanceof Error ? projectsQuery.error : null}
      sort={query.sort}
      onSort={(column) => setQuery((current) => applyProjectSort(current, column))}
      onSelectProject={onSelectProject}
      onPreviousPage={() =>
        setQuery((current) => ({
          ...current,
          offset: Math.max(0, current.offset - COST_PAGE_SIZE),
        }))
      }
      onNextPage={() =>
        setQuery((current) => ({
          ...current,
          offset: projectsQuery.data?.next_offset ?? current.offset,
        }))
      }
    />
  );
}
