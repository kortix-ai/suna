'use client';

import {
  ArrowDownIcon as ArrowDown,
  ArrowUpIcon as ArrowUp,
  CaretLeftIcon as ChevronLeft,
  CaretRightIcon as ChevronRight,
  ArrowSquareOutIcon as ExternalLink,
  KanbanIcon as FolderKanban,
  ArrowClockwiseIcon as RefreshCw,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useCallback, useState } from 'react';

import { Button } from '@/components/ui/button';
import { IconInbox } from '@/components/ui/kortix-icons';
import { PageSearchBar } from '@/components/ui/page-search-bar';
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
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/features/layout/section/empty-state';
import {
  useAdminWorkspaces,
  type AdminWorkspacesSortBy,
  type AdminWorkspacesSortDir,
} from '@/hooks/admin/use-admin-workspaces';
import { useDebounce } from '@/hooks/use-debounced-value';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';

import { SectionContainer, SectionHeader, StatPill, StatRow } from '../_components/section-header';

const PAGE_SIZE = 50;

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'archived', label: 'Archived' },
] as const;

type StatusFilter = (typeof STATUS_OPTIONS)[number]['value'];

/** Absolute date for the Created column — same format the accounts table uses. */
function shortDate(value: string | null): string {
  if (!value) return '—';
  const t = new Date(value);
  if (!Number.isFinite(+t)) return '—';
  return t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function AdminWorkspacesPage() {
  const [searchInput, setSearchInput] = useState('');
  const search = useDebounce(searchInput);
  const [status, setStatus] = useState<StatusFilter>('all');
  // One state object, not two: the sort column and its direction always change
  // together, and a header click derives the new direction from the old column.
  const [sort, setSortState] = useState<{
    by: AdminWorkspacesSortBy;
    dir: AdminWorkspacesSortDir;
  }>({ by: 'activity', dir: 'desc' });
  const { by: sortBy, dir: sortDir } = sort;
  const [page, setPage] = useState(1);

  // Page 1 on a new search term. `search` is debounced, so it lands a tick after
  // the keystroke and cannot be reset inside the input's own handler — this is
  // React's "adjust state while rendering" pattern, not an effect: it re-renders
  // before anything paints, so page 5 of the old query is never shown against
  // the new one. Status and sort reset `page` directly in their handlers below.
  const [searchAtPage, setSearchAtPage] = useState(search);
  if (search !== searchAtPage) {
    setSearchAtPage(search);
    setPage(1);
  }

  const { data, isLoading, isFetching, refetch } = useAdminWorkspaces({
    search,
    status: status === 'all' ? [] : [status],
    sortBy,
    sortDir,
    page,
    limit: PAGE_SIZE,
  });

  const workspaces = data?.workspaces ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Scoped to the rendered page on purpose — the route pages the rows, so a
  // fleet-wide live-session count is not available here and must not be implied.
  const liveOnPage = workspaces.reduce((n, workspace) => n + workspace.activeSessionCount, 0);

  // Re-clicking the active column flips direction; a new column starts at desc
  // (newest / most sessions first, which is what an operator wants to see).
  const setSort = useCallback((column: AdminWorkspacesSortBy) => {
    setSortState((s) =>
      s.by === column
        ? { by: column, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { by: column, dir: 'desc' },
    );
    setPage(1);
  }, []);

  const applyStatus = useCallback((next: StatusFilter) => {
    setStatus(next);
    setPage(1);
  }, []);

  const resetFilters = () => {
    setSearchInput('');
    setStatus('all');
    setPage(1);
  };

  const filtered = search.length > 0 || status !== 'all';

  return (
    <SectionContainer>
      <SectionHeader
        icon={FolderKanban}
        title="Workspaces"
        description="Every workspace across every account, most-active first. Activity is the newest session on the workspace, not the last row edit."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            className="gap-1.5"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
            Refresh
          </Button>
        }
      />

      <StatRow className="sm:grid-cols-2 lg:grid-cols-2">
        <StatPill
          label="Total filtered"
          value={total.toLocaleString()}
          hint={filtered ? 'Matches current filters' : 'All workspaces'}
        />
        <StatPill
          label="Live sessions"
          value={liveOnPage.toLocaleString()}
          tone={liveOnPage > 0 ? 'success' : 'default'}
          hint={`On this page (${workspaces.length} of ${total.toLocaleString()})`}
        />
      </StatRow>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <PageSearchBar
          value={searchInput}
          onChange={setSearchInput}
          placeholder="Search by workspace name, account name, or owner email"
        />
        <Select value={status} onValueChange={(v) => applyStatus(v as StatusFilter)}>
          <SelectTrigger className="h-9 w-[170px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent align="end">
            {STATUS_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(8)].map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-2xl" />
          ))}
        </div>
      ) : workspaces.length === 0 ? (
        <div className="border-border/60 bg-card rounded-2xl border">
          <EmptyState
            icon={IconInbox}
            title={filtered ? 'No workspaces match your filters' : 'No workspaces yet'}
            description={
              filtered ? 'Try adjusting the status filter or clearing the search.' : undefined
            }
            action={
              filtered ? (
                <Button variant="outline" size="sm" onClick={resetFilters}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div
          className={cn(
            'border-border/60 overflow-hidden rounded-2xl border transition-opacity',
            isFetching && 'opacity-70',
          )}
        >
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Workspace</TableHead>
                <TableHead>Account</TableHead>
                <SortHeader
                  label="Sessions"
                  column="sessions"
                  sortBy={sortBy}
                  sortDir={sortDir}
                  onSort={setSort}
                  align="right"
                />
                <SortHeader
                  label="Last activity"
                  column="activity"
                  sortBy={sortBy}
                  sortDir={sortDir}
                  onSort={setSort}
                />
                <SortHeader
                  label="Created"
                  column="created"
                  sortBy={sortBy}
                  sortDir={sortDir}
                  onSort={setSort}
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              {workspaces.map((workspace) => (
                <TableRow key={workspace.workspaceId}>
                  <TableCell>
                    <div className="max-w-[320px] min-w-0">
                      <Link
                        href={`/workspaces/${workspace.workspaceId}`}
                        className="group inline-flex max-w-full items-center gap-1.5 text-sm font-medium"
                      >
                        <span className="truncate group-hover:underline">
                          {workspace.name || 'Unnamed workspace'}
                        </span>
                        <ExternalLink className="text-muted-foreground h-3 w-3 shrink-0" />
                      </Link>
                      <div className="text-muted-foreground truncate text-xs">
                        <span className="font-mono">{workspace.workspaceId.slice(0, 8)}</span>
                        {workspace.status === 'archived' && (
                          <>
                            <span className="mx-1.5 opacity-50">·</span>
                            <span>Archived</span>
                          </>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="max-w-[280px] min-w-0">
                      {workspace.ownerEmail ? (
                        <Link
                          href={`/admin/accounts?search=${encodeURIComponent(workspace.ownerEmail)}`}
                          className="block truncate text-sm hover:underline"
                        >
                          {workspace.ownerEmail}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground text-sm">No owner email</span>
                      )}
                      <div className="text-muted-foreground truncate text-xs">
                        {workspace.accountName || 'Unnamed account'}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums">
                    <span
                      className={cn(
                        workspace.activeSessionCount > 0
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-muted-foreground',
                      )}
                    >
                      {workspace.activeSessionCount}
                    </span>
                    <span className="text-muted-foreground/50 mx-0.5">/</span>
                    <span>{workspace.sessionCount}</span>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {workspace.lastSessionAt ? relativeTime(workspace.lastSessionAt) : 'Never run'}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {shortDate(workspace.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {pages > 1 && (
        <div className="text-muted-foreground flex items-center justify-between text-sm">
          <span>
            Page {page} of {pages} · {total.toLocaleString()} workspaces
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1 px-2.5"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1 px-2.5"
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
              disabled={page === pages}
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </SectionContainer>
  );
}

function SortHeader({
  label,
  column,
  sortBy,
  sortDir,
  onSort,
  align = 'left',
}: {
  label: string;
  column: AdminWorkspacesSortBy;
  sortBy: AdminWorkspacesSortBy;
  sortDir: AdminWorkspacesSortDir;
  onSort: (col: AdminWorkspacesSortBy) => void;
  align?: 'left' | 'right';
}) {
  const active = sortBy === column;
  return (
    <TableHead className={align === 'right' ? 'text-right' : ''}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          'inline-flex items-center gap-1 text-xs font-medium tracking-wider uppercase transition-colors',
          active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        {label}
        {active ? (
          sortDir === 'asc' ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          )
        ) : (
          <ArrowDown className="h-3 w-3 opacity-0" />
        )}
      </button>
    </TableHead>
  );
}
