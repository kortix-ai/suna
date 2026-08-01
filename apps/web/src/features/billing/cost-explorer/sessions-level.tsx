'use client';

import { useEffect, useState } from 'react';

import type { SessionCostSort, SessionCostsPage, SessionCostSummary } from '@kortix/sdk';
import { ReceiptIcon as ReceiptText } from '@phosphor-icons/react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { CostRange } from '@/components/ui/date-range-picker';
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

import { CostLevelShell } from './cost-level-shell';
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

const SORT_OPTIONS: { value: SessionCostSort; label: string }[] = [
  { value: 'total_desc', label: 'Highest spend' },
  { value: 'recent', label: 'Most recent' },
];

const DEFAULT_FILTERS: SessionsLevelFilters = { ownerId: null, sort: 'total_desc', offset: 0 };

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
 * session list at a fixed page.
 *
 * Known limitation: an owner whose sessions never rank in the top
 * `SESSION_COST_PAGE_SIZE` by spend for the current window will not appear
 * in the dropdown until their spend rises high enough to place on that page.
 */
export function buildSessionsLevelOwnerCatalogInput(
  projectId: string,
  range: CostRange,
): SessionsLevelListInput {
  return {
    projectId,
    limit: SESSION_COST_PAGE_SIZE,
    offset: 0,
    from: range.from,
    to: range.to,
    sort: 'total_desc',
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

  if (isLoading && !data) {
    return (
      <div className="space-y-2" aria-label="Loading sessions">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full rounded-md" />
        ))}
      </div>
    );
  }

  const sessions = data?.sessions ?? [];
  const offset = data?.offset ?? 0;
  const total = data?.total ?? 0;
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
            <TableHead>Session</TableHead>
            <TableHead>Owner</TableHead>
            <TableHead className="text-right">Requests</TableHead>
            <TableHead className="text-right">LLM</TableHead>
            <TableHead className="text-right">Compute</TableHead>
            <TableHead className="text-right">Total</TableHead>
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
            <TableCell colSpan={2} className="font-medium">
              Total
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
              disabled={data?.next_offset == null}
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
  // shorter) result set. Owner/sort changes reset their own offset inline;
  // range changes reset via handleRangeChange below — this only covers the
  // one dimension neither of those paths does.
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
        <SelectTrigger className="h-8 w-[180px]" aria-label="Filter sessions by owner">
          <SelectValue placeholder="All owners" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All owners</SelectItem>
          {ownerOptions.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filters.sort}
        onValueChange={(value) =>
          setFilters((current) => ({ ...current, sort: value as SessionCostSort, offset: 0 }))
        }
      >
        <SelectTrigger className="h-8 w-[160px]" aria-label="Sort sessions">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SORT_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
