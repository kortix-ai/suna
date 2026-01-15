'use client';

import { useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Pagination } from '@/components/agents/pagination';
import { DataTable, DataTableColumn } from '@/components/ui/data-table';
import { UserCheck } from 'lucide-react';
import { useRetentionData, type RetentionData } from '@/hooks/admin/use-admin-analytics';
import { UserEmailLink } from './user-email-link';
import type { RetentionTabProps } from '../types';

export function RetentionTab({ onUserClick }: RetentionTabProps) {
  const [params, setParams] = useState({
    page: 1,
    page_size: 15,
    weeks_back: 4,
    min_weeks_active: 2,
  });

  const { data: retentionData, isLoading } = useRetentionData(params);

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const columns: DataTableColumn<RetentionData>[] = useMemo(() => [
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
      id: 'weeks_active',
      header: 'Weeks Active',
      cell: (user) => (
        <div className="text-center">
          <Badge variant={user.weeks_active >= 3 ? 'default' : 'secondary'}>
            {user.weeks_active} weeks
          </Badge>
        </div>
      ),
      width: 'w-32',
    },
    {
      id: 'threads',
      header: 'Total Threads',
      cell: (user) => (
        <div className="text-center font-semibold">{user.total_threads}</div>
      ),
      width: 'w-28',
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
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex gap-4">
        <div className="w-[150px]">
          <Label className="text-sm">Weeks to Analyze</Label>
          <Select
            value={params.weeks_back.toString()}
            onValueChange={(v) => setParams({ ...params, weeks_back: parseInt(v), page: 1 })}
          >
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="2">2 weeks</SelectItem>
              <SelectItem value="4">4 weeks</SelectItem>
              <SelectItem value="8">8 weeks</SelectItem>
              <SelectItem value="12">12 weeks</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="w-[180px]">
          <Label className="text-sm">Min Weeks Active</Label>
          <Select
            value={params.min_weeks_active.toString()}
            onValueChange={(v) => setParams({ ...params, min_weeks_active: parseInt(v), page: 1 })}
          >
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">1+ week</SelectItem>
              <SelectItem value="2">2+ weeks</SelectItem>
              <SelectItem value="3">3+ weeks</SelectItem>
              <SelectItem value="4">4+ weeks</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserCheck className="h-5 w-5" />
            Recurring Users
          </CardTitle>
          <CardDescription>
            Users active in {params.min_weeks_active}+ different weeks over the past {params.weeks_back} weeks
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <DataTable
              columns={columns}
              data={retentionData?.data || []}
              emptyMessage="No recurring users found"
              getItemId={(user) => user.user_id}
            />
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {retentionData?.pagination && (
        <Pagination
          currentPage={retentionData.pagination.current_page}
          totalPages={retentionData.pagination.total_pages}
          totalItems={retentionData.pagination.total_items}
          pageSize={retentionData.pagination.page_size}
          onPageChange={(page) => setParams({ ...params, page })}
          showPageSizeSelector={false}
        />
      )}
    </div>
  );
}
