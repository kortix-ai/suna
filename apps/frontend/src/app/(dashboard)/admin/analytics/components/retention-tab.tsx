'use client';

import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Pagination } from '@/components/agents/pagination';
import { DataTable, DataTableColumn } from '@/components/ui/data-table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  useRetentionCohorts,
  useRetentionData,
  type CohortRetentionRow,
  type RetentionData,
} from '@/hooks/admin/use-admin-analytics';
import { cn } from '@/lib/utils';
import { UserEmailLink } from './user-email-link';
import type { RetentionTabProps } from '../types';

type RetentionView = 'users' | 'cohorts';

type CohortWeekField =
  | 'week_1_pct'
  | 'week_2_pct'
  | 'week_3_pct'
  | 'week_4_pct'
  | 'week_5_pct'
  | 'week_6_pct'
  | 'week_7_pct'
  | 'week_8_pct'
  | 'week_9_pct'
  | 'week_10_pct'
  | 'week_11_pct'
  | 'week_12_pct';

const COHORT_WEEK_FIELDS: CohortWeekField[] = [
  'week_1_pct',
  'week_2_pct',
  'week_3_pct',
  'week_4_pct',
  'week_5_pct',
  'week_6_pct',
  'week_7_pct',
  'week_8_pct',
  'week_9_pct',
  'week_10_pct',
  'week_11_pct',
  'week_12_pct',
];

const getRetentionClass = (value: number | null) => {
  if (value === null) {
    return 'bg-background text-muted-foreground';
  }
  if (value >= 60) {
    return 'bg-emerald-100 text-emerald-900 dark:bg-emerald-500/20 dark:text-emerald-200';
  }
  if (value >= 40) {
    return 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300';
  }
  return 'bg-muted/50 text-muted-foreground';
};

