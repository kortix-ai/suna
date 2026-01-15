'use client';

import { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/lib/toast';
import {
  Users,
  MessageSquare,
  TrendingUp,
  Activity,
  Calendar as CalendarIcon,
  Eye,
  Filter,
  BarChart3,
  UserCheck,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Zap,
  CheckCircle2,
} from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { format, addDays, subDays } from 'date-fns';
import type { DateRange } from 'react-day-picker';
import {
  useAnalyticsSummary,
  useMessageDistribution,
  useCategoryDistribution,
  useTierDistribution,
  useConversionFunnel,
  useEngagementSummary,
  useTaskPerformance,
  type AnalyticsSource,
} from '@/hooks/admin/use-admin-analytics';
import { AdminUserTable } from '@/components/admin/admin-user-table';
import { AdminUserDetailsDialog } from '@/components/admin/admin-user-details-dialog';
import { useAdminUserList, useRefreshUserData, type UserSummary } from '@/hooks/admin/use-admin-users';

// Import extracted components
import { UserEmailLink, StatCard, ThreadBrowser, RetentionTab, ARRSimulator } from './components';

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

  // Helper to set category filter and auto-switch to threads tab
  const handleCategoryFilter = (category: string | null) => {
    setCategoryFilter(category);
    if (category) {
      setActiveTab('threads');
    }
  };

  // Helper to set tier filter and auto-switch to threads tab
  const handleTierFilter = (tier: string | null) => {
    setTierFilter(tier);
    if (tier && tier !== 'all') {
      setActiveTab('threads');
    }
  };

  // User details dialog state
  const [selectedUser, setSelectedUser] = useState<UserSummary | null>(null);
  const [isUserDialogOpen, setIsUserDialogOpen] = useState(false);
  const [pendingUserEmail, setPendingUserEmail] = useState<string | null>(null);

  // Fetch user by email when clicked
  const { data: userSearchResult, isLoading: isSearchingUser, isFetching: isUserFetching } = useAdminUserList({
    page: 1,
    page_size: 1,
    search_email: pendingUserEmail || undefined,
  });

  const { refreshUserList, refreshUserStats } = useRefreshUserData();

  // When user search completes, open the dialog
  useEffect(() => {
    if (!pendingUserEmail || isSearchingUser || isUserFetching) {
      return;
    }

    if (userSearchResult?.data && userSearchResult.data.length > 0) {
      setSelectedUser(userSearchResult.data[0]);
      setIsUserDialogOpen(true);
      setPendingUserEmail(null);
    } else if (userSearchResult?.data && userSearchResult.data.length === 0) {
      toast.error(`User not found: ${pendingUserEmail}`);
      setPendingUserEmail(null);
    }
  }, [pendingUserEmail, userSearchResult, isSearchingUser, isUserFetching]);

  // Handle user email click from anywhere in the app
  const handleUserEmailClick = (email: string) => {
    setPendingUserEmail(email);
  };

  // Handle user selection from the Users tab table
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

  // Only fetch threads-related data when on threads tab
  const isThreadsTab = activeTab === 'threads';
  const { data: distribution, isFetching: distributionFetching } = useMessageDistribution(dateFromString, dateToString, isThreadsTab);
  const { data: categoryDistribution, isFetching: categoryFetching } = useCategoryDistribution(dateFromString, dateToString, tierFilter, isThreadsTab);
  const { data: tierDistribution, isFetching: tierFetching } = useTierDistribution(dateFromString, dateToString, isThreadsTab);

  // Overview tab data
  const { data: conversionFunnel, isLoading: funnelLoading, isFetching: funnelFetching } = useConversionFunnel(dateFromString, dateToString, analyticsSource);

  // Executive Overview data hooks
  const { data: engagementSummary, isLoading: engagementLoading, isFetching: engagementFetching } = useEngagementSummary(dateFromString, dateToString);
  const { data: taskPerformance, isLoading: taskLoading, isFetching: taskFetching } = useTaskPerformance(dateFromString, dateToString);

  // Combined fetching state for the Daily Analytics card
  const isDailyAnalyticsFetching = distributionFetching || categoryFetching || tierFetching || funnelFetching;
  const isOverviewFetching = engagementFetching || taskFetching;

  return (
    <div className="min-h-screen bg-gradient-to-br from-background to-muted/20">
      <div className="max-w-7xl mx-auto p-6 space-y-8">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Analytics Dashboard
            </h1>
            <p className="text-muted-foreground mt-1">
              Understand retention, conversion, and user behavior
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Visitor Source</span>
            <Select value={analyticsSource} onValueChange={(v) => setAnalyticsSource(v as AnalyticsSource)}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Source" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="vercel">Vercel</SelectItem>
                <SelectItem value="ga">Google Analytics</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Tabs - at top for easy navigation */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList>
            <TabsTrigger value="overview" className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              Overview
            </TabsTrigger>
            <TabsTrigger value="threads" className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4" />
              All Threads
            </TabsTrigger>
            <TabsTrigger value="users" className="flex items-center gap-2">
              <CreditCard className="h-4 w-4" />
              Users & Billing
            </TabsTrigger>
            <TabsTrigger value="retention" className="flex items-center gap-2">
              <UserCheck className="h-4 w-4" />
              Retention
            </TabsTrigger>
            <TabsTrigger value="simulator" className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              ARR Simulator
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-6">
            {/* Executive Summary - Top KPIs Row */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {(summaryLoading || engagementLoading) ? (
                [...Array(4)].map((_, i) => (
                  <Skeleton key={i} className="h-28" />
                ))
              ) : (
                <>
                  <StatCard
                    title="Active Users Today"
                    value={engagementSummary?.dau?.toLocaleString() || '0'}
                    description={`${engagementSummary?.wau || 0} WAU · ${engagementSummary?.mau || 0} MAU`}
                    icon={<Users className="h-4 w-4 text-primary" />}
                  />
                  <StatCard
                    title="New Signups"
                    value={summary?.new_signups_today || 0}
                    description={`${summary?.new_signups_week || 0} this week`}
                    icon={<TrendingUp className="h-4 w-4 text-primary" />}
                  />
                  <StatCard
                    title="Threads Today"
                    value={engagementSummary?.total_threads_today?.toLocaleString() || '0'}
                    description={`${engagementSummary?.total_threads_week || 0} this week`}
                    icon={<Activity className="h-4 w-4 text-primary" />}
                  />
                  <StatCard
                    title="Success Rate"
                    value={`${taskPerformance?.success_rate || 0}%`}
                    description={`${taskPerformance?.total_runs || 0} runs today`}
                    icon={<CheckCircle2 className="h-4 w-4 text-primary" />}
                  />
                </>
              )}
            </div>

            {/* Date Range Picker for Overview */}
            <div className="flex items-center justify-end gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => {
                  if (dateRange.from) {
                    const toDate = dateRange.to || dateRange.from;
                    const daysDiff = Math.round((toDate.getTime() - dateRange.from.getTime()) / (1000 * 60 * 60 * 24));
                    setDateRange({
                      from: subDays(dateRange.from, daysDiff + 1),
                      to: subDays(toDate, daysDiff + 1),
                    });
                  }
                }}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="min-w-[200px] justify-start text-left font-normal h-9">
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {dateRange.from && dateRange.to && dateRange.from.getTime() === dateRange.to.getTime()
                      ? format(dateRange.from, 'MMM d, yyyy')
                      : dateRange.from && dateRange.to
                        ? `${format(dateRange.from, 'MMM d')} - ${format(dateRange.to, 'MMM d, yyyy')}`
                        : dateRange.from
                          ? format(dateRange.from, 'MMM d, yyyy')
                          : 'Select date range'}
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
                      // If we had a complete range, start fresh with clicked date
                      if (dateRange.from && dateRange.to && clickedDateRef.current) {
                        setDateRange({ from: clickedDateRef.current, to: undefined });
                        clickedDateRef.current = null;
                        return;
                      }

                      if (newRange?.from) {
                        setDateRange(newRange);
                      }
                      clickedDateRef.current = null;
                    }}
                    disabled={(date) => date > berlinToday}
                    numberOfMonths={1}
                    initialFocus
                  />
                  <div className="border-t p-2 flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">
                      {dateRange.from && dateRange.to
                        ? dateRange.from.getTime() === dateRange.to.getTime()
                          ? format(dateRange.from, 'MMM d, yyyy')
                          : `${format(dateRange.from, 'MMM d')} - ${format(dateRange.to, 'MMM d, yyyy')}`
                        : dateRange.from
                          ? `${format(dateRange.from, 'MMM d, yyyy')} - ...`
                          : 'Select dates'}
                    </span>
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
                disabled={(dateRange.to || dateRange.from) && format(dateRange.to || dateRange.from!, 'yyyy-MM-dd') === format(berlinToday, 'yyyy-MM-dd')}
                onClick={() => {
                  if (dateRange.from) {
                    const toDate = dateRange.to || dateRange.from;
                    const daysDiff = Math.round((toDate.getTime() - dateRange.from.getTime()) / (1000 * 60 * 60 * 24));
                    const newTo = addDays(toDate, daysDiff + 1);
                    const cappedTo = newTo > berlinToday ? berlinToday : newTo;
                    const newFrom = addDays(dateRange.from, daysDiff + 1);
                    const cappedFrom = newFrom > berlinToday ? berlinToday : newFrom;
                    setDateRange({ from: cappedFrom, to: cappedTo });
                  }
                }}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>

            {/* Single Column Layout */}
            <div className={`space-y-6 transition-opacity duration-200 ${isOverviewFetching ? 'opacity-60' : 'opacity-100'}`}>
              {/* Conversion Funnel Card */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <TrendingUp className="h-4 w-4" />
                    Conversion Funnel
                  </CardTitle>
                  <CardDescription>
                    Visitors → Signups → Subscriptions for {
                      dateRange.from && dateRange.to && dateRange.from.getTime() === dateRange.to.getTime()
                        ? format(dateRange.from, 'MMM d')
                        : dateRange.from && dateRange.to
                          ? `${format(dateRange.from, 'MMM d')} - ${format(dateRange.to, 'MMM d')}`
                          : ''
                    }
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {funnelLoading ? (
                    <div className="grid grid-cols-3 gap-3">
                      {[...Array(3)].map((_, i) => (
                        <Skeleton key={i} className="h-16" />
                      ))}
                    </div>
                  ) : conversionFunnel ? (
                    <div className="space-y-3">
                      <div className="grid grid-cols-3 gap-3">
                        <div className="text-center p-2.5 rounded-lg bg-muted/50">
                          <div className="text-xl font-bold">{conversionFunnel.visitors.toLocaleString()}</div>
                          <p className="text-xs text-muted-foreground">Visitors</p>
                        </div>
                        <div className="text-center p-2.5 rounded-lg bg-muted/50">
                          <div className="text-xl font-bold">{conversionFunnel.signups.toLocaleString()}</div>
                          <p className="text-xs text-muted-foreground">Signups ({conversionFunnel.visitor_to_signup_rate}%)</p>
                        </div>
                        <Popover>
                          <PopoverTrigger asChild>
                            <div className="text-center p-2.5 rounded-lg bg-muted/50 cursor-pointer hover:bg-muted/70 transition-colors">
                              <div className="text-xl font-bold">{conversionFunnel.subscriptions.toLocaleString()}</div>
                              <p className="text-xs text-muted-foreground">Subs ({conversionFunnel.signup_to_subscription_rate}%)</p>
                            </div>
                          </PopoverTrigger>
                          <PopoverContent className="w-80 max-h-64 overflow-y-auto">
                            <div className="space-y-2">
                              <h4 className="font-medium text-sm">Subscriber Emails</h4>
                              {conversionFunnel.subscriber_emails && conversionFunnel.subscriber_emails.length > 0 ? (
                                <ul className="space-y-1">
                                  {conversionFunnel.subscriber_emails.map((email, idx) => (
                                    <li key={idx} className="text-sm flex items-center gap-2">
                                      <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded">{idx + 1}</span>
                                      <UserEmailLink email={email} onUserClick={handleUserEmailClick} />
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="text-sm text-muted-foreground">No subscriber emails for this period</p>
                              )}
                            </div>
                          </PopoverContent>
                        </Popover>
                      </div>
                      <p className="text-xs text-muted-foreground text-center">
                        Overall: <span className="font-medium text-foreground">{conversionFunnel.overall_conversion_rate}%</span> conversion
                      </p>
                    </div>
                  ) : (
                    <div className="text-center py-4 text-muted-foreground text-sm">
                      <Eye className="h-5 w-5 mx-auto mb-1 opacity-50" />
                      Analytics not configured
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* User Engagement Card */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Activity className="h-4 w-4" />
                    User Engagement
                  </CardTitle>
                  <CardDescription>
                    Daily, weekly, and monthly active users
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {engagementLoading ? (
                    <div className="space-y-3">
                      <Skeleton className="h-16" />
                      <Skeleton className="h-16" />
                    </div>
                  ) : engagementSummary ? (
                    <div className="space-y-4">
                      {/* DAU / WAU / MAU */}
                      <div className="grid grid-cols-3 gap-3">
                        <div className="text-center p-2.5 rounded-lg bg-muted/50">
                          <div className="text-xl font-bold">{engagementSummary.dau.toLocaleString()}</div>
                          <p className="text-xs text-muted-foreground">DAU</p>
                        </div>
                        <div className="text-center p-2.5 rounded-lg bg-muted/50">
                          <div className="text-xl font-bold">{engagementSummary.wau.toLocaleString()}</div>
                          <p className="text-xs text-muted-foreground">WAU</p>
                        </div>
                        <div className="text-center p-2.5 rounded-lg bg-muted/50">
                          <div className="text-xl font-bold">{engagementSummary.mau.toLocaleString()}</div>
                          <p className="text-xs text-muted-foreground">MAU</p>
                        </div>
                      </div>

                      {/* Stickiness & Threads */}
                      <div className="grid grid-cols-2 gap-3">
                        <div className="p-3 rounded-lg bg-muted/50">
                          <div className="text-lg font-bold">{engagementSummary.dau_mau_ratio}%</div>
                          <p className="text-xs text-muted-foreground">DAU/MAU Ratio (Stickiness)</p>
                        </div>
                        <div className="p-3 rounded-lg bg-muted/50">
                          <div className="text-lg font-bold">{engagementSummary.avg_threads_per_active_user.toFixed(1)}</div>
                          <p className="text-xs text-muted-foreground">Avg Threads/User</p>
                        </div>
                      </div>

                      {/* Thread counts */}
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Threads today:</span>
                        <span className="font-medium">{engagementSummary.total_threads_today.toLocaleString()}</span>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Threads this week:</span>
                        <span className="font-medium">{engagementSummary.total_threads_week.toLocaleString()}</span>
                      </div>
                    </div>
                  ) : (
                    <div className="text-center py-4 text-muted-foreground text-sm">
                      <Activity className="h-5 w-5 mx-auto mb-1 opacity-50" />
                      Engagement data unavailable
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Task Performance Card */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Zap className="h-4 w-4" />
                    Task Performance
                  </CardTitle>
                  <CardDescription>
                    Agent run statistics for {
                      dateRange.from && dateRange.to && dateRange.from.getTime() === dateRange.to.getTime()
                        ? format(dateRange.from, 'MMM d')
                        : dateRange.from && dateRange.to
                          ? `${format(dateRange.from, 'MMM d')} - ${format(dateRange.to, 'MMM d')}`
                          : ''
                    }
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {taskLoading ? (
                    <div className="space-y-3">
                      <Skeleton className="h-16" />
                      <Skeleton className="h-16" />
                    </div>
                  ) : taskPerformance ? (
                    <div className="space-y-4">
                      {/* Success Rate & Total */}
                      <div className="grid grid-cols-2 gap-3">
                        <div className="p-3 rounded-lg bg-muted/50">
                          <div className="text-2xl font-bold">
                            {taskPerformance.success_rate}%
                          </div>
                          <p className="text-xs text-muted-foreground">Success Rate</p>
                        </div>
                        <div className="p-3 rounded-lg bg-muted/50">
                          <div className="text-2xl font-bold">{taskPerformance.total_runs.toLocaleString()}</div>
                          <p className="text-xs text-muted-foreground">Total Runs</p>
                        </div>
                      </div>

                      {/* Status Breakdown */}
                      <div className="grid grid-cols-4 gap-2 text-center">
                        <div className="p-2.5 rounded-lg bg-muted/50">
                          <div className="text-lg font-bold">{taskPerformance.completed_runs}</div>
                          <p className="text-xs text-muted-foreground">Completed</p>
                        </div>
                        <div className="p-2.5 rounded-lg bg-muted/50">
                          <div className="text-lg font-bold">{taskPerformance.failed_runs}</div>
                          <p className="text-xs text-muted-foreground">Failed</p>
                        </div>
                        <div className="p-2.5 rounded-lg bg-muted/50">
                          <div className="text-lg font-bold">{taskPerformance.stopped_runs}</div>
                          <p className="text-xs text-muted-foreground">Stopped</p>
                        </div>
                        <div className="p-2.5 rounded-lg bg-muted/50">
                          <div className="text-lg font-bold">{taskPerformance.running_runs}</div>
                          <p className="text-xs text-muted-foreground">Running</p>
                        </div>
                      </div>

                      {/* Avg Duration */}
                      {taskPerformance.avg_duration_seconds !== null && (
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">Avg Duration:</span>
                          <span className="font-medium">
                            {taskPerformance.avg_duration_seconds < 60
                              ? `${taskPerformance.avg_duration_seconds.toFixed(0)}s`
                              : `${(taskPerformance.avg_duration_seconds / 60).toFixed(1)}m`}
                          </span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-center py-4 text-muted-foreground text-sm">
                      <Zap className="h-5 w-5 mx-auto mb-1 opacity-50" />
                      Task data unavailable
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="threads" className="space-y-4">
            {/* Thread & Category Distribution - above the browser */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <BarChart3 className="h-4 w-4" />
                    Thread Analytics
                  </CardTitle>
                  <CardDescription>
                    Distribution by messages and categories for {
                      dateRange.from && dateRange.to && dateRange.from.getTime() === dateRange.to.getTime()
                        ? format(dateRange.from, 'MMM d, yyyy')
                        : dateRange.from && dateRange.to
                          ? `${format(dateRange.from, 'MMM d')} - ${format(dateRange.to, 'MMM d, yyyy')}`
                          : ''
                    }
                  </CardDescription>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => {
                      if (dateRange.from) {
                        const toDate = dateRange.to || dateRange.from;
                        const daysDiff = Math.round((toDate.getTime() - dateRange.from.getTime()) / (1000 * 60 * 60 * 24));
                        setDateRange({
                          from: subDays(dateRange.from, daysDiff + 1),
                          to: subDays(toDate, daysDiff + 1),
                        });
                      }
                    }}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" className="min-w-[200px] justify-start text-left font-normal h-9">
                        <CalendarIcon className="mr-2 h-4 w-4" />
                        {dateRange.from && dateRange.to && dateRange.from.getTime() === dateRange.to.getTime()
                          ? format(dateRange.from, 'MMM d, yyyy')
                          : dateRange.from && dateRange.to
                            ? `${format(dateRange.from, 'MMM d')} - ${format(dateRange.to, 'MMM d, yyyy')}`
                            : dateRange.from
                              ? format(dateRange.from, 'MMM d, yyyy')
                              : 'Select date range'}
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
                          // If we had a complete range, start fresh with clicked date
                          if (dateRange.from && dateRange.to && clickedDateRef.current) {
                            setDateRange({ from: clickedDateRef.current, to: undefined });
                            clickedDateRef.current = null;
                            return;
                          }

                          if (newRange?.from) {
                            setDateRange(newRange);
                          }
                          clickedDateRef.current = null;
                        }}
                        disabled={(date) => date > berlinToday}
                        numberOfMonths={1}
                        initialFocus
                      />
                      <div className="border-t p-2 flex justify-between items-center">
                        <span className="text-sm text-muted-foreground">
                          {dateRange.from && dateRange.to
                            ? dateRange.from.getTime() === dateRange.to.getTime()
                              ? format(dateRange.from, 'MMM d, yyyy')
                              : `${format(dateRange.from, 'MMM d')} - ${format(dateRange.to, 'MMM d, yyyy')}`
                            : dateRange.from
                              ? `${format(dateRange.from, 'MMM d, yyyy')} - ...`
                              : 'Select dates'}
                        </span>
                      </div>
                    </PopoverContent>
                  </Popover>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    disabled={(dateRange.to || dateRange.from) && format(dateRange.to || dateRange.from!, 'yyyy-MM-dd') === format(berlinToday, 'yyyy-MM-dd')}
                    onClick={() => {
                      if (dateRange.from) {
                        const toDate = dateRange.to || dateRange.from;
                        const daysDiff = Math.round((toDate.getTime() - dateRange.from.getTime()) / (1000 * 60 * 60 * 24));
                        const newTo = addDays(toDate, daysDiff + 1);
                        const cappedTo = newTo > berlinToday ? berlinToday : newTo;
                        const newFrom = addDays(dateRange.from, daysDiff + 1);
                        const cappedFrom = newFrom > berlinToday ? berlinToday : newFrom;
                        setDateRange({ from: cappedFrom, to: cappedTo });
                      }
                    }}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className={`space-y-4 transition-opacity duration-200 ${isDailyAnalyticsFetching ? 'opacity-60' : 'opacity-100'}`}>
                {/* Thread Distribution Section */}
                {distribution && (
                  <div>
                    <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
                      <MessageSquare className="h-4 w-4" />
                      Message Distribution
                    </h3>
                    <div className="grid grid-cols-3 gap-4">
                      <div className="text-center p-3 rounded-lg bg-muted/50">
                        <div className="text-2xl font-bold">{distribution.distribution['1_message']}</div>
                        <p className="text-xs text-muted-foreground">1 message ({distribution.total_threads > 0 ? ((distribution.distribution['1_message'] / distribution.total_threads) * 100).toFixed(1) : '0'}%)</p>
                      </div>
                      <div className="text-center p-3 rounded-lg bg-muted/50">
                        <div className="text-2xl font-bold">{distribution.distribution['2_3_messages']}</div>
                        <p className="text-xs text-muted-foreground">2-3 msgs ({distribution.total_threads > 0 ? ((distribution.distribution['2_3_messages'] / distribution.total_threads) * 100).toFixed(1) : '0'}%)</p>
                      </div>
                      <div className="text-center p-3 rounded-lg bg-muted/50">
                        <div className="text-2xl font-bold">{distribution.distribution['5_plus_messages']}</div>
                        <p className="text-xs text-muted-foreground">5+ msgs ({distribution.total_threads > 0 ? ((distribution.distribution['5_plus_messages'] / distribution.total_threads) * 100).toFixed(1) : '0'}%)</p>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground text-center mt-2">
                      Total: <span className="font-medium text-foreground">{distribution.total_threads}</span> threads
                    </p>
                  </div>
                )}

                {/* Divider */}
                {categoryDistribution && Object.keys(categoryDistribution.distribution).length > 0 && distribution && (
                  <div className="border-t" />
                )}

                {/* Category Distribution Section */}
                {categoryDistribution && Object.keys(categoryDistribution.distribution).length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-medium flex items-center gap-2">
                        <Filter className="h-4 w-4" />
                        Category Distribution
                      </h3>
                      {/* Tier Filter Dropdown */}
                      {tierDistribution && Object.keys(tierDistribution.distribution).length > 0 && (
                        <Select
                          value={tierFilter || 'all'}
                          onValueChange={(value) => setTierFilter(value === 'all' ? null : value)}
                        >
                          <SelectTrigger className="w-[150px] h-7 text-xs">
                            <CreditCard className="h-3 w-3 mr-1 text-muted-foreground" />
                            <SelectValue placeholder="All Tiers" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All Tiers</SelectItem>
                            {Object.entries(tierDistribution.distribution).map(([tier, count]) => {
                              const displayName = tier === 'none' ? 'No Subscription' :
                                tier === 'free' ? 'Free' :
                                tier === 'tier_2_20' ? 'Plus' :
                                tier === 'tier_6_50' ? 'Pro' :
                                tier === 'tier_12_100' ? 'Business' :
                                tier === 'tier_25_200' ? 'Ultra' :
                                tier === 'tier_50_400' ? 'Enterprise' :
                                tier === 'tier_125_800' ? 'Scale' :
                                tier === 'tier_200_1000' ? 'Max' : tier;
                              return (
                                <SelectItem key={tier} value={tier} className="[font-variant-ligatures:none]">
                                  {displayName} · {count}
                                </SelectItem>
                              );
                            })}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(categoryDistribution.distribution).map(([category, count]) => {
                        const percentage = categoryDistribution.total_projects > 0
                          ? ((count / categoryDistribution.total_projects) * 100).toFixed(1)
                          : '0.0';
                        const isSelected = categoryFilter === category;
                        return (
                          <button
                            key={category}
                            onClick={() => setCategoryFilter(isSelected ? null : category)}
                            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm transition-colors border ${
                              isSelected
                                ? 'bg-primary text-primary-foreground border-primary'
                                : 'bg-muted/50 hover:bg-muted border-transparent'
                            }`}
                          >
                            <span className="font-medium truncate max-w-[120px]" title={category}>
                              {category}
                            </span>
                            <span className={`text-xs ${isSelected ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>
                              {count} ({percentage}%)
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {categoryFilter && (
                      <p className="text-xs text-muted-foreground mt-2">
                        <button onClick={() => setCategoryFilter(null)} className="text-primary hover:underline">Clear filter</button>
                      </p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

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

          <TabsContent value="users">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Users className="h-5 w-5" />
                  User Management
                </CardTitle>
                <CardDescription>
                  Search users, view billing details, and manage credits
                </CardDescription>
              </CardHeader>
              <CardContent>
                <AdminUserTable onUserSelect={handleUserSelect} />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="retention">
            <RetentionTab onUserClick={handleUserEmailClick} />
          </TabsContent>

          <TabsContent value="simulator">
            <ARRSimulator analyticsSource={analyticsSource} />
          </TabsContent>
        </Tabs>

        {/* User Details Dialog - accessible from anywhere */}
        <AdminUserDetailsDialog
          user={selectedUser}
          isOpen={isUserDialogOpen}
          onClose={handleCloseUserDialog}
          onRefresh={handleRefreshUserData}
        />

        {/* Loading indicator when searching for user */}
        {isSearchingUser && pendingUserEmail && (
          <div className="fixed bottom-4 right-4 bg-background border rounded-lg shadow-lg p-3 flex items-center gap-2">
            <KortixLoader size="small" />
            <span className="text-sm">Loading user: {pendingUserEmail}</span>
          </div>
        )}
      </div>
    </div>
  );
}
