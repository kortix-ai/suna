'use client';

import { useEffect, useState } from 'react';

import type { SessionCostSort, SessionCostsPage, SessionCostSummary } from '@kortix/sdk';
import { ReceiptIcon as ReceiptText } from '@phosphor-icons/react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { CostRange } from '@/components/ui/date-range-picker';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { useCostSummary } from '@/hooks/billing/use-cost-explorer';
import { SESSION_COST_PAGE_SIZE, useSessionCosts } from '@/hooks/billing/use-session-costs';

import { CostExportButton, type SessionCostExportFilters } from './cost-export-button';
import { CostLevelShell } from './cost-level-shell';
import { CostSortHeader } from './cost-sort-header';
import { formatSessionCostUsd } from '../session-cost-format';

export interface SessionOwnerOption {
  id: string;
  label: string;
}

export interface SessionsLevelFilters {
  ownerId: string | null;
  sort: SessionCostSort;
  offset: number;
}

interface SessionsLevelListInput {
  projectId: string;
  limit: number;
  offset: number;
  from: string;
  to: string;
  sort?: SessionCostSort;
  ownerId?: string;
}

const DEFAULT_FILTERS: SessionsLevelFilters = { ownerId: null, sort: 'total_desc', offset: 0 };

/**
 * The columns `GET /usage/session-costs` can actually order by.
 *
 * The route accepts three sorts — `total_desc`, `total_asc`, `recent`
 * (`SESSION_COST_SORTS`, `apps/api/src/router/routes/usage.ts:38`) — and
 * `recent` orders by last activity, which is the second line of the Session
 * cell. Owner, Requests, LLM and Compute have no server sort, so they stay
 * plain headers rather than controls that look live and do nothing.
 */
export type SessionSortColumn = 'session' | 'total';

/**
 * The sort a click on `column` selects.
 *
 * Total toggles between the two directions the route offers. Session does not:
 * `recent` is the only activity ordering there is (no `oldest`), so rendering a
 * two-way toggle would promise a direction the API cannot apply.
 */
export function nextSessionSort(
  active: SessionCostSort,
  column: SessionSortColumn,
): SessionCostSort {
  if (column === 'session') return 'recent';
  return active === 'total_desc' ? 'total_asc' : 'total_desc';
}

/** `aria-sort` for `column`, or `undefined` when it is not the active sort.
 *  `recent` is newest-first, so it reports `descending`. */
export function sessionSortDirection(
  active: SessionCostSort,
  column: SessionSortColumn,
): 'ascending' | 'descending' | undefined {
  if (column === 'session') return active === 'recent' ? 'descending' : undefined;
  if (active === 'total_asc') return 'ascending';
  if (active === 'total_desc') return 'descending';
  return undefined;
}

/**
 * Applies a sort-header click to this level's filters.
 *
 * **The `offset: 0` is the point of this function existing.** An offset is an
 * index into an ordered result, so re-sorting without resetting it drops the
 * reader into the middle of a list under a heading that says the order just
 * changed. Owner changes already reset the page inline for the same reason;
 * this puts the sort path's reset in one place instead of at each call site.
 */
export function applySessionSort(
  filters: SessionsLevelFilters,
  column: SessionSortColumn,
): SessionsLevelFilters {
  return { ...filters, sort: nextSessionSort(filters.sort, column), offset: 0 };
}

/**
 * The owner-catalog fetch's page size — deliberately the API's actual
 * ceiling (`MAX_COST_LIMIT` in `apps/api/src/shared/cost-window.ts`, which
 * `parseCostPagination` enforces on every `/usage/session-costs` request),
 * not the visible table's `SESSION_COST_PAGE_SIZE` (25). This query exists
 * only to enumerate owners for the dropdown, so it should see as much of the
 * window as the API allows in one request — the same route already serves
 * up to `CSV_ROW_CAP` rows for CSV export, so a wider single-purpose fetch
 * here is established practice, not a new load concern. Kept as a literal
 * (not imported) because `apps/api` is a separate deployable the web app
 * does not import from; the SDK does not re-export server-side constants.
 */
const SESSION_OWNER_CATALOG_LIMIT = 100;

/**
 * Owners dedupe by id, name wins over email — "what did Marko spend?" needs
 * a name, not an address — and a session with no owner contributes nothing.
 * Sorted alphabetically so the list is scannable rather than activity-order.
 */