const formatCohortDate = (dateString: string) => {
  return new Date(`${dateString}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
};

export function RetentionTab({ onUserClick }: RetentionTabProps) {
  const [view, setView] = useState<RetentionView>('users');
  const [retentionParams, setRetentionParams] = useState({
    page: 1,
    page_size: 15,
    weeks_back: 4,
    min_weeks_active: 2,
  });
  const [cohortParams, setCohortParams] = useState({
    cohorts_back: 8,
    weeks_to_measure: 4,
  });

  const { data: retentionData, isLoading: retentionLoading } = useRetentionData(retentionParams, view === 'users');
  const { data: cohortData, isLoading: cohortLoading } = useRetentionCohorts(cohortParams, view === 'cohorts');

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const weekNumbers = useMemo(
    () => Array.from({ length: cohortParams.weeks_to_measure }, (_, i) => i + 1),
    [cohortParams.weeks_to_measure],
  );

  const cohortRows = cohortData?.rows || [];

  const retentionColumns: DataTableColumn<RetentionData>[] = useMemo(() => [
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
      <Tabs value={view} onValueChange={(value) => setView(value as RetentionView)} className="gap-4">
        <TabsList>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="cohorts">Cohorts</TabsTrigger>
        </TabsList>

        <TabsContent value="users" className="mt-0 space-y-6">
          <div className="rounded-xl border bg-card">
            <div className="p-5 border-b flex items-center justify-between">
              <div>
                <h2 className="text-sm font-medium">Weekly Retention</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {`Users active in ${retentionParams.min_weeks_active}+ different weeks over the past ${retentionParams.weeks_back} weeks`}
                </p>
              </div>

              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground">Weeks</Label>
                  <Select
                    value={retentionParams.weeks_back.toString()}
                    onValueChange={(v) => setRetentionParams({ ...retentionParams, weeks_back: parseInt(v, 10), page: 1 })}
                  >
                    <SelectTrigger className="w-24 h-8 text-xs">
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

                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground">Min Active</Label>
                  <Select
                    value={retentionParams.min_weeks_active.toString()}
                    onValueChange={(v) => setRetentionParams({ ...retentionParams, min_weeks_active: parseInt(v, 10), page: 1 })}
                  >
                    <SelectTrigger className="w-24 h-8 text-xs">
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
            </div>

            <div className="p-0">
              {retentionLoading ? (
                <div className="p-5 space-y-3">
                  {[...Array(5)].map((_, i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                  ))}
                </div>
              ) : (
                <DataTable
                  columns={retentionColumns}
                  data={retentionData?.data || []}
                  emptyMessage="No recurring users found"
                  getItemId={(user) => user.user_id}
                />
              )}
            </div>
          </div>

          {retentionData?.pagination && (
            <Pagination
              currentPage={retentionData.pagination.current_page}
              totalPages={retentionData.pagination.total_pages}
              totalItems={retentionData.pagination.total_items}
              pageSize={retentionData.pagination.page_size}
              onPageChange={(page) => setRetentionParams({ ...retentionParams, page })}
              showPageSizeSelector={false}
            />
          )}
        </TabsContent>

        <TabsContent value="cohorts" className="mt-0">
          <div className="rounded-xl border bg-card">
            <div className="p-5 border-b flex items-center justify-between gap-4">
              <div>
                <h2 className="text-sm font-medium">Weekly Cohort Retention</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Users grouped by the week they first used Suna, then tracked by weekly return rate.
                </p>
              </div>

              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground">Cohorts</Label>
                  <Select
                    value={cohortParams.cohorts_back.toString()}
                    onValueChange={(v) => setCohortParams({ ...cohortParams, cohorts_back: parseInt(v, 10) })}
                  >
                    <SelectTrigger className="w-24 h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="6">6 weeks</SelectItem>
                      <SelectItem value="8">8 weeks</SelectItem>
                      <SelectItem value="12">12 weeks</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground">Columns</Label>
                  <Select
                    value={cohortParams.weeks_to_measure.toString()}
                    onValueChange={(v) => setCohortParams({ ...cohortParams, weeks_to_measure: parseInt(v, 10) })}
                  >
                    <SelectTrigger className="w-24 h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="4">4 weeks</SelectItem>
                      <SelectItem value="8">8 weeks</SelectItem>
                      <SelectItem value="12">12 weeks</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            <div className="p-0">
              {cohortLoading ? (
                <div className="p-5 space-y-3">
                  {[...Array(5)].map((_, i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                  ))}
                </div>
              ) : cohortRows.length === 0 ? (
                <div className="p-8 text-sm text-muted-foreground text-center">
                  No cohort retention data found
                </div>
              ) : (
                <>
                  <Table className="min-w-[880px]">
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cohort</TableHead>
                        <TableHead className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground text-right">Users</TableHead>
                        {weekNumbers.map((week) => (
                          <TableHead
                            key={week}
                            className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground text-center"
                          >
                            Week {week}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {cohortRows.map((row: CohortRetentionRow) => (
                        <TableRow key={`${row.cohort_week_start}-${row.cohort_week_end}`}>
                          <TableCell className="px-4 py-3 font-medium">
                            {formatCohortDate(row.cohort_week_start)} - {formatCohortDate(row.cohort_week_end)}
                          </TableCell>
                          <TableCell className="px-4 py-3 text-right font-semibold">{row.cohort_size}</TableCell>
                          {weekNumbers.map((week) => {
                            const value = row[COHORT_WEEK_FIELDS[week - 1]];

                            return (
                              <TableCell
                                key={`${row.cohort_week_start}-${week}`}
                                className={cn('px-4 py-3 text-center font-semibold', getRetentionClass(value))}
                              >
                                {value === null ? '—' : `${value}%`}
                              </TableCell>
                            );
                          })}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>

                  <div className="border-t px-5 py-3 flex items-center justify-center gap-6 text-xs text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <span className="size-3 rounded-sm bg-emerald-100 dark:bg-emerald-500/20" />
                      60%+ retention
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="size-3 rounded-sm bg-emerald-50 dark:bg-emerald-500/10" />
                      40-60% retention
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="size-3 rounded-sm bg-muted/50" />
                      Below 40%
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
