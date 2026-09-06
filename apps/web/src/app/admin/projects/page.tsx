'use client';

import { ArrowSquareOutIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useCallback, useState } from 'react';

import { Button } from '@/components/ui/button';
import { IconInbox } from '@/components/ui/kortix-icons';
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
  useAdminProjects,
  type AdminProjectsSortBy,
  type AdminProjectsSortDir,
} from '@/hooks/admin/use-admin-projects';
import { useDebounce } from '@/hooks/use-debounced-value';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';

import { AdminPageShell, AdminRefreshButton } from '../_components/admin-page-shell';
import { AdminEmptyFrame, AdminTableFrame } from '../_components/admin-panel';
import { AdminPagination, AdminSearch, AdminSortHeader } from '../_components/admin-table';
import { StatGrid, StatTile } from '../_components/stat-tile';

const PAGE_SIZE = 50;

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'archived', label: 'Archived' },
] as const;

type StatusFilter = (typeof STATUS_OPTIONS)[number]['value'];

const shortDateFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/** Absolute date for the Created column — same format the accounts table uses. */
function shortDate(value: string | null): string {
  if (!value) return '—';
  const t = new Date(value);
  if (!Number.isFinite(+t)) return '—';
  return shortDateFormat.format(t);
}

export default function AdminProjectsPage() {
  const [searchInput, setSearchInput] = useState('');
  const search = useDebounce(searchInput);
  const [status, setStatus] = useState<StatusFilter>('all');
  // One state object, not two: the sort column and its direction always change
  // together, and a header click derives the new direction from the old column.
  const [sort, setSortState] = useState<{
    by: AdminProjectsSortBy;
    dir: AdminProjectsSortDir;
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

  const { data, isLoading, isFetching, refetch } = useAdminProjects({
    search,
    status: status === 'all' ? [] : [status],
    sortBy,
    sortDir,
    page,
    limit: PAGE_SIZE,
  });

  const projects = data?.projects ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Scoped to the rendered page on purpose — the route pages the rows, so a
  // fleet-wide live-session count is not available here and must not be implied.
  const liveOnPage = projects.reduce((n, p) => n + p.activeSessionCount, 0);

  // Re-clicking the active column flips direction; a new column starts at desc
  // (newest / most sessions first, which is what an operator wants to see).
  const setSort = useCallback((column: AdminProjectsSortBy) => {
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
    <AdminPageShell
      width="wide"
      title="Projects"
      description="Every project across every account, most-active first. Activity is the newest session on the project, not the last row edit."
    >
      {/* Two stat cards on their own row… */}
      <StatGrid className="sm:grid-cols-2 lg:grid-cols-2">
        <StatTile
          label="Total filtered"
          value={total.toLocaleString()}
          hint={filtered ? 'Matches the current filters' : 'All projects'}
        />
        <StatTile
          label="Live sessions"
          value={liveOnPage.toLocaleString()}
          tone={liveOnPage > 0 ? 'success' : 'default'}
          hint={`On this page (${projects.length} of ${total.toLocaleString()})`}
        />
      </StatGrid>

      {/* …then one control line under them: search takes the width, the status
          select and refresh sit at its end. All three are h-9, so the row is
          level. Below `sm` they stack full-width — search, then select, then
          refresh — which is the whole mobile response this page needs. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <AdminSearch
            value={searchInput}
            onChange={setSearchInput}
            placeholder="Search projects, accounts, owners"
          />
        </div>
        <Select value={status} onValueChange={(v) => applyStatus(v as StatusFilter)}>
          <SelectTrigger className="w-full sm:w-44">
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
        <AdminRefreshButton busy={isFetching} onRefresh={() => void refetch()} />
      </div>

      {isLoading ? (
        <ProjectsTableSkeleton />
      ) : projects.length === 0 ? (
        <AdminEmptyFrame>
          <EmptyState
            icon={IconInbox}
            size="sm"
            title={filtered ? 'No projects match these filters' : 'No projects yet'}
            description={
              filtered ? 'Try a different status, or clear the search.' : undefined
            }
            action={
              filtered ? (
                <Button variant="outline" size="sm" onClick={resetFilters}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        </AdminEmptyFrame>
      ) : (
        <AdminTableFrame busy={isFetching}>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Project</TableHead>
                <TableHead>Account</TableHead>
                <AdminSortHeader
                  label="Sessions"
                  column="sessions"
                  sortBy={sortBy}
                  sortDir={sortDir}
                  onSort={setSort}
                  align="right"
                />
                <AdminSortHeader
                  label="Last activity"
                  column="activity"
                  sortBy={sortBy}
                  sortDir={sortDir}
                  onSort={setSort}
                />
                <AdminSortHeader
                  label="Created"
                  column="created"
                  sortBy={sortBy}
                  sortDir={sortDir}
                  onSort={setSort}
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.map((project) => (
                <TableRow key={project.projectId}>
                  <TableCell>
                    <div className="max-w-[320px] min-w-0">
                      <Link
                        href={`/projects/${project.projectId}`}
                        className="group inline-flex max-w-full items-center gap-1.5 text-sm font-medium"
                      >
                        <span className="truncate group-hover:underline">
                          {project.name || 'Unnamed project'}
                        </span>
                        <ArrowSquareOutIcon className="text-muted-foreground size-3 shrink-0" />
                      </Link>
                      <div className="text-muted-foreground truncate text-xs">
                        <span className="font-mono">{project.projectId.slice(0, 8)}</span>
                        {project.status === 'archived' && (
                          <>
                            <span className="text-muted-foreground/40 mx-1.5">·</span>
                            <span>Archived</span>
                          </>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="max-w-[280px] min-w-0">
                      {project.ownerEmail ? (
                        <Link
                          href={`/admin/accounts?search=${encodeURIComponent(project.ownerEmail)}`}
                          className="block truncate text-sm hover:underline"
                        >
                          {project.ownerEmail}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground text-sm">No owner email</span>
                      )}
                      <div className="text-muted-foreground truncate text-xs">
                        {project.accountName || 'Unnamed account'}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums">
                    {/* Live count carries the hue; the total never does — a
                        project with no live session is not a warning. */}
                    <span
                      className={cn(
                        project.activeSessionCount > 0
                          ? 'text-kortix-green'
                          : 'text-muted-foreground',
                      )}
                    >
                      {project.activeSessionCount}
                    </span>
                    <span className="text-muted-foreground/40 mx-0.5">/</span>
                    <span>{project.sessionCount}</span>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {project.lastSessionAt ? relativeTime(project.lastSessionAt) : 'Never run'}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {shortDate(project.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </AdminTableFrame>
      )}

      <AdminPagination
        page={page}
        pages={pages}
        total={total}
        noun="projects"
        onPageChange={setPage}
      />
    </AdminPageShell>
  );
}

/**
 * Shape-matched placeholder: one header band plus eight row bands inside the
 * table's own frame, so the page does not jump when the rows land.
 */
function ProjectsTableSkeleton() {
  return (
    <div className="bg-popover overflow-hidden rounded-md border">
      <div className="bg-accent border-b px-5 py-2">
        <Skeleton className="h-4 w-40" />
      </div>
      <div className="divide-border divide-y">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-5 px-5 py-3">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="ml-auto h-4 w-16" />
            <Skeleton className="h-4 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}