export function collectOwnerOptions(
  sessions: readonly SessionCostSummary[],
): SessionOwnerOption[] {
  const labelById = new Map<string, string>();
  for (const session of sessions) {
    if (!session.owner_id) continue;
    if (labelById.has(session.owner_id)) continue;
    labelById.set(session.owner_id, session.owner_name || session.owner_email || 'Unknown owner');
  }
  return Array.from(labelById, ([id, label]) => ({ id, label })).sort((a, b) =>
    a.label.localeCompare(b.label),
  );
}

/**
 * Query input for the table itself — every active filter (owner, sort, page)
 * forwarded to `useSessionCosts` untouched. Extracted as its own pure
 * function so the pass-through can be asserted directly, rather than through
 * a mocked hook (the hook is real react-query + the SDK's fetch).
 */
export function buildSessionsLevelListInput(
  projectId: string,
  range: CostRange,
  filters: SessionsLevelFilters,
): SessionsLevelListInput {
  return {
    projectId,
    limit: SESSION_COST_PAGE_SIZE,
    offset: filters.offset,
    from: range.from,
    to: range.to,
    sort: filters.sort,
    ownerId: filters.ownerId ?? undefined,
  };
}

/**
 * Query input for the Owner filter's own option list. Deliberately omits the
 * owner filter and pins page one, sorted by spend: this is the one fetch in
 * the level that must never narrow by owner, or picking an owner would
 * immediately collapse the dropdown to that single entry. There is no
 * dedicated "list owners" endpoint (this level's interfaces are
 * `useSessionCosts` / `useCostSummary` only), so this reuses the same
 * session list, at `SESSION_OWNER_CATALOG_LIMIT` — the API's own maximum
 * page size, not the visible table's smaller page.
 *
 * Known limitation: the catalog still reflects only the top
 * `SESSION_OWNER_CATALOG_LIMIT` sessions by spend for the window — an owner
 * whose individual sessions never crack that page (regardless of large
 * cumulative spend spread across many cheap sessions) will not appear until
 * one of their sessions does. The Owner control surfaces this directly (see
 * the `Hint` in `SessionsLevel`) rather than filtering silently.
 */
export function buildSessionsLevelOwnerCatalogInput(
  projectId: string,
  range: CostRange,
): SessionsLevelListInput {
  return {
    projectId,
    limit: SESSION_OWNER_CATALOG_LIMIT,
    offset: 0,
    from: range.from,
    to: range.to,
    sort: 'total_desc',
  };
}

/**
 * Filters for this level's CSV export — the same project, owner and sort the
 * visible table is narrowed by, so the file holds the query the user is
 * looking at rather than the whole project.
 *
 * Deliberately carries no page. `format=csv` ignores the request's pagination
 * outright — the route hardcodes `limit: CSV_ROW_CAP, offset: 0` — and
 * `SessionCostExportOptions` has no `limit`/`offset` fields to send anyway.
 * An export is the whole filtered query, never the page on screen.
 *
 * Extracted as its own pure function for the same reason
 * `buildSessionsLevelListInput` is — so the pass-through is assertable without
 * rendering the hook-owning component.
 */
export function buildSessionsLevelExportFilters(
  projectId: string,
  filters: SessionsLevelFilters,
): SessionCostExportFilters {
  return {
    projectId,
    ownerId: filters.ownerId ?? undefined,
    sort: filters.sort,
  };
}

function ownerLabel(session: SessionCostSummary): string {
  if (session.owner_name) return session.owner_name;
  if (session.owner_email) return session.owner_email;
  if (session.owner_type === 'unknown') return 'Unknown owner';
  return 'No owner';
}

function ownerTypeLabel(session: SessionCostSummary): string | null {
  if (session.owner_type === 'service_account') return 'Service';
  if (session.owner_type === 'user') return 'User';
  if (session.owner_type === 'unknown') return 'Unknown';
  return null;
}

