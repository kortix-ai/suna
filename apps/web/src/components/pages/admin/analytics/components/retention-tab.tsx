'use client';

import { useTranslations } from 'next-intl';

import { useState, useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Pagination } from '@/components/ui/pagination';
import { DataTable, DataTableColumn } from '@/components/ui/data-table';
import { useRetentionData, type RetentionData } from '@/hooks/admin/use-admin-analytics';
import { UserEmailLink } from './user-email-link';
import type { RetentionTabProps } from '../types';

export function RetentionTab({ onUserClick }: RetentionTabProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
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
    <div className="space-y-6">
      {/* Header with Filters */}
      <div className="rounded-2xl border bg-card">
        <div className="p-5 border-b flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium">{tHardcodedUi.raw('componentsPagesAdminAnalyticsComponentsRetentionTab.line91JsxTextRecurringUsers')}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{tHardcodedUi.raw('componentsPagesAdminAnalyticsComponentsRetentionTab.line93JsxTextUsersActiveIn')}{' '}{params.min_weeks_active}{tHardcodedUi.raw('componentsPagesAdminAnalyticsComponentsRetentionTab.line93JsxTextDifferentWeeksOverThePast')}{' '}{params.weeks_back} weeks
            </p>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">Weeks</Label>
              <Select
                value={params.weeks_back.toString()}
                onValueChange={(v) => setParams({ ...params, weeks_back: parseInt(v), page: 1 })}
              >
                <SelectTrigger className="w-24 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="2">{tHardcodedUi.raw('componentsPagesAdminAnalyticsComponentsRetentionTab.line108JsxTextText2Weeks')}</SelectItem>
                  <SelectItem value="4">{tHardcodedUi.raw('componentsPagesAdminAnalyticsComponentsRetentionTab.line109JsxTextText4Weeks')}</SelectItem>
                  <SelectItem value="8">{tHardcodedUi.raw('componentsPagesAdminAnalyticsComponentsRetentionTab.line110JsxTextText8Weeks')}</SelectItem>
                  <SelectItem value="12">{tHardcodedUi.raw('componentsPagesAdminAnalyticsComponentsRetentionTab.line111JsxTextText12Weeks')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">{tHardcodedUi.raw('componentsPagesAdminAnalyticsComponentsRetentionTab.line117JsxTextMinActive')}</Label>
              <Select
                value={params.min_weeks_active.toString()}
                onValueChange={(v) => setParams({ ...params, min_weeks_active: parseInt(v), page: 1 })}
              >
                <SelectTrigger className="w-24 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">{tHardcodedUi.raw('componentsPagesAdminAnalyticsComponentsRetentionTab.line126JsxTextText1Week')}</SelectItem>
                  <SelectItem value="2">{tHardcodedUi.raw('componentsPagesAdminAnalyticsComponentsRetentionTab.line127JsxTextText2Weeks')}</SelectItem>
                  <SelectItem value="3">{tHardcodedUi.raw('componentsPagesAdminAnalyticsComponentsRetentionTab.line128JsxTextText3Weeks')}</SelectItem>
                  <SelectItem value="4">{tHardcodedUi.raw('componentsPagesAdminAnalyticsComponentsRetentionTab.line129JsxTextText4Weeks')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* Table */}
        <div className="p-0">
          {isLoading ? (
            <div className="p-5 space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <DataTable
              columns={columns}
              data={retentionData?.data || []}
              emptyMessage={tHardcodedUi.raw('componentsPagesAdminAnalyticsComponentsRetentionTab.line148JsxAttrEmptymessageNoRecurringUsersFound')}
              getItemId={(user) => user.user_id}
            />
          )}
        </div>
      </div>

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
