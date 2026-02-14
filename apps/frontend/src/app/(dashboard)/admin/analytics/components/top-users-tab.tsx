'use client';

import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Pagination } from '@/components/agents/pagination';
import { DataTable, DataTableColumn } from '@/components/ui/data-table';
import { useDailyTopUsers, type DailyTopUserData } from '@/hooks/admin/use-admin-analytics';
import { UserEmailLink } from './user-email-link';
import type { TopUsersTabProps } from '../types';

export function TopUsersTab({ onUserClick, filterDateFrom, filterDateTo }: TopUsersTabProps) {
  const [dailyParams, setDailyParams] = useState({
    page: 1,
    page_size: 15,
    timezone: 'UTC',
  });

  const dailyQueryParams = {
    ...dailyParams,
    date_from: filterDateFrom ?? undefined,
    date_to: filterDateTo ?? undefined,
  };

  const { data: topUsersInRangeData, isLoading } = useDailyTopUsers(dailyQueryParams, true);

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const dailyColumns: DataTableColumn<DailyTopUserData>[] = useMemo(() => [
    {
      id: 'user',
      header: 'User',
      cell: (user) => (
        <div>
          <UserEmailLink email={user.email} onUserClick={onUserClick} className="font-medium" />
          <p className="text-xs text-muted-foreground font-mono">{user.user_id.slice(0, 8)}...</p>
        </div>
      ),
    },
    {
      id: 'active_days',
      header: 'Active Days',
      cell: (user) => (
        <div className="text-center">
          <Badge variant={user.active_days >= 20 ? 'default' : 'secondary'}>
            {user.active_days} days
          </Badge>
        </div>
      ),
      width: 'w-32',
    },
    {
      id: 'threads',
      header: 'Threads (Range)',
      cell: (user) => (
        <div className="text-center font-semibold">
          {Number.isFinite(user.threads_in_range) ? user.threads_in_range : '—'}
        </div>
      ),
      width: 'w-28',
    },
    {
      id: 'agent_runs',
      header: 'Agent Runs (Range)',
      cell: (user) => (
        <div className="text-center font-semibold">
          {Number.isFinite(user.agent_runs_in_range) ? user.agent_runs_in_range : '—'}
        </div>
      ),
      width: 'w-36',
    },
    {
      id: 'first_activity',
      header: 'First Activity',
      cell: (user) => (
        <span className="text-sm text-muted-foreground">
          {formatDate(user.first_activity)}
        </span>
      ),
      width: 'w-32',
    },
    {
      id: 'last_activity',
      header: 'Last Activity',
      cell: (user) => (
        <span className="text-sm text-muted-foreground">
          {formatDate(user.last_activity)}
        </span>
      ),
      width: 'w-32',
    },
  ], [onUserClick]);

  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-card">
        <div className="p-5 border-b">
          <h2 className="text-sm font-medium">Top Daily Users</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Users ranked by threads, then agent runs, in selected range (trigger activity excluded)
          </p>
        </div>

        <div className="p-0">
          {isLoading ? (
            <div className="p-5 space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <DataTable
              columns={dailyColumns}
              data={topUsersInRangeData?.data || []}
              emptyMessage="No top daily users found"
              getItemId={(user) => user.user_id}
            />
          )}
        </div>
      </div>

      {topUsersInRangeData?.pagination && (
        <Pagination
          currentPage={topUsersInRangeData.pagination.current_page}
          totalPages={topUsersInRangeData.pagination.total_pages}
          totalItems={topUsersInRangeData.pagination.total_items}
          pageSize={topUsersInRangeData.pagination.page_size}
          onPageChange={(page) => setDailyParams({ ...dailyParams, page })}
          showPageSizeSelector={false}
        />
      )}
    </div>
  );
}