function formatActivity(value: string | null): string {
  if (!value) return 'No billed activity';
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sumBy(
  sessions: readonly SessionCostSummary[],
  pick: (session: SessionCostSummary) => number,
): number {
  return sessions.reduce((sum, session) => sum + pick(session), 0);
}

export interface SessionsLevelTableProps {
  data: SessionCostsPage | undefined;
  isLoading: boolean;
  error: Error | null;
  /** The active sort, so the headers can show which column orders the table. */
  sort: SessionCostSort;
  onSort: (column: SessionSortColumn) => void;
  onSelectSession: (sessionId: string) => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
}

/**
 * The pure, presentational half of this level — every filter/query concern
 * lives in `SessionsLevel` below. Kept separate so the table markup (column
 * order, the totals footer, the click contract) is testable without a real
 * `useSessionCosts` fetch, mirroring the `SessionCostExplorerContent` /
 * `ProjectsLevelContent` split this replaces.
 */
export function SessionsLevelTable({
  data,
  isLoading,
  error,
  sort,
  onSort,
  onSelectSession,
  onPreviousPage,
  onNextPage,
}: SessionsLevelTableProps) {
  if (error) {
    return (
      <InfoBanner tone="destructive" title="Failed to load sessions">
        {error.message}
      </InfoBanner>
    );
  }

  // `!data` — not `isLoading && !data`. The empty state below is a factual
  // claim about this project's sessions, so it may only render once a page
  // has actually come back. `isLoading` is `isPending && isFetching`, and a
  // query can be pending WITHOUT fetching: `enabled: false` while the
  // billing account id resolves, a fetch that was cancelled, and — the one
  // that produced this bug — a retry loop that React Query paused because
  // the document is hidden or the browser is offline (`canContinue()` in
  // query-core's retryer). In every one of those, `isLoading` is false,
  // `error` is null and `data` is undefined: a failed `/usage/session-costs`
  // request rendered as "No sessions" and stayed there. Not knowing yet is
  // the loading state, never an empty one.
  if (isLoading || !data) {
    return (
      <div className="space-y-2" aria-label="Loading sessions">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full rounded-md" />
        ))}
      </div>
    );
  }

  const sessions = data.sessions;
  const offset = data.offset;
  const total = data.total;
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + sessions.length, total);

  if (sessions.length === 0) {
    return (
      <EmptyState
        size="sm"
        icon={ReceiptText}
        title="No sessions"
        description="Session cost records appear after sessions are created."
      />
    );
  }

  return (
    <div className="space-y-3">
      <Table>
        <TableHeader>
          <TableRow>
            {/* Only Session and Total are sortable — those are the two the
                route can order by (see `SessionSortColumn`). Session maps to
                `recent`, which orders by the last-activity line inside that
                same cell. Owner, Requests, LLM and Compute stay plain. */}
            <CostSortHeader
              label="Session"
              direction={sessionSortDirection(sort, 'session')}
              onSort={() => onSort('session')}
            />
            <TableHead>Owner</TableHead>
            <TableHead className="text-right">Requests</TableHead>
            <TableHead className="text-right">LLM</TableHead>
            <TableHead className="text-right">Compute</TableHead>
            <CostSortHeader
              label="Total"
              align="right"
              direction={sessionSortDirection(sort, 'total')}
              onSort={() => onSort('total')}
            />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((session) => {
            const ownerType = ownerTypeLabel(session);
            return (
              <TableRow
                key={session.session_id}
                className="cursor-pointer hover:bg-accent"
                onClick={() => onSelectSession(session.session_id)}
              >
                <TableCell className="max-w-[200px]">
                  <p className="truncate font-mono text-xs">{session.session_id}</p>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    {formatActivity(session.last_activity_at)}
                  </p>
                </TableCell>
                <TableCell className="max-w-[180px]">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <p className="truncate text-sm">{ownerLabel(session)}</p>
                    {ownerType ? (
                      <Badge variant="outline" size="sm">
                        {ownerType}
                      </Badge>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {session.request_count.toLocaleString('en-US')}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatSessionCostUsd(session.llm_cost)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatSessionCostUsd(session.compute_cost)}
                </TableCell>
                <TableCell className="text-right font-mono font-medium tabular-nums">
                  {formatSessionCostUsd(session.total_cost)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
        <TableFooter>
          <TableRow>
            {/* "Page total", not "Total" — same rule as the projects level's
                footer. This row sums `sessions`, which is one page of
                `total`; the Total tile above the table is this project's
                whole window, from `/usage/cost-summary`. Measured on the seed
                account's largest project over 2026-07-01..2026-08-03: 55
                sessions totalling $24.2324, of which the top 25 are $24.1103
                — the $0.1221 remainder is sessions 26-55, not a discrepancy.
                Two quantities that are not the same quantity do not get the
                same label. */}
            <TableCell colSpan={2} className="font-medium">
              Page total
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {sumBy(sessions, (session) => session.request_count).toLocaleString('en-US')}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {formatSessionCostUsd(sumBy(sessions, (session) => session.llm_cost))}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {formatSessionCostUsd(sumBy(sessions, (session) => session.compute_cost))}
            </TableCell>
            <TableCell className="text-right font-mono font-medium tabular-nums">
              {formatSessionCostUsd(sumBy(sessions, (session) => session.total_cost))}
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>

      {total > 0 ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-muted-foreground text-xs tabular-nums">
            Showing {start}-{end} of {total} sessions
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
              disabled={data.next_offset == null}
              onClick={onNextPage}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export interface SessionsLevelProps {
  projectId: string;
  range: CostRange;
  onRangeChange: (next: CostRange) => void;
  onSelectSession: (sessionId: string) => void;
}

/**
 * The Sessions level (L2) of the Project -> Sessions -> Session drill-down.
 * Scoped to one project; owns its own owner/sort/page filters locally, while
 * `range` stays a controlled prop shared with the sibling levels (mirrors
 * `ProjectsLevel`'s split of state).
 */
export function SessionsLevel({
  projectId,
  range,
  onRangeChange,
  onSelectSession,
}: SessionsLevelProps) {
  const [filters, setFilters] = useState<SessionsLevelFilters>(DEFAULT_FILTERS);

  // A stale offset would page past the end of a different project's (usually
  // shorter) result set. The other three dimensions reset their own offset on
  // their own paths — owner inline in the Select's handler, sort in
  // `applySessionSort`, range in `handleRangeChange` below — so this covers
  // only the project switch, which none of them sees.
  useEffect(() => {
    setFilters((current) => (current.offset === 0 ? current : { ...current, offset: 0 }));
  }, [projectId]);

  const summaryQuery = useCostSummary({ projectId, from: range.from, to: range.to });
  const ownerCatalogQuery = useSessionCosts(buildSessionsLevelOwnerCatalogInput(projectId, range));
  const sessionsQuery = useSessionCosts(buildSessionsLevelListInput(projectId, range, filters));

  const ownerOptions = collectOwnerOptions(ownerCatalogQuery.data?.sessions ?? []);

  const handleRangeChange = (next: CostRange) => {
    setFilters((current) => ({ ...current, offset: 0 }));
    onRangeChange(next);
  };

  const controls = (
    <>
      <Select
        value={filters.ownerId ?? 'all'}
        onValueChange={(value) =>
          setFilters((current) => ({
            ...current,
            ownerId: value === 'all' ? null : value,
            offset: 0,
          }))
        }
      >
        <Hint
          label="Reflects the top-spending sessions in this window — an owner whose sessions never rank there may not be listed."
          side="bottom"
        >
          <SelectTrigger className="h-8 w-[180px]" aria-label="Filter sessions by owner">
            <SelectValue placeholder="All owners" />
          </SelectTrigger>
        </Hint>
        <SelectContent>
          <SelectItem value="all">All owners</SelectItem>
          {ownerOptions.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* The sort `<Select>` that used to sit here is gone. It offered
          "Highest spend" and "Most recent" — `total_desc` and `recent` — both
          of which the Total and Session column headers now select directly,
          and the headers additionally reach `total_asc`, which the Select
          never exposed. Two controls doing one job means a state the reader
          has to reconcile: a dropdown reading "Highest spend" beside a Total
          header showing an ascending arrow. The header is the one that says
          WHICH column it orders, so it is the one that stays. */}
      <CostExportButton
        kind="sessions"
        range={range}
        filters={buildSessionsLevelExportFilters(projectId, filters)}
      />
    </>
  );

  return (
    <CostLevelShell
      range={range}
      onRangeChange={handleRangeChange}
      summary={summaryQuery.data}
      isSummaryLoading={summaryQuery.isLoading}
      summaryError={summaryQuery.error instanceof Error ? summaryQuery.error : null}
      controls={controls}
    >
      <SessionsLevelTable
        data={sessionsQuery.data}
        isLoading={sessionsQuery.isLoading}
        error={sessionsQuery.error instanceof Error ? sessionsQuery.error : null}
        sort={filters.sort}
        onSort={(column) => setFilters((current) => applySessionSort(current, column))}
        onSelectSession={onSelectSession}
        onPreviousPage={() =>
          setFilters((current) => ({
            ...current,
            offset: Math.max(0, current.offset - SESSION_COST_PAGE_SIZE),
          }))
        }
        onNextPage={() =>
          setFilters((current) => ({
            ...current,
            offset: sessionsQuery.data?.next_offset ?? current.offset,
          }))
        }
      />
    </CostLevelShell>
  );
}
