'use client';

import { useTranslations } from 'next-intl';

import { AdminUserDetailsDialog } from '@/components/admin/admin-user-details-dialog';
import { AdminUserTable } from '@/components/admin/admin-user-table';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useAnalyticsSummary,
  useCategoryDistribution,
  useChurnByDate,
  useConversionFunnel,
  useEngagementSummary,
  useMessageDistribution,
  useProfitability,
  useTaskPerformance,
  useTierDistribution,
} from '@/hooks/admin/use-admin-analytics';
import {
  useAdminUserList,
  useRefreshUserData,
  type UserSummary,
} from '@/hooks/admin/use-admin-users';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  addDays,
  format,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  startOfYear,
  subDays,
} from 'date-fns';
import {
  ArrowRight,
  BarChart3,
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  DollarSign,
  MessageSquare,
  TrendingUp,
  UserCheck,
  Users,
  Zap,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { DateRange } from 'react-day-picker';

import { LegacyBanner } from '@/components/admin/legacy-banner';
import dynamic from 'next/dynamic';
import { RetentionTab, ThreadBrowser, UserEmailLink } from './components';

// Heavy recharts surface — the only recharts consumer in this page and ~2.5k
// lines — that mounts only on the non-default "ARR Simulator" tab. Load it
// lazily so recharts and this component stay out of the analytics page chunk.
const ARRSimulator = dynamic(
  () => import('./components/arr-simulator').then((mod) => mod.ARRSimulator),
  {
    ssr: false,
    loading: () => <ARRSimulatorLoading />,
  },
);

function ARRSimulatorLoading() {
  const tHardcodedUi = useTranslations('hardcodedUi');

  return (
    <div className="text-muted-foreground flex items-center justify-center py-16 text-sm">
      {tHardcodedUi.raw('autoComponentsPagesAdminAnalyticsPageJsxTextLoadingSimulator146e359a')}
    </div>
  );
}

// Get current date in Berlin timezone
function getBerlinToday(): Date {
  const now = new Date();
  const berlinDate = now.toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
  const [year, month, day] = berlinDate.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export default function AdminAnalyticsPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [dateRange, setDateRange] = useState<DateRange>({
    from: getBerlinToday(),
    to: getBerlinToday(),
  });
  const clickedDateRef = useRef<Date | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [tierFilter, setTierFilter] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>('overview');
  const [tierViewMode, setTierViewMode] = useState<'revenue' | 'cost' | 'profit'>('revenue');
  const [includeStuckTasks, setIncludeStuckTasks] = useState(false);

  const handleCategoryFilter = (category: string | null) => {
    setCategoryFilter(category);
    if (category) setActiveTab('threads');
  };

  const handleTierFilter = (tier: string | null) => {
    setTierFilter(tier);
    if (tier && tier !== 'all') setActiveTab('threads');
  };

  // User details dialog state
  const [selectedUser, setSelectedUser] = useState<UserSummary | null>(null);
  const [isUserDialogOpen, setIsUserDialogOpen] = useState(false);
  const [pendingUserEmail, setPendingUserEmail] = useState<string | null>(null);

  const {
    data: userSearchResult,
    isLoading: isSearchingUser,
    isFetching: isUserFetching,
  } = useAdminUserList({
    page: 1,
    page_size: 1,
    search_email: pendingUserEmail || undefined,
  });

  const { refreshUserList, refreshUserStats } = useRefreshUserData();

  useEffect(() => {
    if (!pendingUserEmail || isSearchingUser || isUserFetching) return;

    if (userSearchResult?.data && userSearchResult.data.length > 0) {
      setSelectedUser(userSearchResult.data[0]);
      setIsUserDialogOpen(true);
      setPendingUserEmail(null);
    } else if (userSearchResult?.data && userSearchResult.data.length === 0) {
      toast.error(`User not found: ${pendingUserEmail}`);
      setPendingUserEmail(null);
    }
  }, [pendingUserEmail, userSearchResult, isSearchingUser, isUserFetching]);

  const handleUserEmailClick = (email: string) => setPendingUserEmail(email);
  const handleUserSelect = (user: UserSummary) => {
    setSelectedUser(user);
    setIsUserDialogOpen(true);
  };
  const handleCloseUserDialog = () => {
    setIsUserDialogOpen(false);
    setSelectedUser(null);
  };
  const handleRefreshUserData = () => {
    refreshUserList();
    refreshUserStats();
  };

  const berlinToday = getBerlinToday();
  const dateFromString = dateRange.from ? format(dateRange.from, 'yyyy-MM-dd') : undefined;
  const dateToString = dateRange.to ? format(dateRange.to, 'yyyy-MM-dd') : dateFromString;

  const { data: summary, isLoading: summaryLoading } = useAnalyticsSummary();
  const isThreadsTab = activeTab === 'threads';
  const isOverviewOrThreads = activeTab === 'overview' || activeTab === 'threads';
  const { data: distribution, isFetching: distributionFetching } = useMessageDistribution(
    dateFromString,
    dateToString,
    isThreadsTab,
  );
  const { data: categoryDistribution, isFetching: categoryFetching } = useCategoryDistribution(
    dateFromString,
    dateToString,
    tierFilter,
    isOverviewOrThreads,
  );
  const { data: tierDistribution } = useTierDistribution(
    dateFromString,
    dateToString,
    isThreadsTab,
  );
  const { data: conversionFunnel, isLoading: funnelLoading } = useConversionFunnel(
    dateFromString,
    dateToString,
    'vercel',
  );
  const {
    data: engagementSummary,
    isLoading: engagementLoading,
    isFetching: engagementFetching,
  } = useEngagementSummary(dateFromString, dateToString);
  const {
    data: taskPerformance,
    isLoading: taskLoading,
    isFetching: taskFetching,
  } = useTaskPerformance(dateFromString, dateToString);
  const {
    data: profitability,
    isLoading: profitabilityLoading,
    isFetching: profitabilityFetching,
  } = useProfitability(dateFromString, dateToString);

  const { data: churnData, isLoading: churnLoading } = useChurnByDate(
    dateFromString ?? '',
    dateToString ?? '',
  );

  const isOverviewFetching = engagementFetching || taskFetching || profitabilityFetching;

  // Navigation helpers
  const navigateDateRange = (direction: 'prev' | 'next') => {
    if (!dateRange.from) return;
    const toDate = dateRange.to || dateRange.from;
    const daysDiff = Math.round(
      (toDate.getTime() - dateRange.from.getTime()) / (1000 * 60 * 60 * 24),
    );

    if (direction === 'prev') {
      setDateRange({
        from: subDays(dateRange.from, daysDiff + 1),
        to: subDays(toDate, daysDiff + 1),
      });
    } else {
      const newTo = addDays(toDate, daysDiff + 1);
      const cappedTo = newTo > berlinToday ? berlinToday : newTo;
      const newFrom = addDays(dateRange.from, daysDiff + 1);
      const cappedFrom = newFrom > berlinToday ? berlinToday : newFrom;
      setDateRange({ from: cappedFrom, to: cappedTo });
    }
  };

  const isAtToday =
    (dateRange.to || dateRange.from) &&
    format(dateRange.to || dateRange.from!, 'yyyy-MM-dd') === format(berlinToday, 'yyyy-MM-dd');

  const dateLabel =
    dateRange.from && dateRange.to && dateRange.from.getTime() === dateRange.to.getTime()
      ? format(dateRange.from, 'MMM d, yyyy')
      : dateRange.from && dateRange.to
        ? `${format(dateRange.from, 'MMM d')} - ${format(dateRange.to, 'MMM d, yyyy')}`
        : dateRange.from
          ? format(dateRange.from, 'MMM d, yyyy')
          : 'Select date';

  return (
    <div className="bg-background min-h-screen">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-6">
          <LegacyBanner feature="Analytics" />
        </div>
        {/* Header */}
        <header className="mb-8">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
              <p className="text-muted-foreground mt-0.5 text-sm">
                {tHardcodedUi.raw(
                  'componentsPagesAdminAnalyticsPage.line181JsxTextPlatformHealthAndBusinessMetrics',
                )}
              </p>
            </div>

            {/* Date Navigation */}
            <div className="flex items-center gap-2">
              {/* Date Presets */}
              <div className="mr-2 flex items-center gap-1">
                {[
                  { label: 'Today', from: berlinToday, to: berlinToday },
                  { label: '7D', from: subDays(berlinToday, 6), to: berlinToday },
                  { label: '30D', from: subDays(berlinToday, 29), to: berlinToday },
                  {
                    label: 'WTD',
                    from: startOfWeek(berlinToday, { weekStartsOn: 1 }),
                    to: berlinToday,
                  },
                  { label: 'MTD', from: startOfMonth(berlinToday), to: berlinToday },
                  { label: 'QTD', from: startOfQuarter(berlinToday), to: berlinToday },
                  { label: 'YTD', from: startOfYear(berlinToday), to: berlinToday },
                ].map((preset) => {
                  const isActive =
                    dateRange.from &&
                    dateRange.to &&
                    format(dateRange.from, 'yyyy-MM-dd') === format(preset.from, 'yyyy-MM-dd') &&
                    format(dateRange.to, 'yyyy-MM-dd') === format(preset.to, 'yyyy-MM-dd');
                  return (
                    <Button
                      key={preset.label}
                      variant={isActive ? 'default' : 'ghost'}
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => setDateRange({ from: preset.from, to: preset.to })}
                    >
                      {preset.label}
                    </Button>
                  );
                })}
              </div>

              <div className="bg-border h-6 w-px" />

              {/* Custom Range */}
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => navigateDateRange('prev')}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>

              <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="h-8 px-3 text-xs font-normal">
                    <CalendarIcon className="text-muted-foreground mr-2 h-3.5 w-3.5" />
                    {dateLabel}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="end">
                  <Calendar
                    mode="range"
                    selected={dateRange}
                    onDayClick={(day) => {
                      clickedDateRef.current = day;
                    }}
                    onSelect={(newRange) => {
                      if (dateRange.from && dateRange.to && clickedDateRef.current) {
                        setDateRange({ from: clickedDateRef.current, to: undefined });
                        clickedDateRef.current = null;
                        return;
                      }
                      if (newRange?.from) setDateRange(newRange);
                      clickedDateRef.current = null;
                    }}
                    disabled={(date) => date > berlinToday}
                    numberOfMonths={1}
                    initialFocus
                  />
                  <div className="flex justify-end border-t p-2">
                    <Button
                      size="sm"
                      onClick={() => setCalendarOpen(false)}
                      disabled={!dateRange.from || !dateRange.to}
                    >
                      Apply
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>

              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                disabled={!!isAtToday}
                onClick={() => navigateDateRange('next')}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Tabs */}
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="bg-muted/50">
              <TabsTrigger value="overview" className="gap-1.5">
                <BarChart3 className="h-3.5 w-3.5" />
                Overview
              </TabsTrigger>
              <TabsTrigger value="threads" className="gap-1.5">
                <MessageSquare className="h-3.5 w-3.5" />
                Threads
              </TabsTrigger>
              <TabsTrigger value="users" className="gap-1.5">
                <Users className="h-3.5 w-3.5" />
                Users
              </TabsTrigger>
              <TabsTrigger value="retention" className="gap-1.5">
                <UserCheck className="h-3.5 w-3.5" />
                Retention
              </TabsTrigger>
              <TabsTrigger value="simulator" className="gap-1.5">
                <TrendingUp className="h-3.5 w-3.5" />
                ARR
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </header>

        {/* Content */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          {/* Overview Tab */}
          <TabsContent value="overview" className="mt-0">
            <div
              className={cn(
                'space-y-6 transition-opacity duration-200',
                isOverviewFetching && 'opacity-60',
              )}
            >
              {/* SECTION 1: Tasks & Users Analysis */}
              <section className="bg-card rounded-2xl border">
                <div className="border-b p-5 pb-4">
                  <h2 className="flex items-center gap-2 text-sm font-medium">
                    <Zap className="text-muted-foreground h-4 w-4" />
                    {tHardcodedUi.raw('componentsPagesAdminAnalyticsPage.line316JsxTextTasksUsers')}
                  </h2>
                </div>

                <div className="p-5">
                  {summaryLoading || engagementLoading || taskLoading || funnelLoading ? (
                    <div className="space-y-4">
                      <div className="grid grid-cols-5 gap-4">
                        {[...Array(5)].map((_, i) => (
                          <Skeleton key={i} className="h-20" />
                        ))}
                      </div>
                      <Skeleton className="h-24" />
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {/* Row 1: Core metrics */}
                      <div className="grid grid-cols-7 gap-3">
                        <div className="bg-muted/30 rounded-2xl p-3 text-center">
                          <p className="text-2xl font-bold">
                            {conversionFunnel?.visitors?.toLocaleString() || 0}
                          </p>
                          <p className="text-muted-foreground text-xs">Visitors</p>
                        </div>
                        <div className="bg-muted/30 rounded-2xl p-3 text-center">
                          <p className="text-2xl font-bold">
                            {conversionFunnel?.signups?.toLocaleString() || 0}
                          </p>
                          <p className="text-muted-foreground text-xs">
                            {tHardcodedUi.raw(
                              'componentsPagesAdminAnalyticsPage.line338JsxTextNewSignups',
                            )}
                          </p>
                        </div>
                        <div className="rounded-2xl bg-emerald-500/10 p-3 text-center">
                          <p className="text-2xl font-bold text-emerald-600">
                            {conversionFunnel?.subscriptions || 0}
                          </p>
                          <p className="text-muted-foreground text-xs">
                            {tHardcodedUi.raw(
                              'componentsPagesAdminAnalyticsPage.line342JsxTextNewPaid',
                            )}
                          </p>
                        </div>
                        <div className="bg-muted/30 rounded-2xl p-3 text-center">
                          <p className="text-2xl font-bold">
                            {taskPerformance?.total_runs?.toLocaleString() || 0}
                          </p>
                          <p className="text-muted-foreground text-xs">
                            {tHardcodedUi.raw(
                              'componentsPagesAdminAnalyticsPage.line346JsxTextTotalTasks',
                            )}
                          </p>
                        </div>
                        <div className="bg-muted/30 rounded-2xl p-3 text-center">
                          <p className="text-2xl font-bold">{engagementSummary?.dau || 0}</p>
                          <p className="text-muted-foreground text-xs">
                            {tHardcodedUi.raw(
                              'componentsPagesAdminAnalyticsPage.line350JsxTextActiveUsers',
                            )}
                          </p>
                        </div>
                        <div className="bg-muted/30 rounded-2xl p-3 text-center">
                          <p className="text-2xl font-bold">
                            {engagementSummary?.avg_threads_per_active_user?.toFixed(1) || '0'}
                          </p>
                          <p className="text-muted-foreground text-xs">Tasks/User</p>
                        </div>
                        <div className="bg-muted/30 rounded-2xl p-3 text-center">
                          <p
                            className={cn(
                              'text-2xl font-bold',
                              (taskPerformance?.success_rate || 0) >= 80
                                ? 'text-emerald-600'
                                : (taskPerformance?.success_rate || 0) >= 60
                                  ? 'text-amber-600'
                                  : 'text-red-500',
                            )}
                          >
                            {taskPerformance?.success_rate || 0}%
                          </p>
                          <p className="text-muted-foreground text-xs">
                            {tHardcodedUi.raw(
                              'componentsPagesAdminAnalyticsPage.line364JsxTextSuccessRate',
                            )}
                          </p>
                        </div>
                      </div>

                      {/* Row 2: Task Distribution & Duration */}
                      <div className="grid grid-cols-6 gap-3">
                        {/* Task Distribution - expanded */}
                        <div className="bg-muted/30 col-span-5 rounded-2xl p-4">
                          <div className="mb-3 flex items-center justify-between">
                            <p className="text-muted-foreground text-xs font-medium">
                              {tHardcodedUi.raw(
                                'componentsPagesAdminAnalyticsPage.line373JsxTextTaskDistributionByCategory',
                              )}
                            </p>
                            {categoryDistribution && (
                              <p className="text-muted-foreground text-xs">
                                {Object.values(categoryDistribution.distribution).reduce(
                                  (a, b) => a + b,
                                  0,
                                )}{' '}
                                total
                              </p>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {categoryDistribution &&
                              Object.entries(categoryDistribution.distribution)
                                .sort(([, a], [, b]) => b - a)
                                .map(([cat, count]) => {
                                  const total = Object.values(
                                    categoryDistribution.distribution,
                                  ).reduce((a, b) => a + b, 0);
                                  const percent =
                                    total > 0 ? ((count / total) * 100).toFixed(0) : 0;
                                  return (
                                    <div
                                      key={cat}
                                      className="bg-background flex items-center gap-2 rounded-2xl border px-3 py-1.5"
                                    >
                                      <span className="text-sm font-medium">{cat}</span>
                                      <span className="text-muted-foreground text-xs">{count}</span>
                                      <span className="text-muted-foreground/70 text-xs">
                                        ({percent}%)
                                      </span>
                                    </div>
                                  );
                                })}
                            {(!categoryDistribution ||
                              Object.keys(categoryDistribution.distribution).length === 0) && (
                              <p className="text-muted-foreground text-sm">
                                {tHardcodedUi.raw(
                                  'componentsPagesAdminAnalyticsPage.line395JsxTextNoTaskData',
                                )}
                              </p>
                            )}
                          </div>
                        </div>

                        {/* Avg Duration */}
                        <div className="bg-muted/30 relative flex flex-col justify-center rounded-2xl p-4 text-center">
                          <p className="text-2xl font-bold">
                            {(() => {
                              const duration = includeStuckTasks
                                ? taskPerformance?.avg_duration_with_stuck_seconds
                                : taskPerformance?.avg_duration_seconds;
                              if (!duration) return '—';
                              return duration < 60
                                ? `${duration.toFixed(0)}s`
                                : `${(duration / 60).toFixed(1)}m`;
                            })()}
                          </p>
                          <p className="text-muted-foreground mt-1 text-xs">
                            {tHardcodedUi.raw(
                              'componentsPagesAdminAnalyticsPage.line413JsxTextAvgTaskDuration',
                            )}
                          </p>
                          {(taskPerformance?.stuck_task_count ?? 0) > 0 && (
                            <button
                              onClick={() => setIncludeStuckTasks(!includeStuckTasks)}
                              className={cn(
                                'mt-1 cursor-pointer rounded px-1.5 py-0.5 text-xs transition-colors',
                                includeStuckTasks
                                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                                  : 'bg-muted text-muted-foreground hover:bg-muted/80',
                              )}
                              title={
                                includeStuckTasks
                                  ? 'Click to exclude stuck tasks'
                                  : 'Click to include stuck tasks'
                              }
                            >
                              {taskPerformance?.stuck_task_count} stuck{' '}
                              {includeStuckTasks ? '(included)' : '(excluded)'}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </section>

              {/* SECTION 2: DAU/WAU/MAU */}
              <section className="bg-card rounded-2xl border">
                <div className="border-b p-5 pb-4">
                  <h2 className="flex items-center gap-2 text-sm font-medium">
                    <Users className="text-muted-foreground h-4 w-4" />
                    Engagement
                  </h2>
                </div>

                <div className="p-5">
                  {engagementLoading ? (
                    <div className="grid grid-cols-4 gap-4">
                      {[...Array(4)].map((_, i) => (
                        <Skeleton key={i} className="h-20" />
                      ))}
                    </div>
                  ) : (
                    <div className="grid grid-cols-4 gap-4">
                      <div className="bg-muted/30 rounded-2xl p-4 text-center">
                        <p className="text-3xl font-bold">{engagementSummary?.dau || 0}</p>
                        <p className="text-muted-foreground mt-1 text-xs">DAU</p>
                        <p className="text-muted-foreground text-xs">
                          {tHardcodedUi.raw(
                            'componentsPagesAdminAnalyticsPage.line454JsxTextDailyActiveUsers',
                          )}
                        </p>
                      </div>
                      <div className="bg-muted/30 rounded-2xl p-4 text-center">
                        <p className="text-3xl font-bold">{engagementSummary?.wau || 0}</p>
                        <p className="text-muted-foreground mt-1 text-xs">WAU</p>
                        <p className="text-muted-foreground text-xs">
                          {tHardcodedUi.raw(
                            'componentsPagesAdminAnalyticsPage.line459JsxTextWeeklyActiveUsers',
                          )}
                        </p>
                      </div>
                      <div className="bg-muted/30 rounded-2xl p-4 text-center">
                        <p className="text-3xl font-bold">{engagementSummary?.mau || 0}</p>
                        <p className="text-muted-foreground mt-1 text-xs">MAU</p>
                        <p className="text-muted-foreground text-xs">
                          {tHardcodedUi.raw(
                            'componentsPagesAdminAnalyticsPage.line464JsxTextMonthlyActiveUsers',
                          )}
                        </p>
                      </div>
                      <div className="rounded-2xl bg-blue-500/10 p-4 text-center">
                        <p className="text-3xl font-bold text-blue-600">
                          {engagementSummary?.dau_mau_ratio || 0}%
                        </p>
                        <p className="text-muted-foreground mt-1 text-xs">DAU/MAU</p>
                        <p className="text-muted-foreground text-xs">
                          {tHardcodedUi.raw(
                            'componentsPagesAdminAnalyticsPage.line469JsxTextStickinessRatio',
                          )}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </section>

              {/* SECTION 3: Conversion Funnel */}
              <section className="bg-card rounded-2xl border">
                <div className="flex items-center justify-between border-b p-5 pb-4">
                  <h2 className="flex items-center gap-2 text-sm font-medium">
                    <TrendingUp className="text-muted-foreground h-4 w-4" />
                    {tHardcodedUi.raw(
                      'componentsPagesAdminAnalyticsPage.line481JsxTextConversionFunnel',
                    )}
                  </h2>
                </div>

                <div className="p-5">
                  {funnelLoading ? (
                    <Skeleton className="h-24" />
                  ) : conversionFunnel ? (
                    <div className="flex items-stretch">
                      {/* Visitors */}
                      <div className="bg-muted/30 border-background flex-1 rounded-l-lg border-r p-4 text-center">
                        <p className="text-3xl font-bold tracking-tight">
                          {conversionFunnel.visitors.toLocaleString()}
                        </p>
                        <p className="mt-1 text-sm font-medium">Visitors</p>
                        <p className="text-muted-foreground text-xs">100%</p>
                      </div>

                      {/* Arrow */}
                      <div className="bg-muted/30 flex items-center justify-center px-2">
                        <div className="text-center">
                          <ArrowRight className="text-muted-foreground mx-auto h-4 w-4" />
                          <span className="text-muted-foreground text-xs font-medium">
                            {conversionFunnel.visitor_to_signup_rate}%
                          </span>
                        </div>
                      </div>

                      {/* Signups */}
                      <div className="bg-muted/30 border-background flex-1 border-r p-4 text-center">
                        <p className="text-3xl font-bold tracking-tight">
                          {conversionFunnel.signups.toLocaleString()}
                        </p>
                        <p className="mt-1 text-sm font-medium">Signups</p>
                        <p className="text-muted-foreground text-xs">
                          {conversionFunnel.visitor_to_signup_rate}
                          {tHardcodedUi.raw(
                            'componentsPagesAdminAnalyticsPage.line513JsxTextOfVisitors',
                          )}
                        </p>
                      </div>

                      {/* Arrow */}
                      <div className="bg-muted/30 flex items-center justify-center px-2">
                        <div className="text-center">
                          <ArrowRight className="text-muted-foreground mx-auto h-4 w-4" />
                          <span className="text-muted-foreground text-xs font-medium">
                            {conversionFunnel.signup_to_subscription_rate}%
                          </span>
                        </div>
                      </div>

                      {/* Paid - with web/app breakdown */}
                      <div className="flex-1 rounded-r-lg bg-emerald-500/10 p-4 text-center">
                        <p className="text-3xl font-bold tracking-tight text-emerald-600">
                          {conversionFunnel.subscriptions.toLocaleString()}
                        </p>
                        <p className="mt-1 text-sm font-medium">Paid</p>
                        <p className="text-muted-foreground text-xs">
                          {conversionFunnel.visitors > 0
                            ? (
                                (conversionFunnel.subscriptions / conversionFunnel.visitors) *
                                100
                              ).toFixed(2)
                            : 0}
                          {tHardcodedUi.raw(
                            'componentsPagesAdminAnalyticsPage.line533JsxTextOfVisitors',
                          )}
                        </p>
                        {/* Web/App breakdown */}
                        <div className="mt-2 flex justify-center gap-3 text-xs">
                          <Popover>
                            <PopoverTrigger asChild>
                              <button className="cursor-pointer text-blue-600 hover:underline">
                                Web: {conversionFunnel.web_subscriber_emails?.length || 0}
                              </button>
                            </PopoverTrigger>
                            <PopoverContent className="max-h-60 w-72 overflow-y-auto">
                              <h4 className="mb-2 text-sm font-medium">
                                {tHardcodedUi.raw(
                                  'componentsPagesAdminAnalyticsPage.line544JsxTextWebSubscribers',
                                )}
                              </h4>
                              {conversionFunnel.web_subscriber_emails?.length > 0 ? (
                                <ul className="space-y-1">
                                  {conversionFunnel.web_subscriber_emails.map((email, idx) => (
                                    <li key={idx} className="text-sm">
                                      <UserEmailLink
                                        email={email}
                                        onUserClick={handleUserEmailClick}
                                      />
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="text-muted-foreground text-sm">
                                  {tHardcodedUi.raw(
                                    'componentsPagesAdminAnalyticsPage.line554JsxTextNoWebSubscribers',
                                  )}
                                </p>
                              )}
                            </PopoverContent>
                          </Popover>
                          <span className="text-muted-foreground">|</span>
                          <Popover>
                            <PopoverTrigger asChild>
                              <button className="cursor-pointer text-purple-600 hover:underline">
                                App: {conversionFunnel.app_subscriber_emails?.length || 0}
                              </button>
                            </PopoverTrigger>
                            <PopoverContent className="max-h-60 w-72 overflow-y-auto">
                              <h4 className="mb-2 text-sm font-medium">
                                {tHardcodedUi.raw(
                                  'componentsPagesAdminAnalyticsPage.line566JsxTextAppSubscribers',
                                )}
                              </h4>
                              {conversionFunnel.app_subscriber_emails?.length > 0 ? (
                                <ul className="space-y-1">
                                  {conversionFunnel.app_subscriber_emails.map((email, idx) => (
                                    <li key={idx} className="text-sm">
                                      <UserEmailLink
                                        email={email}
                                        onUserClick={handleUserEmailClick}
                                      />
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="text-muted-foreground text-sm">
                                  {tHardcodedUi.raw(
                                    'componentsPagesAdminAnalyticsPage.line576JsxTextNoAppSubscribers',
                                  )}
                                </p>
                              )}
                            </PopoverContent>
                          </Popover>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <p className="text-muted-foreground py-4 text-center text-sm">
                      {tHardcodedUi.raw(
                        'componentsPagesAdminAnalyticsPage.line585JsxTextAnalyticsNotConfigured',
                      )}
                    </p>
                  )}
                </div>
              </section>

              {/* SECTION 4: Financials */}
              <section className="bg-card rounded-2xl border">
                <div className="flex items-center justify-between border-b p-5 pb-4">
                  <h2 className="flex items-center gap-2 text-sm font-medium">
                    <DollarSign className="text-muted-foreground h-4 w-4" />
                    Financials
                  </h2>
                  {profitability && profitability.paying_user_emails?.length > 0 && (
                    <Popover>
                      <PopoverTrigger asChild>
                        <button className="text-primary text-xs hover:underline">
                          View {profitability.unique_paying_users}
                          {tHardcodedUi.raw(
                            'componentsPagesAdminAnalyticsPage.line602JsxTextPayingUsers',
                          )}
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className="max-h-60 w-72 overflow-y-auto">
                        <h4 className="mb-2 text-sm font-medium">
                          {tHardcodedUi.raw(
                            'componentsPagesAdminAnalyticsPage.line606JsxTextPayingUsers',
                          )}
                        </h4>
                        <ul className="space-y-1">
                          {profitability.paying_user_emails.map((email, idx) => (
                            <li key={idx} className="text-sm">
                              <UserEmailLink email={email} onUserClick={handleUserEmailClick} />
                            </li>
                          ))}
                        </ul>
                      </PopoverContent>
                    </Popover>
                  )}
                </div>

                <div className="p-5">
                  {profitabilityLoading ? (
                    <div className="space-y-4">
                      <div className="grid grid-cols-6 gap-4">
                        {[...Array(6)].map((_, i) => (
                          <Skeleton key={i} className="h-20" />
                        ))}
                      </div>
                      <Skeleton className="h-32" />
                    </div>
                  ) : profitability ? (
                    <div className="space-y-6">
                      {/* Row 1: Key financial metrics */}
                      <div className="grid grid-cols-6 gap-4">
                        <div className="bg-muted/30 rounded-2xl p-3 text-center">
                          <p className="text-xl font-bold">
                            {profitability.total_active_subscriptions?.toLocaleString() ?? '—'}
                          </p>
                          <p className="text-muted-foreground text-xs">
                            {tHardcodedUi.raw(
                              'componentsPagesAdminAnalyticsPage.line633JsxTextTotalActiveSubs',
                            )}
                          </p>
                          <p className="text-muted-foreground mt-1 text-xs">
                            Web:{' '}
                            {profitability.stripe_active_subscriptions?.toLocaleString() ?? '—'}
                            {tHardcodedUi.raw(
                              'componentsPagesAdminAnalyticsPage.line635JsxTextApp',
                            )}
                            {profitability.revenuecat_active_subscriptions?.toLocaleString() ?? '—'}
                          </p>
                        </div>
                        <div className="bg-muted/30 rounded-2xl p-3 text-center">
                          <p className="text-xl font-bold">—</p>
                          <p className="text-muted-foreground text-xs">MRR</p>
                        </div>
                        <div className="bg-muted/30 rounded-2xl p-3 text-center">
                          <p className="text-xl font-bold">
                            ${profitability.avg_revenue_per_paid_user.toFixed(0)}
                          </p>
                          <p className="text-muted-foreground text-xs">ARPU</p>
                        </div>
                        <div className="bg-muted/30 rounded-2xl p-3 text-center">
                          <p className="text-xl font-bold">
                            {churnLoading ? '...' : (churnData?.total ?? '—')}
                          </p>
                          <p className="text-muted-foreground text-xs">Churns</p>
                        </div>
                        <div className="bg-muted/30 rounded-2xl p-3 text-center">
                          <p className="text-xl font-bold">
                            {churnLoading
                              ? '...'
                              : churnData && profitability?.total_active_subscriptions
                                ? `${((churnData.total / profitability.total_active_subscriptions) * 100).toFixed(2)}%`
                                : '—'}
                          </p>
                          <p className="text-muted-foreground text-xs">
                            {tHardcodedUi.raw(
                              'componentsPagesAdminAnalyticsPage.line656JsxTextChurnRate',
                            )}
                          </p>
                        </div>
                        <div className="bg-muted/30 rounded-2xl p-3 text-center">
                          <p className="text-xl font-bold">—</p>
                          <p className="text-muted-foreground text-xs">LTV</p>
                        </div>
                      </div>

                      {/* Row 2: Revenue breakdown */}
                      <div className="grid grid-cols-2 gap-6">
                        {/* Revenue & Profit Summary */}
                        <div className="space-y-4">
                          <div className="flex items-center justify-between rounded-2xl bg-emerald-500/10 p-4">
                            <div>
                              <p className="text-muted-foreground text-xs">Revenue</p>
                              <p className="text-2xl font-bold text-emerald-600">
                                ${profitability.total_revenue.toLocaleString()}
                              </p>
                            </div>
                            <div className="text-right">
                              <p className="text-muted-foreground text-xs">Cost</p>
                              <p className="text-lg font-semibold">
                                ${profitability.total_actual_cost.toLocaleString()}
                              </p>
                            </div>
                            <div className="text-right">
                              <p className="text-muted-foreground text-xs">Profit</p>
                              <p
                                className={cn(
                                  'text-lg font-bold',
                                  profitability.gross_profit >= 0
                                    ? 'text-emerald-600'
                                    : 'text-red-500',
                                )}
                              >
                                {profitability.gross_profit < 0 ? '-' : ''}$
                                {Math.abs(profitability.gross_profit).toLocaleString()}
                              </p>
                            </div>
                            <div className="text-right">
                              <p className="text-muted-foreground text-xs">Margin</p>
                              <p className="text-lg font-semibold">
                                {profitability.gross_margin_percent}%
                              </p>
                            </div>
                          </div>

                          {/* Per User Metrics */}
                          <div className="relative mt-2 flex items-center justify-between rounded-2xl border p-3 pt-4">
                            <span className="text-muted-foreground absolute top-1 left-2 text-xs">
                              {tHardcodedUi.raw(
                                'componentsPagesAdminAnalyticsPage.line694JsxTextPerPayingUser',
                              )}
                              {profitability.unique_paying_users})
                            </span>
                            <div>
                              <p className="text-muted-foreground text-xs">Revenue/User</p>
                              <p className="text-sm font-semibold">
                                ${profitability.avg_revenue_per_paid_user.toFixed(2)}
                              </p>
                            </div>
                            <div className="text-right">
                              <p className="text-muted-foreground text-xs">Cost/User</p>
                              <p className="text-sm font-semibold">
                                ${profitability.avg_cost_per_active_user.toFixed(2)}
                              </p>
                            </div>
                            <div className="text-right">
                              <p className="text-muted-foreground text-xs">Profit/User</p>
                              <p
                                className={cn(
                                  'text-sm font-semibold',
                                  profitability.avg_revenue_per_paid_user -
                                    profitability.avg_cost_per_active_user >=
                                    0
                                    ? 'text-emerald-600'
                                    : 'text-red-500',
                                )}
                              >
                                $
                                {(
                                  profitability.avg_revenue_per_paid_user -
                                  profitability.avg_cost_per_active_user
                                ).toFixed(2)}
                              </p>
                            </div>
                          </div>

                          {/* Platform Split */}
                          <div className="grid grid-cols-2 gap-3">
                            <div className="rounded-2xl border p-3">
                              <p className="text-muted-foreground mb-1 text-xs">
                                {tHardcodedUi.raw(
                                  'componentsPagesAdminAnalyticsPage.line717JsxTextWebStripe',
                                )}
                              </p>
                              <p className="text-lg font-bold">
                                ${profitability.web_revenue.toLocaleString()}
                              </p>
                              <p className="text-muted-foreground text-xs">
                                {tHardcodedUi.raw(
                                  'componentsPagesAdminAnalyticsPage.line719JsxTextCost',
                                )}
                                {profitability.web_cost.toFixed(2)}
                              </p>
                            </div>
                            <div className="rounded-2xl border p-3">
                              <p className="text-muted-foreground mb-1 text-xs">
                                {tHardcodedUi.raw(
                                  'componentsPagesAdminAnalyticsPage.line722JsxTextAppRevenuecat',
                                )}
                              </p>
                              <p className="text-lg font-bold">
                                ${profitability.app_revenue.toLocaleString()}
                              </p>
                              <p className="text-muted-foreground text-xs">
                                {tHardcodedUi.raw(
                                  'componentsPagesAdminAnalyticsPage.line724JsxTextCost',
                                )}
                                {profitability.app_cost.toFixed(2)}
                              </p>
                            </div>
                          </div>
                        </div>

                        {/* Users & Revenue per Tier */}
                        <div>
                          <div className="mb-3 flex items-center justify-between">
                            <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                              {tHardcodedUi.raw(
                                'componentsPagesAdminAnalyticsPage.line732JsxTextByTier',
                              )}
                            </p>
                            <div className="bg-muted flex items-center gap-1 rounded-full p-0.5">
                              <button
                                onClick={() => setTierViewMode('revenue')}
                                className={cn(
                                  'rounded-full px-2 py-0.5 text-xs transition-colors',
                                  tierViewMode === 'revenue'
                                    ? 'bg-background shadow-sm'
                                    : 'text-muted-foreground hover:text-foreground',
                                )}
                              >
                                Revenue
                              </button>
                              <button
                                onClick={() => setTierViewMode('cost')}
                                className={cn(
                                  'rounded-full px-2 py-0.5 text-xs transition-colors',
                                  tierViewMode === 'cost'
                                    ? 'bg-background shadow-sm'
                                    : 'text-muted-foreground hover:text-foreground',
                                )}
                              >
                                Usage
                              </button>
                              <button
                                onClick={() => setTierViewMode('profit')}
                                className={cn(
                                  'rounded-full px-2 py-0.5 text-xs transition-colors',
                                  tierViewMode === 'profit'
                                    ? 'bg-background shadow-sm'
                                    : 'text-muted-foreground hover:text-foreground',
                                )}
                              >
                                Profit
                              </button>
                            </div>
                          </div>
                          {profitability.by_tier && profitability.by_tier.length > 0 ? (
                            (() => {
                              const filteredTiers = profitability.by_tier.filter((t) =>
                                tierViewMode === 'revenue'
                                  ? t.total_revenue > 0
                                  : tierViewMode === 'cost'
                                    ? t.total_actual_cost > 0
                                    : t.total_revenue > 0 || t.total_actual_cost > 0,
                              );
                              // Use usage_users for cost view, unique_users for revenue/profit
                              const getUserCount = (t: (typeof filteredTiers)[0]) =>
                                tierViewMode === 'cost'
                                  ? (t.usage_users ?? t.unique_users)
                                  : t.unique_users;
                              const totalUsers = filteredTiers.reduce(
                                (sum, t) => sum + getUserCount(t),
                                0,
                              );
                              const totalValue =
                                tierViewMode === 'revenue'
                                  ? filteredTiers.reduce((sum, t) => sum + t.total_revenue, 0)
                                  : tierViewMode === 'cost'
                                    ? filteredTiers.reduce((sum, t) => sum + t.total_actual_cost, 0)
                                    : filteredTiers.reduce((sum, t) => sum + t.gross_profit, 0);
                              return filteredTiers.length > 0 ? (
                                <div className="space-y-1.5">
                                  {/* Header */}
                                  <div className="text-muted-foreground grid grid-cols-3 gap-2 px-2 pb-1 text-xs">
                                    <div>Tier</div>
                                    <div className="text-right">Users</div>
                                    <div className="text-right">
                                      {tierViewMode === 'revenue'
                                        ? 'Revenue'
                                        : tierViewMode === 'cost'
                                          ? 'Cost'
                                          : 'Profit'}
                                    </div>
                                  </div>
                                  {/* Rows */}
                                  {filteredTiers.map((tier, idx) => {
                                    const userCount = getUserCount(tier);
                                    const userPercent =
                                      totalUsers > 0
                                        ? ((userCount / totalUsers) * 100).toFixed(0)
                                        : '0';
                                    const value =
                                      tierViewMode === 'revenue'
                                        ? tier.total_revenue
                                        : tierViewMode === 'cost'
                                          ? tier.total_actual_cost
                                          : tier.gross_profit;
                                    const valuePercent =
                                      totalValue > 0
                                        ? ((value / totalValue) * 100).toFixed(0)
                                        : '0';
                                    return (
                                      <div
                                        key={idx}
                                        className="hover:bg-muted/50 grid grid-cols-3 gap-2 rounded px-2 py-1.5 text-xs transition-colors"
                                      >
                                        <div className="flex items-center gap-1 truncate font-medium">
                                          {tier.display_name}
                                          <span className="text-muted-foreground text-xs">
                                            ({tier.provider === 'stripe' ? 'Web' : 'App'})
                                          </span>
                                        </div>
                                        <div className="text-right">
                                          {userCount}
                                          <span className="text-muted-foreground ml-1 text-xs">
                                            ({userPercent}%)
                                          </span>
                                        </div>
                                        <div
                                          className={cn(
                                            'text-right',
                                            tierViewMode === 'profit' &&
                                              (value >= 0 ? 'text-green-600' : 'text-red-600'),
                                          )}
                                        >
                                          {tierViewMode === 'profit' && value < 0 ? '-' : ''}$
                                          {Math.abs(value).toLocaleString(undefined, {
                                            minimumFractionDigits: 2,
                                            maximumFractionDigits: 2,
                                          })}
                                          <span className="text-muted-foreground ml-1 text-xs">
                                            ({valuePercent}%)
                                          </span>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : (
                                <p className="text-muted-foreground py-4 text-center text-sm">
                                  No{' '}
                                  {tierViewMode === 'revenue'
                                    ? 'paying'
                                    : tierViewMode === 'cost'
                                      ? 'usage'
                                      : 'profit'}{' '}
                                  data
                                </p>
                              );
                            })()
                          ) : (
                            <p className="text-muted-foreground py-4 text-center text-sm">
                              {tHardcodedUi.raw(
                                'componentsPagesAdminAnalyticsPage.line820JsxTextNoTierData',
                              )}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <p className="text-muted-foreground py-8 text-center text-sm">
                      {tHardcodedUi.raw(
                        'componentsPagesAdminAnalyticsPage.line827JsxTextNoFinancialDataAvailable',
                      )}
                    </p>
                  )}
                </div>
              </section>
            </div>
          </TabsContent>

          {/* Threads Tab */}
          <TabsContent value="threads" className="mt-0 space-y-6">
            {/* Quick Stats */}
            {distribution && (
              <div className="flex items-center gap-8 py-4">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground text-sm">Total:</span>
                  <span className="text-sm font-medium">{distribution.total_threads} threads</span>
                </div>
                <div className="bg-border h-4 w-px" />
                <div className="flex items-center gap-4">
                  <button
                    onClick={() => handleCategoryFilter(null)}
                    className={cn(
                      'rounded-full px-2.5 py-1 text-xs transition-colors',
                      !categoryFilter
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted hover:bg-muted/80',
                    )}
                  >
                    All
                  </button>
                  <span className="text-muted-foreground text-xs">
                    {tHardcodedUi.raw('componentsPagesAdminAnalyticsPage.line856JsxTextText1Msg')}
                    {distribution.distribution['1_message']} · 2-3:{' '}
                    {distribution.distribution['2_3_messages']} · 5+:{' '}
                    {distribution.distribution['5_plus_messages']}
                  </span>
                </div>

                {/* Tier Filter */}
                {tierDistribution && Object.keys(tierDistribution.distribution).length > 0 && (
                  <>
                    <div className="bg-border h-4 w-px" />
                    <Select
                      value={tierFilter || 'all'}
                      onValueChange={(value) => setTierFilter(value === 'all' ? null : value)}
                    >
                      <SelectTrigger className="h-8 w-36 text-xs">
                        <CreditCard className="text-muted-foreground mr-1.5 h-3 w-3" />
                        <SelectValue
                          placeholder={tHardcodedUi.raw(
                            'componentsPagesAdminAnalyticsPage.line872JsxAttrPlaceholderAllTiers',
                          )}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">
                          {tHardcodedUi.raw(
                            'componentsPagesAdminAnalyticsPage.line875JsxTextAllTiers',
                          )}
                        </SelectItem>
                        {Object.entries(tierDistribution.distribution).map(([tier, count]) => {
                          const displayName =
                            tier === 'none'
                              ? 'No Sub'
                              : tier === 'free'
                                ? 'Free'
                                : tier === 'tier_2_20'
                                  ? 'Plus'
                                  : tier === 'tier_6_50'
                                    ? 'Pro'
                                    : tier === 'tier_12_100'
                                      ? 'Business'
                                      : tier === 'tier_25_200'
                                        ? 'Ultra'
                                        : tier;
                          return (
                            <SelectItem key={tier} value={tier}>
                              {displayName} ({count})
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </>
                )}
              </div>
            )}

            {/* Category Pills */}
            {categoryDistribution && Object.keys(categoryDistribution.distribution).length > 0 && (
              <div className="flex flex-wrap gap-2">
                {Object.entries(categoryDistribution.distribution).map(([category, count]) => (
                  <button
                    key={category}
                    onClick={() => setCategoryFilter(categoryFilter === category ? null : category)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors',
                      categoryFilter === category
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background hover:bg-muted border-border',
                    )}
                  >
                    <span className="max-w-[100px] truncate font-medium">{category}</span>
                    <span
                      className={
                        categoryFilter === category
                          ? 'text-primary-foreground/70'
                          : 'text-muted-foreground'
                      }
                    >
                      {count}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* Thread Browser */}
            <ThreadBrowser
              categoryFilter={categoryFilter}
              tierFilter={tierFilter}
              filterDateFrom={dateFromString}
              filterDateTo={dateToString}
              onClearCategory={() => setCategoryFilter(null)}
              onClearTier={() => setTierFilter(null)}
              onUserClick={handleUserEmailClick}
            />
          </TabsContent>

          {/* Users Tab */}
          <TabsContent value="users" className="mt-0">
            <div className="bg-card rounded-2xl border">
              <div className="border-b p-5">
                <h2 className="text-sm font-medium">
                  {tHardcodedUi.raw(
                    'componentsPagesAdminAnalyticsPage.line935JsxTextUserManagement',
                  )}
                </h2>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {tHardcodedUi.raw(
                    'componentsPagesAdminAnalyticsPage.line937JsxTextSearchUsersViewBillingManageCredits',
                  )}
                </p>
              </div>
              <div className="p-5">
                <AdminUserTable onUserSelect={handleUserSelect} />
              </div>
            </div>
          </TabsContent>

          {/* Retention Tab */}
          <TabsContent value="retention" className="mt-0">
            <RetentionTab onUserClick={handleUserEmailClick} />
          </TabsContent>

          {/* ARR Simulator Tab */}
          <TabsContent value="simulator" className="mt-0">
            <ARRSimulator analyticsSource="vercel" />
          </TabsContent>
        </Tabs>

        {/* User Details Dialog */}
        <AdminUserDetailsDialog
          user={selectedUser}
          isOpen={isUserDialogOpen}
          onClose={handleCloseUserDialog}
          onRefresh={handleRefreshUserData}
        />

        {/* Loading indicator */}
        {isSearchingUser && pendingUserEmail && (
          <div className="bg-card fixed right-4 bottom-4 flex items-center gap-2 rounded-2xl border p-3 shadow-lg">
            <KortixLoader size="small" />
            <span className="text-sm">
              {tHardcodedUi.raw('componentsPagesAdminAnalyticsPage.line969JsxTextLoadingUser')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
