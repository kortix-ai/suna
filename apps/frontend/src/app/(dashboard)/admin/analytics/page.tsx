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
import { format, addDays, subDays } from 'date-fns';
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
  type AnalyticsSource,
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
  const [analyticsSource, setAnalyticsSource] = useState<AnalyticsSource>('vercel');
  const [activeTab, setActiveTab] = useState<string>('overview');

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
  const { data: distribution, isFetching: distributionFetching } = useMessageDistribution(dateFromString, dateToString, isThreadsTab);
  const { data: categoryDistribution, isFetching: categoryFetching } = useCategoryDistribution(dateFromString, dateToString, tierFilter, isThreadsTab);
  const { data: tierDistribution } = useTierDistribution(dateFromString, dateToString, isThreadsTab);
  const { data: conversionFunnel, isLoading: funnelLoading } = useConversionFunnel(dateFromString, dateToString, analyticsSource);
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
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                Platform health and business metrics
              </p>
            </div>

            {/* Date Navigation */}
            <div className="flex items-center gap-1">
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
                  <Button variant="outline" className="h-9 px-3 font-normal">
                    <CalendarIcon className="mr-2 h-4 w-4 text-muted-foreground" />
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
              'space-y-8 transition-opacity duration-200',
              isOverviewFetching && 'opacity-60'
            )}>
              {/* Hero Metrics */}
              <section className="grid grid-cols-5 gap-4">
                {(summaryLoading || engagementLoading || profitabilityLoading) ? (
                  [...Array(5)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
                ) : (
                  <>
                    <div className="rounded-xl border bg-card p-5">
                      <MetricCard
                        label="Revenue"
                        value={`$${(profitability?.total_revenue || 0).toLocaleString()}`}
                        subtext={`${profitability?.unique_paying_users || 0} paying users`}
                        size="md"
                        variant="success"
                      />
                    </div>
                    <div className="rounded-xl border bg-card p-5">
                      <MetricCard
                        label="Profit"
                        value={`${(profitability?.gross_profit || 0) < 0 ? '-' : ''}$${Math.abs(profitability?.gross_profit || 0).toLocaleString()}`}
                        subtext={`${profitability?.gross_margin_percent || 0}% margin`}
                        size="md"
                        variant={(profitability?.gross_profit || 0) >= 0 ? 'success' : 'danger'}
                      />
                    </div>
                    <div className="rounded-xl border bg-card p-5">
                      <MetricCard
                        label="Active Users"
                        value={engagementSummary?.dau || 0}
                        subtext={`${engagementSummary?.wau || 0} WAU · ${engagementSummary?.mau || 0} MAU`}
                        size="md"
                      />
                    </div>
                    <div className="rounded-xl border bg-card p-5">
                      <MetricCard
                        label="Signups"
                        value={summary?.new_signups_today || 0}
                        subtext={`${summary?.new_signups_week || 0} this week`}
                        size="md"
                      />
                    </div>
                    <div className="rounded-xl border bg-card p-5">
                      <MetricCard
                        label="Success Rate"
                        value={`${taskPerformance?.success_rate || 0}%`}
                        subtext={`${taskPerformance?.total_runs || 0} runs`}
                        size="md"
                        variant={
                          (taskPerformance?.success_rate || 0) >= 90 ? 'success' :
                          (taskPerformance?.success_rate || 0) >= 70 ? 'default' : 'warning'
                        }
                      />
                    </div>
                  </>
                )}
              </section>

              {/* Conversion Funnel */}
              <section className="rounded-xl border bg-card">
                <div className="flex items-center justify-between p-5 pb-4 border-b">
                  <div>
                    <h2 className="text-sm font-medium">Conversion Funnel</h2>
                    <p className="text-xs text-muted-foreground mt-0.5">{dateLabel}</p>
                  </div>
                  <Select value={analyticsSource} onValueChange={(v) => setAnalyticsSource(v as AnalyticsSource)}>
                    <SelectTrigger className="w-32 h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="vercel">Vercel</SelectItem>
                      <SelectItem value="ga">Google Analytics</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="p-5">
                  {funnelLoading ? (
                    <Skeleton className="h-20" />
                  ) : conversionFunnel ? (
                    <div className="flex items-center justify-between">
                      {/* Visitors */}
                      <div className="flex-1">
                        <p className="text-3xl font-bold tracking-tight">
                          {conversionFunnel.visitors.toLocaleString()}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">Visitors</p>
                      </div>

                      <div className="flex items-center gap-2 text-muted-foreground/50 px-4">
                        <ArrowRight className="h-4 w-4" />
                        <span className="text-xs font-medium">{conversionFunnel.visitor_to_signup_rate}%</span>
                      </div>

                      {/* Signups */}
                      <div className="flex-1 text-center">
                        <p className="text-3xl font-bold tracking-tight">
                          {conversionFunnel.signups.toLocaleString()}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">Signups</p>
                      </div>

                      <div className="flex items-center gap-2 text-muted-foreground/50 px-4">
                        <ArrowRight className="h-4 w-4" />
                        <span className="text-xs font-medium">{conversionFunnel.signup_to_subscription_rate}%</span>
                      </div>

                      {/* Subscriptions */}
                      <Popover>
                        <PopoverTrigger asChild>
                          <div className="flex-1 text-right cursor-pointer hover:opacity-80 transition-opacity">
                            <p className="text-3xl font-bold tracking-tight text-emerald-600">
                              {conversionFunnel.subscriptions.toLocaleString()}
                            </p>
                            <p className="text-xs text-muted-foreground mt-1">Paid Subscribers</p>
                          </div>
                        </PopoverTrigger>
                        <PopoverContent className="w-72 max-h-60 overflow-y-auto">
                          <h4 className="font-medium text-sm mb-2">New Subscribers</h4>
                          {conversionFunnel.subscriber_emails?.length > 0 ? (
                            <ul className="space-y-1">
                              {conversionFunnel.subscriber_emails.map((email, idx) => (
                                <li key={idx} className="text-sm">
                                  <UserEmailLink email={email} onUserClick={handleUserEmailClick} />
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="text-sm text-muted-foreground">No new subscribers</p>
                          )}
                        </PopoverContent>
                      </Popover>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      Analytics not configured
                    </p>
                  )}
                </div>
              </section>

              {/* Two Column Layout: Engagement + Profitability */}
              <div className="grid grid-cols-2 gap-6 items-start">
                {/* Platform Health */}
                <section className="rounded-xl border bg-card">
                  <div className="p-5 pb-4 border-b">
                    <h2 className="text-sm font-medium flex items-center gap-2">
                      <Activity className="h-4 w-4 text-muted-foreground" />
                      Platform Health
                    </h2>
                  </div>

                  <div className="p-5 space-y-5">
                    {engagementLoading || taskLoading ? (
                      <div className="space-y-3">
                        <Skeleton className="h-16" />
                        <Skeleton className="h-16" />
                      </div>
                    ) : (
                      <>
                        {/* Engagement Metrics */}
                        <div className="grid grid-cols-3 gap-4">
                          <div>
                            <p className="text-2xl font-bold">{engagementSummary?.dau_mau_ratio || 0}%</p>
                            <p className="text-xs text-muted-foreground">Stickiness (DAU/MAU)</p>
                          </div>
                          <div>
                            <p className="text-2xl font-bold">{engagementSummary?.avg_threads_per_active_user?.toFixed(1) || '0'}</p>
                            <p className="text-xs text-muted-foreground">Threads/User</p>
                          </div>
                          <div>
                            <p className="text-2xl font-bold">{taskPerformance?.total_runs?.toLocaleString() || 0}</p>
                            <p className="text-xs text-muted-foreground">Agent Runs</p>
                          </div>
                        </div>

                        <div className="h-px bg-border" />

                        {/* Task Performance */}
                        <div>
                          <div className="flex items-center justify-between mb-3">
                            <span className="text-xs font-medium text-muted-foreground">Task Status</span>
                            {taskPerformance?.avg_duration_seconds !== null && (
                              <span className="text-xs text-muted-foreground">
                                Avg: {taskPerformance.avg_duration_seconds < 60
                                  ? `${taskPerformance.avg_duration_seconds.toFixed(0)}s`
                                  : `${(taskPerformance.avg_duration_seconds / 60).toFixed(1)}m`}
                              </span>
                            )}
                          </div>
                          <div className="flex gap-2">
                            <div className="flex-1 rounded-lg bg-emerald-500/10 p-2.5 text-center">
                              <p className="text-lg font-semibold text-emerald-600">{taskPerformance?.completed_runs || 0}</p>
                              <p className="text-[10px] text-muted-foreground">Completed</p>
                            </div>
                            <div className="flex-1 rounded-lg bg-red-500/10 p-2.5 text-center">
                              <p className="text-lg font-semibold text-red-500">{taskPerformance?.failed_runs || 0}</p>
                              <p className="text-[10px] text-muted-foreground">Failed</p>
                            </div>
                            <div className="flex-1 rounded-lg bg-amber-500/10 p-2.5 text-center">
                              <p className="text-lg font-semibold text-amber-600">{taskPerformance?.stopped_runs || 0}</p>
                              <p className="text-[10px] text-muted-foreground">Stopped</p>
                            </div>
                            <div className="flex-1 rounded-lg bg-blue-500/10 p-2.5 text-center">
                              <p className="text-lg font-semibold text-blue-600">{taskPerformance?.running_runs || 0}</p>
                              <p className="text-[10px] text-muted-foreground">Running</p>
                            </div>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </section>

                {/* Profitability */}
                <section className="rounded-xl border bg-card">
                  <div className="p-5 pb-4 border-b flex items-center justify-between">
                    <h2 className="text-sm font-medium flex items-center gap-2">
                      <DollarSign className="h-4 w-4 text-muted-foreground" />
                      Profitability
                    </h2>
                    {profitability && (
                      <Popover>
                        <PopoverTrigger asChild>
                          <button className="text-xs text-primary hover:underline">
                            {profitability.unique_paying_users} paying users
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-72 max-h-60 overflow-y-auto">
                          <h4 className="font-medium text-sm mb-2">Paying Users</h4>
                          {profitability.paying_user_emails?.length > 0 ? (
                            <ul className="space-y-1">
                              {profitability.paying_user_emails.map((email, idx) => (
                                <li key={idx} className="text-sm">
                                  <UserEmailLink email={email} onUserClick={handleUserEmailClick} />
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="text-sm text-muted-foreground">No paying users</p>
                          )}
                        </PopoverContent>
                      </Popover>
                    )}
                  </div>

                  <div className="p-5">
                    {profitabilityLoading ? (
                      <div className="space-y-3">
                        <Skeleton className="h-20" />
                        <Skeleton className="h-16" />
                      </div>
                    ) : profitability ? (
                      <div className="space-y-5">
                        {/* Hero Profit */}
                        <div className="text-center py-2">
                          <p className={cn(
                            "text-4xl font-bold tracking-tight",
                            profitability.gross_profit >= 0 ? "text-emerald-600" : "text-red-500"
                          )}>
                            {profitability.gross_profit < 0 ? '-' : ''}${Math.abs(profitability.gross_profit).toLocaleString()}
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            Net Profit · {profitability.gross_margin_percent}% margin
                          </p>
                        </div>

                        {/* Revenue vs Cost */}
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-muted-foreground">Revenue</span>
                              <span className="font-semibold">${profitability.total_revenue.toLocaleString()}</span>
                            </div>
                            <div className="h-2 bg-muted rounded-full overflow-hidden">
                              <div className="h-full bg-emerald-500 rounded-full" style={{ width: '100%' }} />
                            </div>
                          </div>
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-muted-foreground">Cost</span>
                              <span className="font-semibold">${profitability.total_actual_cost.toLocaleString()}</span>
                            </div>
                            <div className="h-2 bg-muted rounded-full overflow-hidden">
                              <div
                                className="h-full bg-red-400 rounded-full"
                                style={{ width: `${Math.min(100, (profitability.total_actual_cost / profitability.total_revenue) * 100)}%` }}
                              />
                            </div>
                          </div>
                        </div>

                        {/* Per User Metrics - Industry Standard */}
                        {(profitability.unique_paying_users > 0 || profitability.unique_active_users > 0) && (
                          <div className="rounded-lg bg-muted/40 p-3">
                            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">Unit Economics</p>
                            <div className="grid grid-cols-2 gap-4 text-center">
                              <div>
                                <p className="text-lg font-bold">${profitability.avg_revenue_per_paid_user.toFixed(0)}</p>
                                <p className="text-[10px] text-muted-foreground">Revenue/Paying User</p>
                                <p className="text-[10px] text-muted-foreground">({profitability.unique_paying_users} paying)</p>
                              </div>
                              <div>
                                <p className="text-lg font-bold">${profitability.avg_cost_per_active_user.toFixed(2)}</p>
                                <p className="text-[10px] text-muted-foreground">Cost/Active User</p>
                                <p className="text-[10px] text-muted-foreground">({profitability.unique_active_users} active)</p>
                              </div>
                            </div>
                          </div>
                        )}

                        {/* By Tier */}
                        {profitability.by_tier && profitability.by_tier.length > 0 && (
                          <div>
                            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">By Plan</p>
                            <div className="space-y-1">
                              {/* Header */}
                              <div className="grid grid-cols-5 gap-2 text-[10px] text-muted-foreground px-2 pb-1">
                                <div>Plan</div>
                                <div className="text-right">Revenue</div>
                                <div className="text-right">Cost</div>
                                <div className="text-right">Profit</div>
                                <div className="text-right">Margin</div>
                              </div>
                              {/* Rows */}
                              {profitability.by_tier.map((tier, idx) => (
                                <div
                                  key={idx}
                                  className="grid grid-cols-5 gap-2 text-xs py-1.5 px-2 rounded hover:bg-muted/50 transition-colors"
                                >
                                  <div className="font-medium truncate" title={tier.display_name}>
                                    {tier.display_name}
                                    <span className="text-muted-foreground text-[10px] ml-1">
                                      {tier.provider === 'stripe' ? 'Web' : 'App'}
                                    </span>
                                  </div>
                                  <div className="text-right">${tier.total_revenue.toLocaleString()}</div>
                                  <div className="text-right text-muted-foreground">${tier.total_actual_cost.toLocaleString()}</div>
                                  <div className={cn(
                                    "text-right font-medium",
                                    tier.gross_profit >= 0 ? "text-emerald-600" : "text-red-500"
                                  )}>
                                    {tier.gross_profit < 0 ? '-' : ''}${Math.abs(tier.gross_profit).toLocaleString()}
                                  </div>
                                  <div className="text-right text-muted-foreground">{tier.gross_margin_percent}%</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Platform Split */}
                        <div className="flex items-center justify-between text-xs text-muted-foreground pt-2 border-t">
                          <div className="flex items-center gap-4">
                            <span>Web: ${profitability.web_revenue.toLocaleString()}</span>
                            <span>App: ${profitability.app_revenue.toLocaleString()}</span>
                          </div>
                          <div className="flex items-center gap-4">
                            <span className="text-muted-foreground/60">Cost: ${profitability.web_cost.toFixed(2)} / ${profitability.app_cost.toFixed(2)}</span>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground text-center py-8">
                        No profitability data
                      </p>
                    )}
                  </div>
                </section>
              </div>
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
            <ARRSimulator analyticsSource={analyticsSource} />
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
