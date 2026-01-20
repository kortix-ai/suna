'use client';

import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/lib/toast';
import {
  Users,
  MessageSquare,
  TrendingUp,
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  ArrowRight,
  Activity,
  DollarSign,
  BarChart3,
  UserCheck,
  Zap,
} from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { format, addDays, subDays, startOfWeek, startOfMonth, startOfQuarter, startOfYear } from 'date-fns';
import type { DateRange } from 'react-day-picker';
import { cn } from '@/lib/utils';
import {
  useAnalyticsSummary,
  useMessageDistribution,
  useCategoryDistribution,
  useTierDistribution,
  useConversionFunnel,
  useEngagementSummary,
  useTaskPerformance,
  useProfitability,
} from '@/hooks/admin/use-admin-analytics';
import { AdminUserTable } from '@/components/admin/admin-user-table';
import { AdminUserDetailsDialog } from '@/components/admin/admin-user-details-dialog';
import { useAdminUserList, useRefreshUserData, type UserSummary } from '@/hooks/admin/use-admin-users';

import { UserEmailLink, MetricCard, ThreadBrowser, RetentionTab, ARRSimulator } from './components';

// Get current date in Berlin timezone
function getBerlinToday(): Date {
  const now = new Date();
  const berlinDate = now.toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
  const [year, month, day] = berlinDate.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export default function AdminAnalyticsPage() {
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

  const { data: userSearchResult, isLoading: isSearchingUser, isFetching: isUserFetching } = useAdminUserList({
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
  const { data: distribution, isFetching: distributionFetching } = useMessageDistribution(dateFromString, dateToString, isThreadsTab);
  const { data: categoryDistribution, isFetching: categoryFetching } = useCategoryDistribution(dateFromString, dateToString, tierFilter, isOverviewOrThreads);
  const { data: tierDistribution } = useTierDistribution(dateFromString, dateToString, isThreadsTab);
  const { data: conversionFunnel, isLoading: funnelLoading } = useConversionFunnel(dateFromString, dateToString, 'vercel');
  const { data: engagementSummary, isLoading: engagementLoading, isFetching: engagementFetching } = useEngagementSummary(dateFromString, dateToString);
  const { data: taskPerformance, isLoading: taskLoading, isFetching: taskFetching } = useTaskPerformance(dateFromString, dateToString);
  const { data: profitability, isLoading: profitabilityLoading, isFetching: profitabilityFetching } = useProfitability(dateFromString, dateToString);

  const isOverviewFetching = engagementFetching || taskFetching || profitabilityFetching;

  // Navigation helpers
  const navigateDateRange = (direction: 'prev' | 'next') => {
    if (!dateRange.from) return;
    const toDate = dateRange.to || dateRange.from;
    const daysDiff = Math.round((toDate.getTime() - dateRange.from.getTime()) / (1000 * 60 * 60 * 24));

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

  const isAtToday = (dateRange.to || dateRange.from) &&
    format(dateRange.to || dateRange.from!, 'yyyy-MM-dd') === format(berlinToday, 'yyyy-MM-dd');

  const dateLabel = dateRange.from && dateRange.to && dateRange.from.getTime() === dateRange.to.getTime()
    ? format(dateRange.from, 'MMM d, yyyy')
    : dateRange.from && dateRange.to
      ? `${format(dateRange.from, 'MMM d')} - ${format(dateRange.to, 'MMM d, yyyy')}`
      : dateRange.from
        ? format(dateRange.from, 'MMM d, yyyy')
        : 'Select date';

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Header */}
        <header className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                Platform health and business metrics
              </p>
            </div>

            {/* Date Navigation */}
            <div className="flex items-center gap-2">
              {/* Date Presets */}
              <div className="flex items-center gap-1 mr-2">
                {[
                  { label: 'Today', from: berlinToday, to: berlinToday },
                  { label: '7D', from: subDays(berlinToday, 6), to: berlinToday },
                  { label: '30D', from: subDays(berlinToday, 29), to: berlinToday },
                  { label: 'WTD', from: startOfWeek(berlinToday, { weekStartsOn: 1 }), to: berlinToday },
                  { label: 'MTD', from: startOfMonth(berlinToday), to: berlinToday },
                  { label: 'QTD', from: startOfQuarter(berlinToday), to: berlinToday },
                  { label: 'YTD', from: startOfYear(berlinToday), to: berlinToday },
                ].map((preset) => {
                  const isActive = dateRange.from && dateRange.to &&
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

              <div className="h-6 w-px bg-border" />

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
                  <Button variant="outline" className="h-8 px-3 font-normal text-xs">
                    <CalendarIcon className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                    {dateLabel}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="end">
                  <Calendar
                    mode="range"
                    selected={dateRange}
                    onDayClick={(day) => { clickedDateRef.current = day; }}
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
                  <div className="border-t p-2 flex justify-end">
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
            <div className={cn(
              'space-y-6 transition-opacity duration-200',
              isOverviewFetching && 'opacity-60'
            )}>
              {/* SECTION 1: Tasks & Users Analysis */}
              <section className="rounded-xl border bg-card">
                <div className="p-5 pb-4 border-b">
                  <h2 className="text-sm font-medium flex items-center gap-2">
                    <Zap className="h-4 w-4 text-muted-foreground" />
                    Tasks & Users
                  </h2>
                </div>

                <div className="p-5">
                  {(summaryLoading || engagementLoading || taskLoading || funnelLoading) ? (
                    <div className="space-y-4">
                      <div className="grid grid-cols-5 gap-4">
                        {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-20" />)}
                      </div>
                      <Skeleton className="h-24" />
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {/* Row 1: Core metrics */}
                      <div className="grid grid-cols-7 gap-3">
                        <div className="text-center p-3 rounded-lg bg-muted/30">
                          <p className="text-2xl font-bold">{conversionFunnel?.visitors?.toLocaleString() || 0}</p>
                          <p className="text-xs text-muted-foreground">Visitors</p>
                        </div>
                        <div className="text-center p-3 rounded-lg bg-muted/30">
                          <p className="text-2xl font-bold">{conversionFunnel?.signups?.toLocaleString() || 0}</p>
                          <p className="text-xs text-muted-foreground">New Signups</p>
                        </div>
                        <div className="text-center p-3 rounded-lg bg-emerald-500/10">
                          <p className="text-2xl font-bold text-emerald-600">{conversionFunnel?.subscriptions || 0}</p>
                          <p className="text-xs text-muted-foreground">New Paid</p>
                        </div>
                        <div className="text-center p-3 rounded-lg bg-muted/30">
                          <p className="text-2xl font-bold">{taskPerformance?.total_runs?.toLocaleString() || 0}</p>
                          <p className="text-xs text-muted-foreground">Total Tasks</p>
                        </div>
                        <div className="text-center p-3 rounded-lg bg-muted/30">
                          <p className="text-2xl font-bold">{engagementSummary?.dau || 0}</p>
                          <p className="text-xs text-muted-foreground">Active Users</p>
                        </div>
                        <div className="text-center p-3 rounded-lg bg-muted/30">
                          <p className="text-2xl font-bold">{engagementSummary?.avg_threads_per_active_user?.toFixed(1) || '0'}</p>
                          <p className="text-xs text-muted-foreground">Tasks/User</p>
                        </div>
                        <div className="text-center p-3 rounded-lg bg-muted/30">
                          <p className={cn(
                            "text-2xl font-bold",
                            (taskPerformance?.success_rate || 0) >= 80 ? "text-emerald-600" :
                            (taskPerformance?.success_rate || 0) >= 60 ? "text-amber-600" : "text-red-500"
                          )}>
                            {taskPerformance?.success_rate || 0}%
                          </p>
                          <p className="text-xs text-muted-foreground">Success Rate</p>
                        </div>
                      </div>

                      {/* Row 2: Task Distribution & Duration */}
                      <div className="grid grid-cols-6 gap-3">
                        {/* Task Distribution - expanded */}
                        <div className="col-span-5 p-4 rounded-lg bg-muted/30">
                          <div className="flex items-center justify-between mb-3">
                            <p className="text-xs font-medium text-muted-foreground">Task Distribution by Category</p>
                            {categoryDistribution && (
                              <p className="text-xs text-muted-foreground">
                                {Object.values(categoryDistribution.distribution).reduce((a, b) => a + b, 0)} total
                              </p>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {categoryDistribution && Object.entries(categoryDistribution.distribution)
                              .sort(([, a], [, b]) => b - a)
                              .map(([cat, count]) => {
                                const total = Object.values(categoryDistribution.distribution).reduce((a, b) => a + b, 0);
                                const percent = total > 0 ? ((count / total) * 100).toFixed(0) : 0;
                                return (
                                  <div key={cat} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background border">
                                    <span className="text-sm font-medium">{cat}</span>
                                    <span className="text-xs text-muted-foreground">{count}</span>
                                    <span className="text-[10px] text-muted-foreground/70">({percent}%)</span>
                                  </div>
                                );
                              })}
                            {(!categoryDistribution || Object.keys(categoryDistribution.distribution).length === 0) && (
                              <p className="text-sm text-muted-foreground">No task data</p>
                            )}
                          </div>
                        </div>

                        {/* Avg Duration */}
                        <div className="text-center p-4 rounded-lg bg-muted/30 flex flex-col justify-center relative">
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
                          <p className="text-xs text-muted-foreground mt-1">Avg Task Duration</p>
                          {(taskPerformance?.stuck_task_count ?? 0) > 0 && (
                            <button
                              onClick={() => setIncludeStuckTasks(!includeStuckTasks)}
                              className={cn(
                                "text-[9px] mt-1 px-1.5 py-0.5 rounded cursor-pointer transition-colors",
                                includeStuckTasks
                                  ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                                  : "bg-muted text-muted-foreground hover:bg-muted/80"
                              )}
                              title={includeStuckTasks ? "Click to exclude stuck tasks" : "Click to include stuck tasks"}
                            >
                              {taskPerformance.stuck_task_count} stuck {includeStuckTasks ? '(included)' : '(excluded)'}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </section>

              {/* SECTION 2: DAU/WAU/MAU */}
              <section className="rounded-xl border bg-card">
                <div className="p-5 pb-4 border-b">
                  <h2 className="text-sm font-medium flex items-center gap-2">
                    <Users className="h-4 w-4 text-muted-foreground" />
                    Engagement
                  </h2>
                </div>

                <div className="p-5">
                  {engagementLoading ? (
                    <div className="grid grid-cols-4 gap-4">
                      {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-20" />)}
                    </div>
                  ) : (
                    <div className="grid grid-cols-4 gap-4">
                      <div className="text-center p-4 rounded-lg bg-muted/30">
                        <p className="text-3xl font-bold">{engagementSummary?.dau || 0}</p>
                        <p className="text-xs text-muted-foreground mt-1">DAU</p>
                        <p className="text-[10px] text-muted-foreground">Daily Active Users</p>
                      </div>
                      <div className="text-center p-4 rounded-lg bg-muted/30">
                        <p className="text-3xl font-bold">{engagementSummary?.wau || 0}</p>
                        <p className="text-xs text-muted-foreground mt-1">WAU</p>
                        <p className="text-[10px] text-muted-foreground">Weekly Active Users</p>
                      </div>
                      <div className="text-center p-4 rounded-lg bg-muted/30">
                        <p className="text-3xl font-bold">{engagementSummary?.mau || 0}</p>
                        <p className="text-xs text-muted-foreground mt-1">MAU</p>
                        <p className="text-[10px] text-muted-foreground">Monthly Active Users</p>
                      </div>
                      <div className="text-center p-4 rounded-lg bg-blue-500/10">
                        <p className="text-3xl font-bold text-blue-600">{engagementSummary?.dau_mau_ratio || 0}%</p>
                        <p className="text-xs text-muted-foreground mt-1">DAU/MAU</p>
                        <p className="text-[10px] text-muted-foreground">Stickiness Ratio</p>
                      </div>
                    </div>
                  )}
                </div>
              </section>

              {/* SECTION 3: Conversion Funnel */}
              <section className="rounded-xl border bg-card">
                <div className="flex items-center justify-between p-5 pb-4 border-b">
                  <h2 className="text-sm font-medium flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-muted-foreground" />
                    Conversion Funnel
                  </h2>
                </div>

                <div className="p-5">
                  {funnelLoading ? (
                    <Skeleton className="h-24" />
                  ) : conversionFunnel ? (
                    <div className="flex items-stretch">
                      {/* Visitors */}
                      <div className="flex-1 text-center p-4 rounded-l-lg bg-muted/30 border-r border-background">
                        <p className="text-3xl font-bold tracking-tight">
                          {conversionFunnel.visitors.toLocaleString()}
                        </p>
                        <p className="text-sm font-medium mt-1">Visitors</p>
                        <p className="text-xs text-muted-foreground">100%</p>
                      </div>

                      {/* Arrow */}
                      <div className="flex items-center justify-center px-2 bg-muted/30">
                        <div className="text-center">
                          <ArrowRight className="h-4 w-4 text-muted-foreground mx-auto" />
                          <span className="text-xs font-medium text-muted-foreground">{conversionFunnel.visitor_to_signup_rate}%</span>
                        </div>
                      </div>

                      {/* Signups */}
                      <div className="flex-1 text-center p-4 bg-muted/30 border-r border-background">
                        <p className="text-3xl font-bold tracking-tight">
                          {conversionFunnel.signups.toLocaleString()}
                        </p>
                        <p className="text-sm font-medium mt-1">Signups</p>
                        <p className="text-xs text-muted-foreground">{conversionFunnel.visitor_to_signup_rate}% of visitors</p>
                      </div>

                      {/* Arrow */}
                      <div className="flex items-center justify-center px-2 bg-muted/30">
                        <div className="text-center">
                          <ArrowRight className="h-4 w-4 text-muted-foreground mx-auto" />
                          <span className="text-xs font-medium text-muted-foreground">{conversionFunnel.signup_to_subscription_rate}%</span>
                        </div>
                      </div>

                      {/* Paid - with web/app breakdown */}
                      <div className="flex-1 text-center p-4 rounded-r-lg bg-emerald-500/10">
                        <p className="text-3xl font-bold tracking-tight text-emerald-600">
                          {conversionFunnel.subscriptions.toLocaleString()}
                        </p>
                        <p className="text-sm font-medium mt-1">Paid</p>
                        <p className="text-xs text-muted-foreground">
                          {conversionFunnel.visitors > 0
                            ? ((conversionFunnel.subscriptions / conversionFunnel.visitors) * 100).toFixed(2)
                            : 0}% of visitors
                        </p>
                        {/* Web/App breakdown */}
                        <div className="flex justify-center gap-3 mt-2 text-xs">
                          <Popover>
                            <PopoverTrigger asChild>
                              <button className="text-blue-600 hover:underline cursor-pointer">
                                Web: {conversionFunnel.web_subscriber_emails?.length || 0}
                              </button>
                            </PopoverTrigger>
                            <PopoverContent className="w-72 max-h-60 overflow-y-auto">
                              <h4 className="font-medium text-sm mb-2">Web Subscribers</h4>
                              {conversionFunnel.web_subscriber_emails?.length > 0 ? (
                                <ul className="space-y-1">
                                  {conversionFunnel.web_subscriber_emails.map((email, idx) => (
                                    <li key={idx} className="text-sm">
                                      <UserEmailLink email={email} onUserClick={handleUserEmailClick} />
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="text-sm text-muted-foreground">No web subscribers</p>
                              )}
                            </PopoverContent>
                          </Popover>
                          <span className="text-muted-foreground">|</span>
                          <Popover>
                            <PopoverTrigger asChild>
                              <button className="text-purple-600 hover:underline cursor-pointer">
                                App: {conversionFunnel.app_subscriber_emails?.length || 0}
                              </button>
                            </PopoverTrigger>
                            <PopoverContent className="w-72 max-h-60 overflow-y-auto">
                              <h4 className="font-medium text-sm mb-2">App Subscribers</h4>
                              {conversionFunnel.app_subscriber_emails?.length > 0 ? (
                                <ul className="space-y-1">
                                  {conversionFunnel.app_subscriber_emails.map((email, idx) => (
                                    <li key={idx} className="text-sm">
                                      <UserEmailLink email={email} onUserClick={handleUserEmailClick} />
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="text-sm text-muted-foreground">No app subscribers</p>
                              )}
                            </PopoverContent>
                          </Popover>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      Analytics not configured
                    </p>
                  )}
                </div>
              </section>

              {/* SECTION 4: Financials */}
              <section className="rounded-xl border bg-card">
                <div className="p-5 pb-4 border-b flex items-center justify-between">
                  <h2 className="text-sm font-medium flex items-center gap-2">
                    <DollarSign className="h-4 w-4 text-muted-foreground" />
                    Financials
                  </h2>
                  {profitability && profitability.paying_user_emails?.length > 0 && (
                    <Popover>
                      <PopoverTrigger asChild>
                        <button className="text-xs text-primary hover:underline">
                          View {profitability.unique_paying_users} paying users
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className="w-72 max-h-60 overflow-y-auto">
                        <h4 className="font-medium text-sm mb-2">Paying Users</h4>
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
                        {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-20" />)}
                      </div>
                      <Skeleton className="h-32" />
                    </div>
                  ) : profitability ? (
                    <div className="space-y-6">
                      {/* Row 1: Key financial metrics */}
                      <div className="grid grid-cols-6 gap-4">
                        <div className="text-center p-3 rounded-lg bg-muted/30">
                          <p className="text-xl font-bold">{profitability.total_active_subscriptions?.toLocaleString() ?? '—'}</p>
                          <p className="text-xs text-muted-foreground">Total Active Subs</p>
                          <p className="text-[10px] text-muted-foreground mt-1">
                            Web: {profitability.stripe_active_subscriptions?.toLocaleString() ?? '—'} | App: {profitability.revenuecat_active_subscriptions?.toLocaleString() ?? '—'}
                          </p>
                        </div>
                        <div className="text-center p-3 rounded-lg bg-muted/30">
                          <p className="text-xl font-bold">—</p>
                          <p className="text-xs text-muted-foreground">MRR</p>
                        </div>
                        <div className="text-center p-3 rounded-lg bg-muted/30">
                          <p className="text-xl font-bold">${profitability.avg_revenue_per_paid_user.toFixed(0)}</p>
                          <p className="text-xs text-muted-foreground">ARPU</p>
                        </div>
                        <div className="text-center p-3 rounded-lg bg-muted/30">
                          <p className="text-xl font-bold">—</p>
                          <p className="text-xs text-muted-foreground">Churns</p>
                        </div>
                        <div className="text-center p-3 rounded-lg bg-muted/30">
                          <p className="text-xl font-bold">—</p>
                          <p className="text-xs text-muted-foreground">Churn Rate</p>
                        </div>
                        <div className="text-center p-3 rounded-lg bg-muted/30">
                          <p className="text-xl font-bold">—</p>
                          <p className="text-xs text-muted-foreground">LTV</p>
                        </div>
                      </div>

                      {/* Row 2: Revenue breakdown */}
                      <div className="grid grid-cols-2 gap-6">
                        {/* Revenue & Profit Summary */}
                        <div className="space-y-4">
                          <div className="flex items-center justify-between p-4 rounded-lg bg-emerald-500/10">
                            <div>
                              <p className="text-xs text-muted-foreground">Revenue</p>
                              <p className="text-2xl font-bold text-emerald-600">${profitability.total_revenue.toLocaleString()}</p>
                            </div>
                            <div className="text-right">
                              <p className="text-xs text-muted-foreground">Cost</p>
                              <p className="text-lg font-semibold">${profitability.total_actual_cost.toLocaleString()}</p>
                            </div>
                            <div className="text-right">
                              <p className="text-xs text-muted-foreground">Profit</p>
                              <p className={cn(
                                "text-lg font-bold",
                                profitability.gross_profit >= 0 ? "text-emerald-600" : "text-red-500"
                              )}>
                                {profitability.gross_profit < 0 ? '-' : ''}${Math.abs(profitability.gross_profit).toLocaleString()}
                              </p>
                            </div>
                            <div className="text-right">
                              <p className="text-xs text-muted-foreground">Margin</p>
                              <p className="text-lg font-semibold">{profitability.gross_margin_percent}%</p>
                            </div>
                          </div>

                          {/* Per User Metrics */}
                          <div className="relative flex items-center justify-between p-3 pt-4 rounded-lg border mt-2">
                            <span className="absolute top-1 left-2 text-[9px] text-muted-foreground">Per Paying User ({profitability.unique_paying_users})</span>
                            <div>
                              <p className="text-[10px] text-muted-foreground">Revenue/User</p>
                              <p className="text-sm font-semibold">${profitability.avg_revenue_per_paid_user.toFixed(2)}</p>
                            </div>
                            <div className="text-right">
                              <p className="text-[10px] text-muted-foreground">Cost/User</p>
                              <p className="text-sm font-semibold">${profitability.avg_cost_per_active_user.toFixed(2)}</p>
                            </div>
                            <div className="text-right">
                              <p className="text-[10px] text-muted-foreground">Profit/User</p>
                              <p className={cn(
                                "text-sm font-semibold",
                                (profitability.avg_revenue_per_paid_user - profitability.avg_cost_per_active_user) >= 0 ? "text-emerald-600" : "text-red-500"
                              )}>
                                ${(profitability.avg_revenue_per_paid_user - profitability.avg_cost_per_active_user).toFixed(2)}
                              </p>
                            </div>
                          </div>

                          {/* Platform Split */}
                          <div className="grid grid-cols-2 gap-3">
                            <div className="p-3 rounded-lg border">
                              <p className="text-xs text-muted-foreground mb-1">Web (Stripe)</p>
                              <p className="text-lg font-bold">${profitability.web_revenue.toLocaleString()}</p>
                              <p className="text-xs text-muted-foreground">Cost: ${profitability.web_cost.toFixed(2)}</p>
                            </div>
                            <div className="p-3 rounded-lg border">
                              <p className="text-xs text-muted-foreground mb-1">App (RevenueCat)</p>
                              <p className="text-lg font-bold">${profitability.app_revenue.toLocaleString()}</p>
                              <p className="text-xs text-muted-foreground">Cost: ${profitability.app_cost.toFixed(2)}</p>
                            </div>
                          </div>
                        </div>

                        {/* Users & Revenue per Tier */}
                        <div>
                          <div className="flex items-center justify-between mb-3">
                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">By Tier</p>
                            <div className="flex items-center gap-1 bg-muted rounded-full p-0.5">
                              <button
                                onClick={() => setTierViewMode('revenue')}
                                className={cn(
                                  'text-[10px] px-2 py-0.5 rounded-full transition-colors',
                                  tierViewMode === 'revenue' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
                                )}
                              >
                                Revenue
                              </button>
                              <button
                                onClick={() => setTierViewMode('cost')}
                                className={cn(
                                  'text-[10px] px-2 py-0.5 rounded-full transition-colors',
                                  tierViewMode === 'cost' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
                                )}
                              >
                                Usage
                              </button>
                              <button
                                onClick={() => setTierViewMode('profit')}
                                className={cn(
                                  'text-[10px] px-2 py-0.5 rounded-full transition-colors',
                                  tierViewMode === 'profit' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
                                )}
                              >
                                Profit
                              </button>
                            </div>
                          </div>
                          {profitability.by_tier && profitability.by_tier.length > 0 ? (() => {
                            const filteredTiers = profitability.by_tier.filter(t =>
                              tierViewMode === 'revenue' ? t.total_revenue > 0 :
                              tierViewMode === 'cost' ? t.total_actual_cost > 0 :
                              t.total_revenue > 0 || t.total_actual_cost > 0
                            );
                            // Use usage_users for cost view, unique_users for revenue/profit
                            const getUserCount = (t: typeof filteredTiers[0]) => tierViewMode === 'cost' ? (t.usage_users ?? t.unique_users) : t.unique_users;
                            const totalUsers = filteredTiers.reduce((sum, t) => sum + getUserCount(t), 0);
                            const totalValue = tierViewMode === 'revenue'
                              ? filteredTiers.reduce((sum, t) => sum + t.total_revenue, 0)
                              : tierViewMode === 'cost'
                              ? filteredTiers.reduce((sum, t) => sum + t.total_actual_cost, 0)
                              : filteredTiers.reduce((sum, t) => sum + t.gross_profit, 0);
                            return filteredTiers.length > 0 ? (
                              <div className="space-y-1.5">
                                {/* Header */}
                                <div className="grid grid-cols-3 gap-2 text-[10px] text-muted-foreground px-2 pb-1">
                                  <div>Tier</div>
                                  <div className="text-right">Users</div>
                                  <div className="text-right">{tierViewMode === 'revenue' ? 'Revenue' : tierViewMode === 'cost' ? 'Cost' : 'Profit'}</div>
                                </div>
                                {/* Rows */}
                                {filteredTiers.map((tier, idx) => {
                                  const userCount = getUserCount(tier);
                                  const userPercent = totalUsers > 0 ? ((userCount / totalUsers) * 100).toFixed(0) : '0';
                                  const value = tierViewMode === 'revenue' ? tier.total_revenue : tierViewMode === 'cost' ? tier.total_actual_cost : tier.gross_profit;
                                  const valuePercent = totalValue > 0 ? ((value / totalValue) * 100).toFixed(0) : '0';
                                  return (
                                    <div
                                      key={idx}
                                      className="grid grid-cols-3 gap-2 text-xs py-1.5 px-2 rounded hover:bg-muted/50 transition-colors"
                                    >
                                      <div className="font-medium truncate flex items-center gap-1">
                                        {tier.display_name}
                                        <span className="text-[10px] text-muted-foreground">
                                          ({tier.provider === 'stripe' ? 'Web' : 'App'})
                                        </span>
                                      </div>
                                      <div className="text-right">
                                        {userCount}
                                        <span className="text-[10px] text-muted-foreground ml-1">({userPercent}%)</span>
                                      </div>
                                      <div className={cn("text-right", tierViewMode === 'profit' && (value >= 0 ? 'text-green-600' : 'text-red-600'))}>
                                        {tierViewMode === 'profit' && value < 0 ? '-' : ''}${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                        <span className="text-[10px] text-muted-foreground ml-1">({valuePercent}%)</span>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            ) : (
                              <p className="text-sm text-muted-foreground text-center py-4">
                                No {tierViewMode === 'revenue' ? 'paying' : tierViewMode === 'cost' ? 'usage' : 'profit'} data
                              </p>
                            );
                          })() : (
                            <p className="text-sm text-muted-foreground text-center py-4">No tier data</p>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      No financial data available
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
                  <span className="text-sm text-muted-foreground">Total:</span>
                  <span className="text-sm font-medium">{distribution.total_threads} threads</span>
                </div>
                <div className="h-4 w-px bg-border" />
                <div className="flex items-center gap-4">
                  <button
                    onClick={() => handleCategoryFilter(null)}
                    className={cn(
                      'text-xs px-2.5 py-1 rounded-full transition-colors',
                      !categoryFilter ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-muted/80'
                    )}
                  >
                    All
                  </button>
                  <span className="text-xs text-muted-foreground">
                    1 msg: {distribution.distribution['1_message']} ·
                    2-3: {distribution.distribution['2_3_messages']} ·
                    5+: {distribution.distribution['5_plus_messages']}
                  </span>
                </div>

                {/* Tier Filter */}
                {tierDistribution && Object.keys(tierDistribution.distribution).length > 0 && (
                  <>
                    <div className="h-4 w-px bg-border" />
                    <Select
                      value={tierFilter || 'all'}
                      onValueChange={(value) => setTierFilter(value === 'all' ? null : value)}
                    >
                      <SelectTrigger className="w-36 h-8 text-xs">
                        <CreditCard className="h-3 w-3 mr-1.5 text-muted-foreground" />
                        <SelectValue placeholder="All Tiers" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Tiers</SelectItem>
                        {Object.entries(tierDistribution.distribution).map(([tier, count]) => {
                          const displayName = tier === 'none' ? 'No Sub' :
                            tier === 'free' ? 'Free' :
                            tier === 'tier_2_20' ? 'Plus' :
                            tier === 'tier_6_50' ? 'Pro' :
                            tier === 'tier_12_100' ? 'Business' :
                            tier === 'tier_25_200' ? 'Ultra' : tier;
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
                      'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs transition-colors border',
                      categoryFilter === category
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background hover:bg-muted border-border'
                    )}
                  >
                    <span className="font-medium truncate max-w-[100px]">{category}</span>
                    <span className={categoryFilter === category ? 'text-primary-foreground/70' : 'text-muted-foreground'}>
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
            <div className="rounded-xl border bg-card">
              <div className="p-5 border-b">
                <h2 className="text-sm font-medium">User Management</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Search users, view billing, manage credits
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
          <div className="fixed bottom-4 right-4 bg-card border rounded-lg shadow-lg p-3 flex items-center gap-2">
            <KortixLoader size="small" />
            <span className="text-sm">Loading user...</span>
          </div>
        )}
      </div>
    </div>
  );
}
