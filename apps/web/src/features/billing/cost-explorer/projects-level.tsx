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
import { formatSessionCostUsd } from '../session-cost-format';

/** The whole explorer's default landing preset (`parseExplorerState` in the
 *  forthcoming explorer shell — see the plan's Task 15 — defaults new URL
 *  state to it too). Used here only as the target `onResetRange` resets to. */
const DEFAULT_RANGE_PRESET = '30d';

/** This level's only sort. Named once because the table query and the CSV
 *  export both send it — the export must run the same filtered query the
 *  table shows, not a differently ordered one. */
const PROJECTS_LEVEL_SORT: ProjectCostSort = 'total_desc';

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
 * Appends a synthetic "Unassigned" row so the table's footer reconciles with
 * the account total. `/usage/cost-by-project` sums only spend the API can
 * attribute to a project that still exists; `/usage/cost-summary` totals
 * every dollar the account was billed, including spend whose session (and
 * therefore project) no longer resolves. The gap between the two is
 * unassigned spend, and it belongs in the table — not a banner that never
 * reconciles with the rows beneath it (design spec, defect #7).
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
 * **Consequence, and it is deliberate:** an account with more spending
 * projects than one page holds never sees this row, on any page. That is most
 * real accounts. Showing no number beats showing a wrong one on a cost tool,
 * so the row's absence here is a correctness decision, not an oversight. The
 * complete fix is for the API to return the unassigned total as its own field
 * — then the client never subtracts one query's result from another's — and
 * that is filed separately, not done here.
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
            <TableHead>Project</TableHead>
            <TableHead className="text-right">Sessions</TableHead>
            <TableHead className="text-right">LLM</TableHead>
            <TableHead className="text-right">Compute</TableHead>
            <TableHead className="text-right">Total</TableHead>
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
        <CostExportButton kind="projects" range={range} filters={{ sort: PROJECTS_LEVEL_SORT }} />
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
          column the surface exists to show. The cap is on the inner block so
          it binds under `table-layout: auto`, where a `max-width` on the
          `<td>` itself is advisory. Same cell/`truncate` shape as the Session
          and Owner cells in sessions-level.tsx. */}
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
 * screen the whole cost explorer opens on. Owns pagination state and the two
 * queries (`useCostSummary`, `useCostByProject`); rendering itself is
 * `ProjectsLevelContent`.
 */
export function ProjectsLevel({ range, onRangeChange, onSelectProject }: ProjectsLevelProps) {
  const [offset, setOffset] = useState(0);

  const summaryQuery = useCostSummary({ from: range.from, to: range.to });
  const projectsQuery = useCostByProject({
    from: range.from,
    to: range.to,
    sort: PROJECTS_LEVEL_SORT,
    offset,
  });

  const handleRangeChange = (next: CostRange) => {
    setOffset(0);
    onRangeChange(next);
  };

  const handleResetRange = () => {
    setOffset(0);
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
      onSelectProject={onSelectProject}
      onPreviousPage={() => setOffset((current) => Math.max(0, current - COST_PAGE_SIZE))}
      onNextPage={() => setOffset((current) => projectsQuery.data?.next_offset ?? current)}
    />
  );
}
