'use client';

import { useState, useMemo, useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Pagination } from '@/components/agents/pagination';
import { DataTable, DataTableColumn } from '@/components/ui/data-table';
import { toast } from 'sonner';
import {
  Users,
  MessageSquare,
  TrendingUp,
  Activity,
  Calendar as CalendarIcon,
  RefreshCw,
  ExternalLink,
  Languages,
  Eye,
  Filter,
  BarChart3,
  UserCheck,
  ArrowUpRight,
  ArrowDownRight,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { format } from 'date-fns';
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import {
  useAnalyticsSummary,
  useThreadBrowser,
  useMessageDistribution,
  useCategoryDistribution,
  useConversionFunnel,
  useRetentionData,
  useTranslate,
  useRefreshAnalytics,
  useARRWeeklyActuals,
  useUpdateARRWeeklyActual,
  useDeleteARRWeeklyActual,
  useARRSimulatorConfig,
  useUpdateARRSimulatorConfig,
  useSignupsByDate,
  useViewsByDate,
  type SimulatorConfigData,
  type ThreadAnalytics,
  type RetentionData,
  type ThreadBrowseParams,
  type WeeklyActualData,
} from '@/hooks/admin/use-admin-analytics';

// ============================================================================
// STAT CARD COMPONENT
// ============================================================================

interface StatCardProps {
  title: string;
  value: string | number;
  description?: string;
  icon: React.ReactNode;
  trend?: {
    value: number;
    isPositive: boolean;
  };
  className?: string;
}

function StatCard({ title, value, description, icon, trend, className }: StatCardProps) {
  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
          {icon}
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {description && (
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        )}
        {trend && (
          <div className={`flex items-center gap-1 mt-2 text-xs ${trend.isPositive ? 'text-green-600' : 'text-red-600'}`}>
            {trend.isPositive ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
            <span>{trend.value}%</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// THREAD BROWSER COMPONENT
// ============================================================================

interface ThreadBrowserProps {
  categoryFilter?: string | null;
  filterDate?: string | null;  // Date string in YYYY-MM-DD format for filtering when category is selected
  onClearCategory?: () => void;
}

function ThreadBrowser({ categoryFilter, filterDate, onClearCategory }: ThreadBrowserProps) {
  const [params, setParams] = useState<ThreadBrowseParams>({
    page: 1,
    page_size: 15,
    sort_by: 'created_at',
    sort_order: 'desc',
  });
  const [emailSearch, setEmailSearch] = useState('');
  const [messageFilter, setMessageFilter] = useState<string>('all');
  const [translations, setTranslations] = useState<Record<string, string>>({});
  
  // Reset page to 1 when category filter or date changes (date only matters when category is active)
  const prevCategoryRef = useRef(categoryFilter);
  const prevDateRef = useRef(filterDate);
  useEffect(() => {
    const categoryChanged = prevCategoryRef.current !== categoryFilter;
    const dateChanged = prevDateRef.current !== filterDate && categoryFilter;
    
    if (categoryChanged || dateChanged) {
      setParams(p => ({ ...p, page: 1 }));
    }
    
    prevCategoryRef.current = categoryFilter;
    prevDateRef.current = filterDate;
  }, [categoryFilter, filterDate]);
  
  // Include category filter and date filter in query params
  // When category is selected from distribution, also filter by the selected date
  const queryParams: ThreadBrowseParams = {
    ...params,
    category: categoryFilter || undefined,
    date_from: categoryFilter && filterDate ? filterDate : undefined,
    date_to: categoryFilter && filterDate ? filterDate : undefined,
  };
  
  const { data: threadsData, isLoading } = useThreadBrowser(queryParams);
  const translateMutation = useTranslate();

  const handleFilterChange = (filter: string) => {
    setMessageFilter(filter);
    let newParams = { ...params, page: 1 };
    
    switch (filter) {
      case '1':
        newParams.min_messages = 1;
        newParams.max_messages = 1;
        break;
      case '2-3':
        newParams.min_messages = 2;
        newParams.max_messages = 3;
        break;
      case '5+':
        newParams.min_messages = 5;
        newParams.max_messages = undefined;
        break;
      default:
        newParams.min_messages = undefined;
        newParams.max_messages = undefined;
    }
    
    setParams(newParams);
  };

  const handleEmailSearch = () => {
    setParams({ ...params, search_email: emailSearch || undefined, page: 1 });
  };

  const handleTranslate = async (threadId: string, text: string) => {
    try {
      const result = await translateMutation.mutateAsync({ text });
      setTranslations(prev => ({ ...prev, [threadId]: result.translated }));
      toast.success('Translated to English');
    } catch (error: any) {
      toast.error(error.message || 'Failed to translate');
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const columns: DataTableColumn<ThreadAnalytics>[] = useMemo(() => [
    {
      id: 'thread',
      header: 'Thread',
      cell: (thread) => (
        <div className="min-w-[250px]">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate max-w-[200px]">
              {thread.project_name || 'Untitled'}
            </span>
            {thread.is_public && (
              <Badge variant="outline" className="text-xs">Public</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {thread.user_email || 'Unknown user'}
          </p>
          <p className="text-xs text-muted-foreground font-mono">
            {thread.thread_id.slice(0, 8)}...
          </p>
        </div>
      ),
    },
    {
      id: 'messages',
      header: 'Messages',
      cell: (thread) => (
        <div className="text-center">
          <div className="font-semibold">{thread.user_message_count}</div>
          <p className="text-xs text-muted-foreground">user msgs</p>
          <p className="text-xs text-muted-foreground">{thread.message_count} total</p>
        </div>
      ),
      width: 'w-24',
    },
    {
      id: 'first_message',
      header: 'First Prompt',
      cell: (thread) => {
        const translation = translations[thread.thread_id];
        const displayText = translation || thread.first_user_message;
        
        return (
          <div className="min-w-[300px] max-w-[400px]">
            {displayText ? (
              <div>
                <p className="text-sm line-clamp-2">{displayText}</p>
                {!translation && thread.first_user_message && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-1 h-6 text-xs"
                    onClick={() => handleTranslate(thread.thread_id, thread.first_user_message!)}
                    disabled={translateMutation.isPending}
                  >
                    <Languages className="h-3 w-3 mr-1" />
                    Translate
                  </Button>
                )}
                {translation && (
                  <Badge variant="secondary" className="mt-1 text-xs">
                    <Languages className="h-3 w-3 mr-1" />
                    Translated
                  </Badge>
                )}
              </div>
            ) : (
              <span className="text-muted-foreground text-sm">No messages</span>
            )}
          </div>
        );
      },
    },
    {
      id: 'created',
      header: 'Created',
      cell: (thread) => (
        <div className="text-sm text-muted-foreground whitespace-nowrap">
          {formatDate(thread.created_at)}
        </div>
      ),
      width: 'w-36',
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: (thread) => (
        <Button
          variant="outline"
          size="sm"
          asChild
        >
          <a
            href={`/share/${thread.thread_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1"
          >
            <ExternalLink className="h-3 w-3" />
            Open
          </a>
        </Button>
      ),
      width: 'w-24',
    },
  ], [translations, translateMutation.isPending]);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex-1 min-w-[200px]">
          <Label htmlFor="email-search" className="text-sm">Search by Email</Label>
          <div className="flex gap-2 mt-1">
            <Input
              id="email-search"
              placeholder="user@example.com"
              value={emailSearch}
              onChange={(e) => setEmailSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleEmailSearch()}
            />
            <Button onClick={handleEmailSearch} variant="outline">
              Search
            </Button>
          </div>
        </div>
        
        <div className="w-[180px]">
          <Label className="text-sm">User Messages</Label>
          <Select value={messageFilter} onValueChange={handleFilterChange}>
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="Filter by messages" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All threads</SelectItem>
              <SelectItem value="1">1 message only</SelectItem>
              <SelectItem value="2-3">2-3 messages</SelectItem>
              <SelectItem value="5+">5+ messages</SelectItem>
            </SelectContent>
          </Select>
        </div>
        
        {/* Active Category Filter */}
        {categoryFilter && (
          <div className="flex items-end">
            <div>
              <Label className="text-sm">Category</Label>
              <Badge variant="secondary" className="mt-1 flex items-center gap-1 h-10 px-3">
                <Filter className="h-3 w-3" />
                {categoryFilter}
                {filterDate && (
                  <span className="text-muted-foreground">
                    ({filterDate})
                  </span>
                )}
                <button
                  onClick={onClearCategory}
                  className="ml-1 hover:text-destructive"
                >
                  ×
                </button>
              </Badge>
            </div>
          </div>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="p-6 space-y-3 rounded-2xl border">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={threadsData?.data || []}
          emptyMessage="No threads found matching your criteria"
          getItemId={(thread) => thread.thread_id}
        />
      )}

      {/* Pagination */}
      {threadsData?.pagination && (
        <Pagination
          currentPage={threadsData.pagination.current_page}
          totalPages={threadsData.pagination.total_pages}
          totalItems={threadsData.pagination.total_items}
          pageSize={threadsData.pagination.page_size}
          onPageChange={(page) => setParams({ ...params, page })}
          showPageSizeSelector={false}
          showJumpToPage={true}
        />
      )}
    </div>
  );
}

// ============================================================================
// RETENTION TAB COMPONENT
// ============================================================================

function RetentionTab() {
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
          <p className="font-medium">{user.email || 'Unknown'}</p>
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
  ], []);

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

// ============================================================================
// ARR SIMULATOR COMPONENT
// ============================================================================

interface SimulationMonth {
  month: string;
  monthIndex: number;
  visitors: number;
  signups: number;
  newPaid: number;
  churned: number;
  totalSubs: number;
  mrr: number;
  arr: number;
}

interface SimulationWeek {
  week: number;
  dateRange: string;
  monthIndex: number;
  // Goal values
  visitors: number;
  signups: number;
  newPaid: number;
  subscribers: number;
  mrr: number;
  arr: number;
}

interface WeeklyActual {
  views: number;
  signups: number;
  newPaid: number;
  subscribers: number;
  mrr: number;
  arr: number;
}

function ARRSimulator() {
  // Fetch config from database
  const { data: configData, isLoading: configLoading } = useARRSimulatorConfig();
  const updateConfigMutation = useUpdateARRSimulatorConfig();

  // Local state for config (initialized from DB, saved on blur)
  const [startingSubs, setStartingSubs] = useState(639);
  const [startingMRR, setStartingMRR] = useState(21646);
  const [weeklyVisitors, setWeeklyVisitors] = useState(40000);
  const [landingConversion, setLandingConversion] = useState(25);
  const [signupToPaid, setSignupToPaid] = useState(1);
  const [arpu, setArpu] = useState(34);
  const [monthlyChurn, setMonthlyChurn] = useState(25);
  const [visitorGrowth, setVisitorGrowth] = useState(5);
  const [targetARR, setTargetARR] = useState(10000000);

  // Initialize state from database when config loads
  useEffect(() => {
    if (configData) {
      setStartingSubs(configData.starting_subs);
      setStartingMRR(configData.starting_mrr);
      setWeeklyVisitors(configData.weekly_visitors);
      setLandingConversion(configData.landing_conversion);
      setSignupToPaid(configData.signup_to_paid);
      setArpu(configData.arpu);
      setMonthlyChurn(configData.monthly_churn);
      setVisitorGrowth(configData.visitor_growth);
      setTargetARR(configData.target_arr);
    }
  }, [configData]);

  // Save config to database
  const saveConfig = () => {
    updateConfigMutation.mutate({
      starting_subs: startingSubs,
      starting_mrr: startingMRR,
      weekly_visitors: weeklyVisitors,
      landing_conversion: landingConversion,
      signup_to_paid: signupToPaid,
      arpu: arpu,
      monthly_churn: monthlyChurn,
      visitor_growth: visitorGrowth,
      target_arr: targetARR,
    });
  };

  // Calculate monthly projections (aligned with HTML version logic)
  const projections = useMemo((): SimulationMonth[] => {
    const months: SimulationMonth[] = [];
    const monthNames = ['Dec 2025', 'Jan 2026', 'Feb 2026', 'Mar 2026', 'Apr 2026', 'May 2026'];
    
    let totalSubs = startingSubs;
    
    for (let i = 0; i < 6; i++) {
      // Monthly views = weekly views * 4.33 weeks per month, with compound growth
      const monthlyViews = Math.round(weeklyVisitors * 4.33 * Math.pow(1 + visitorGrowth / 100, i));
      
      // Signups from landing page
      const signups = Math.round(monthlyViews * (landingConversion / 100));
      
      // New paid customers
      const newPaid = Math.round(signups * (signupToPaid / 100));
      
      // Churned customers (from current total before adding new)
      const churned = Math.round(totalSubs * (monthlyChurn / 100));
      
      // Update subscriber count
      totalSubs = Math.max(0, totalSubs + newPaid - churned);
      
      // MRR = total subs * ARPU
      const mrr = totalSubs * arpu;
      
      // ARR = MRR * 12
      const arr = mrr * 12;
      
      months.push({
        month: monthNames[i],
        monthIndex: i,
        visitors: monthlyViews,
        signups,
        newPaid,
        churned,
        totalSubs,
        mrr,
        arr,
      });
    }
    
    return months;
  }, [startingSubs, weeklyVisitors, landingConversion, signupToPaid, arpu, monthlyChurn, visitorGrowth]);

  const finalMonth = projections[projections.length - 1];
  const gapToTarget = targetARR - (finalMonth?.arr || 0);
  const progressPercent = Math.min(100, ((finalMonth?.arr || 0) / targetARR) * 100);

  // Prepare chart data with negative churned for bar chart
  const chartData = projections.map(p => ({
    ...p,
    negativeChurned: -p.churned,
  }));

  // Date range for fetching signups (Dec 15, 2025 to Jun 15, 2026)
  const signupsDateFrom = '2025-12-15';
  const signupsDateTo = '2026-06-15';
  
  // Fetch signups grouped by date
  const { data: signupsByDateData } = useSignupsByDate(signupsDateFrom, signupsDateTo);
  
  // Fetch views (newUsers) from Google Analytics
  const { data: viewsByDateData } = useViewsByDate(signupsDateFrom, signupsDateTo);
  
  // Group signups by week number (frontend owns week logic)
  const signupsByWeek = useMemo((): Record<number, number> => {
    if (!signupsByDateData?.signups_by_date) return {};
    
    const startDate = new Date(2025, 11, 15); // Dec 15, 2025
    const result: Record<number, number> = {};
    
    Object.entries(signupsByDateData.signups_by_date).forEach(([dateStr, count]) => {
      const date = new Date(dateStr);
      const daysSinceStart = Math.floor((date.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
      const weekNum = Math.floor(daysSinceStart / 7) + 1;
      if (weekNum >= 1) {
        result[weekNum] = (result[weekNum] || 0) + count;
      }
    });
    
    return result;
  }, [signupsByDateData]);

  // Group views by week number (same logic as signups)
  const viewsByWeek = useMemo((): Record<number, number> => {
    if (!viewsByDateData?.views_by_date) return {};
    
    const startDate = new Date(2025, 11, 15); // Dec 15, 2025
    const result: Record<number, number> = {};
    
    Object.entries(viewsByDateData.views_by_date).forEach(([dateStr, count]) => {
      const date = new Date(dateStr);
      const daysSinceStart = Math.floor((date.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
      const weekNum = Math.floor(daysSinceStart / 7) + 1;
      if (weekNum >= 1) {
        result[weekNum] = (result[weekNum] || 0) + count;
      }
    });
    
    return result;
  }, [viewsByDateData]);

  // Weekly projections derived from monthly (matching HTML dashboard logic exactly)
  const weeklyProjections = useMemo((): SimulationWeek[] => {
    const weeks: SimulationWeek[] = [];
    const startDate = new Date(2025, 11, 15); // Dec 15, 2025 (Monday)
    
    let weekNum = 1;
    const currentDate = new Date(startDate);
    let totalSubs = startingSubs;
    
    projections.forEach((month, monthIdx) => {
      // HTML logic: every 3rd month (index 2, 5, ...) has 5 weeks, others have 4
      const weeksInMonth = monthIdx % 3 === 2 ? 5 : 4;
      
      // Split monthly data evenly across weeks
      const weeklyViews = Math.round(month.visitors / weeksInMonth);
      const weeklySignups = Math.round(month.signups / weeksInMonth);
      const weeklyNewPaid = Math.round(month.newPaid / weeksInMonth);
      const weeklyChurned = Math.round(month.churned / weeksInMonth);
      
      for (let w = 0; w < weeksInMonth; w++) {
        const weekStart = new Date(currentDate);
        const weekEnd = new Date(currentDate);
        weekEnd.setDate(weekEnd.getDate() + 6);
        
        // Update running subscriber count (matching HTML logic)
        totalSubs = Math.max(0, totalSubs + weeklyNewPaid - weeklyChurned);
        const weeklyMRR = totalSubs * arpu;
        const weeklyARR = weeklyMRR * 12;
        
        weeks.push({
          week: weekNum,
          dateRange: `${weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
          monthIndex: monthIdx,
          visitors: weeklyViews,
          signups: weeklySignups,
          newPaid: weeklyNewPaid,
          subscribers: Math.round(totalSubs),
          mrr: Math.round(weeklyMRR),
          arr: Math.round(weeklyARR),
        });
        
        weekNum++;
        currentDate.setDate(currentDate.getDate() + 7);
      }
    });
    
    return weeks;
  }, [projections, startingSubs, arpu]);

  // Actual weekly data (persisted to database)
  const { data: arrActualsData, isLoading: actualsLoading } = useARRWeeklyActuals();
  const updateActualMutation = useUpdateARRWeeklyActual();
  const deleteActualMutation = useDeleteARRWeeklyActual();

  // Convert API data to local format
  const actualData: Record<number, WeeklyActual> = useMemo(() => {
    if (!arrActualsData?.actuals) return {};
    const result: Record<number, WeeklyActual> = {};
    Object.entries(arrActualsData.actuals).forEach(([weekNum, data]) => {
      result[Number(weekNum)] = {
        views: data.views || 0,
        signups: data.signups || 0,
        newPaid: data.new_paid || 0,
        subscribers: data.subscribers || 0,
        mrr: data.mrr || 0,
        arr: data.arr || 0,
      };
    });
    return result;
  }, [arrActualsData]);

  // Local state for pending edits (so we don't call API on every keystroke)
  const [pendingEdits, setPendingEdits] = useState<Record<string, string>>({});

  // Get display value for an input (pending edit or saved value)
  const getInputValue = (week: number, field: keyof WeeklyActual): string => {
    const key = `${week}-${field}`;
    if (key in pendingEdits) return pendingEdits[key];
    const saved = actualData[week]?.[field];
    return saved ? String(saved) : '';
  };

  // Handle input change (local state only)
  const handleInputChange = (week: number, field: keyof WeeklyActual, value: string) => {
    const key = `${week}-${field}`;
    setPendingEdits(prev => ({ ...prev, [key]: value }));
  };

  // Save to API on blur
  const handleInputBlur = (week: number, field: keyof WeeklyActual) => {
    const key = `${week}-${field}`;
    const pendingValue = pendingEdits[key];
    
    // If no pending edit, nothing to save
    if (pendingValue === undefined) return;
    
    const weekProjection = weeklyProjections.find(w => w.week === week);
    if (!weekProjection) return;
    
    const value = Number(pendingValue) || 0;
    const currentData = actualData[week] || { views: 0, signups: 0, newPaid: 0, subscribers: 0, mrr: 0, arr: 0 };
    const updatedData = { ...currentData, [field]: value };
    
    // Map field names for API
    const apiData: WeeklyActualData = {
      week_number: week,
      week_start_date: new Date(2025, 11, 15 + (week - 1) * 7).toISOString().split('T')[0],
      views: updatedData.views,
      signups: updatedData.signups,
      new_paid: updatedData.newPaid,
      subscribers: updatedData.subscribers,
      mrr: updatedData.mrr,
      arr: updatedData.arr,
    };
    
    updateActualMutation.mutate(apiData);
  };

  const deleteWeekActual = (weekNumber: number) => {
    // Clear any pending edits for this week (signups excluded - it's auto-fetched)
    setPendingEdits(prev => {
      const next = { ...prev };
      const fields: (keyof WeeklyActual)[] = ['views', 'newPaid', 'subscribers', 'mrr', 'arr'];
      fields.forEach(field => {
        delete next[`${weekNumber}-${field}`];
      });
      return next;
    });
    deleteActualMutation.mutate(weekNumber);
  };

  // Calculate variance percentage
  const getVariance = (actual: number | undefined, goal: number): { value: number; color: string } => {
    if (!actual || actual === 0) return { value: 0, color: 'text-muted-foreground' };
    const variance = ((actual - goal) / goal) * 100;
    if (variance >= 0) return { value: variance, color: 'text-green-600' };
    if (variance >= -10) return { value: variance, color: 'text-yellow-600' };
    return { value: variance, color: 'text-red-500' };
  };

  // Prepare weekly chart data for actual vs goal comparison
  const weeklyChartData = weeklyProjections.map(w => ({
    week: `W${w.week}`,
    goalViews: w.visitors,
    actualViews: viewsByWeek[w.week] || 0,
    goalSignups: w.signups,
    actualSignups: signupsByWeek[w.week] || 0,
    goalNewPaid: w.newPaid,
    actualNewPaid: actualData[w.week]?.newPaid || 0,
    goalSubs: w.subscribers,
    actualSubs: actualData[w.week]?.subscribers || 0,
    goalMRR: w.mrr,
    actualMRR: actualData[w.week]?.mrr || 0,
    goalARR: w.arr,
    actualARR: actualData[w.week]?.arr || 0,
  }));

  // Aggregate weekly actuals into monthly actuals for comparison
  const monthlyActuals = useMemo(() => {
    const result: Record<number, { views: number; signups: number; newPaid: number; subscribers: number; mrr: number; arr: number }> = {};
    
    weeklyProjections.forEach((week) => {
      const monthIdx = week.monthIndex;
      const weekActual = actualData[week.week];
      const autoSignups = signupsByWeek[week.week] || 0;
      const autoViews = viewsByWeek[week.week] || 0;
      
      if (!result[monthIdx]) {
        result[monthIdx] = { views: 0, signups: 0, newPaid: 0, subscribers: 0, mrr: 0, arr: 0 };
      }
      
      // Use auto-fetched signups from database
      result[monthIdx].signups += autoSignups;
      // Use auto-fetched views from Google Analytics
      result[monthIdx].views += autoViews;
      
      if (weekActual) {
        result[monthIdx].newPaid += weekActual.newPaid || 0;
        // For subscribers, MRR, ARR - take the last week's value as end-of-month value
        result[monthIdx].subscribers = weekActual.subscribers || result[monthIdx].subscribers;
        result[monthIdx].mrr = weekActual.mrr || result[monthIdx].mrr;
        result[monthIdx].arr = weekActual.arr || result[monthIdx].arr;
      }
    });
    
    return result;
  }, [weeklyProjections, actualData, signupsByWeek, viewsByWeek]);

  // View state
  const [simulatorView, setSimulatorView] = useState<'monthly' | 'weekly'>('monthly');

  // Format currency
  const formatCurrency = (value: number) => {
    if (value >= 1000000) {
      return `$${(value / 1000000).toFixed(2)}M`;
    } else if (value >= 1000) {
      return `$${(value / 1000).toFixed(1)}K`;
    }
    return `$${value.toFixed(0)}`;
  };

  const formatNumber = (value: number) => {
    if (value >= 1000000) {
      return `${(value / 1000000).toFixed(2)}M`;
    } else if (value >= 1000) {
      return `${(value / 1000).toFixed(1)}K`;
    }
    return value.toLocaleString();
  };

  return (
    <div className="space-y-6">
      {/* Parameters */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            ARR Growth Simulator
          </CardTitle>
          <CardDescription>
            Adjust parameters to model your path to {formatCurrency(targetARR)} ARR by June 2026
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
            <div className="space-y-2">
              <Label className="text-xs">Starting Subscribers</Label>
              <Input
                type="number"
                value={startingSubs || ''}
                onChange={(e) => setStartingSubs(e.target.value === '' ? 0 : Number(e.target.value))}
                onBlur={saveConfig}
                className="h-9"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Starting MRR ($)</Label>
              <Input
                type="number"
                value={startingMRR || ''}
                onChange={(e) => setStartingMRR(e.target.value === '' ? 0 : Number(e.target.value))}
                onBlur={saveConfig}
                className="h-9"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Weekly Visitors</Label>
              <Input
                type="number"
                value={weeklyVisitors || ''}
                onChange={(e) => setWeeklyVisitors(e.target.value === '' ? 0 : Number(e.target.value))}
                onBlur={saveConfig}
                className="h-9"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Monthly Visitor Growth (%)</Label>
              <Input
                type="number"
                value={visitorGrowth || ''}
                onChange={(e) => setVisitorGrowth(e.target.value === '' ? 0 : Number(e.target.value))}
                onBlur={saveConfig}
                className="h-9"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Landing Conv. (%)</Label>
              <Input
                type="number"
                value={landingConversion || ''}
                onChange={(e) => setLandingConversion(e.target.value === '' ? 0 : Number(e.target.value))}
                onBlur={saveConfig}
                className="h-9"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Signup → Paid (%)</Label>
              <Input
                type="number"
                value={signupToPaid || ''}
                onChange={(e) => setSignupToPaid(e.target.value === '' ? 0 : Number(e.target.value))}
                onBlur={saveConfig}
                step="0.1"
                className="h-9"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">ARPU ($/mo)</Label>
              <Input
                type="number"
                value={arpu || ''}
                onChange={(e) => setArpu(e.target.value === '' ? 0 : Number(e.target.value))}
                onBlur={saveConfig}
                className="h-9"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Monthly Churn (%)</Label>
              <Input
                type="number"
                value={monthlyChurn || ''}
                onChange={(e) => setMonthlyChurn(e.target.value === '' ? 0 : Number(e.target.value))}
                onBlur={saveConfig}
                className="h-9"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Target ARR ($)</Label>
              <Input
                type="number"
                value={targetARR || ''}
                onChange={(e) => setTargetARR(e.target.value === '' ? 0 : Number(e.target.value))}
                onBlur={saveConfig}
                className="h-9"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* View Toggle */}
      <div className="flex items-center gap-2">
        <Button
          variant={simulatorView === 'monthly' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setSimulatorView('monthly')}
        >
          📅 Monthly View
        </Button>
        <Button
          variant={simulatorView === 'weekly' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setSimulatorView('weekly')}
        >
          📊 Weekly Tracking
        </Button>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-primary">{formatCurrency(finalMonth?.arr || 0)}</div>
            <p className="text-xs text-muted-foreground mt-1">Projected ARR (Jun 2026)</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{formatNumber(finalMonth?.totalSubs || 0)}</div>
            <p className="text-xs text-muted-foreground mt-1">Total Subscribers</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className={`text-2xl font-bold ${gapToTarget > 0 ? 'text-red-500' : 'text-green-500'}`}>
              {gapToTarget > 0 ? `-${formatCurrency(gapToTarget)}` : `+${formatCurrency(Math.abs(gapToTarget))}`}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Gap to Target</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{progressPercent.toFixed(1)}%</div>
            <p className="text-xs text-muted-foreground mt-1">Progress to Goal</p>
            <div className="mt-2 h-2 bg-muted rounded-full overflow-hidden">
              <div 
                className={`h-full transition-all ${progressPercent >= 100 ? 'bg-green-500' : 'bg-primary'}`}
                style={{ width: `${Math.min(100, progressPercent)}%` }}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ARR Progress Bar */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">ARR Trajectory</span>
            <span className="text-sm text-muted-foreground">
              {formatCurrency(projections[0]?.arr || 0)} → {formatCurrency(finalMonth?.arr || 0)}
            </span>
          </div>
          <div className="relative h-8 bg-muted rounded-lg overflow-hidden">
            {projections.map((month, i) => {
              const width = (month.arr / targetARR) * 100;
              const opacity = 0.3 + (i / projections.length) * 0.7;
              return (
                <div
                  key={month.month}
                  className="absolute h-full bg-primary transition-all"
                  style={{
                    width: `${Math.min(100, width)}%`,
                    opacity,
                    left: 0,
                  }}
                />
              );
            })}
            <div 
              className="absolute h-full border-r-2 border-dashed border-green-500"
              style={{ left: '100%' }}
            />
            <div className="absolute inset-0 flex items-center justify-end pr-2">
              <span className="text-xs font-medium text-green-600 bg-background/80 px-1 rounded">
                {formatCurrency(targetARR)} target
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {simulatorView === 'monthly' && (
      <>
      {/* Charts Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* ARR Growth Trajectory */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              📈 ARR Growth Trajectory
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={projections}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis 
                    dataKey="month" 
                    tick={{ fontSize: 12 }}
                    tickFormatter={(value) => value.replace(/ \d{4}$/, '')}
                  />
                  <YAxis 
                    tick={{ fontSize: 12 }}
                    tickFormatter={(value) => `$${(value / 1000000).toFixed(1)}M`}
                    domain={[0, Math.max(targetARR * 1.1, (finalMonth?.arr || 0) * 1.2)]}
                  />
                  <Tooltip 
                    formatter={(value: number) => [formatCurrency(value), 'ARR']}
                    labelStyle={{ color: 'hsl(var(--foreground))' }}
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--background))', 
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                  />
                  <Legend />
                  <ReferenceLine 
                    y={targetARR} 
                    stroke="#10b981" 
                    strokeDasharray="5 5" 
                    label={{ value: '$10M Target', position: 'right', fill: '#10b981', fontSize: 12 }}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="arr" 
                    name="ARR"
                    stroke="hsl(var(--primary))" 
                    strokeWidth={3}
                    dot={{ fill: 'hsl(var(--primary))', strokeWidth: 2, r: 5 }}
                    activeDot={{ r: 7 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* Subscriber Growth */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              👥 Subscriber Growth
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={projections}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis 
                    dataKey="month" 
                    tick={{ fontSize: 12 }}
                    tickFormatter={(value) => value.replace(/ \d{4}$/, '')}
                  />
                  <YAxis 
                    tick={{ fontSize: 12 }}
                    tickFormatter={(value) => formatNumber(value)}
                  />
                  <Tooltip 
                    formatter={(value: number) => [formatNumber(value), 'Subscribers']}
                    labelStyle={{ color: 'hsl(var(--foreground))' }}
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--background))', 
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                  />
                  <Legend />
                  <Area 
                    type="monotone" 
                    dataKey="totalSubs" 
                    name="Total Subscribers"
                    stroke="#8b5cf6" 
                    fill="#8b5cf6"
                    fillOpacity={0.2}
                    strokeWidth={3}
                    dot={{ fill: '#8b5cf6', strokeWidth: 2, r: 5 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* MRR Growth */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              💰 MRR Growth
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={projections}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis 
                    dataKey="month" 
                    tick={{ fontSize: 12 }}
                    tickFormatter={(value) => value.replace(/ \d{4}$/, '')}
                  />
                  <YAxis 
                    tick={{ fontSize: 12 }}
                    tickFormatter={(value) => `$${(value / 1000).toFixed(0)}K`}
                  />
                  <Tooltip 
                    formatter={(value: number) => [formatCurrency(value), 'MRR']}
                    labelStyle={{ color: 'hsl(var(--foreground))' }}
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--background))', 
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                  />
                  <Legend />
                  <Area 
                    type="monotone" 
                    dataKey="mrr" 
                    name="MRR"
                    stroke="#f59e0b" 
                    fill="#f59e0b"
                    fillOpacity={0.2}
                    strokeWidth={3}
                    dot={{ fill: '#f59e0b', strokeWidth: 2, r: 5 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* New Signups vs Churn */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              📊 New Signups vs Churn
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis 
                    dataKey="month" 
                    tick={{ fontSize: 12 }}
                    tickFormatter={(value) => value.replace(/ \d{4}$/, '')}
                  />
                  <YAxis 
                    tick={{ fontSize: 12 }}
                    tickFormatter={(value) => formatNumber(Math.abs(value))}
                  />
                  <Tooltip 
                    formatter={(value: number, name: string) => [
                      formatNumber(Math.abs(value)), 
                      name
                    ]}
                    labelStyle={{ color: 'hsl(var(--foreground))' }}
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--background))', 
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                  />
                  <Legend />
                  <Bar 
                    dataKey="newPaid" 
                    name="New Paid Customers"
                    fill="#10b981" 
                    radius={[4, 4, 0, 0]}
                  />
                  <Bar 
                    dataKey="negativeChurned" 
                    name="Churned Customers"
                    fill="#ef4444" 
                    radius={[0, 0, 4, 4]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Monthly Breakdown Table with Actual vs Goal */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Monthly Breakdown (Goal vs Actual)</CardTitle>
          <CardDescription>Projected growth from Dec 2025 to Jun 2026 with actual data comparison</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left p-3 font-medium">Month</th>
                  <th className="text-center p-3 font-medium" colSpan={2}>Visitors</th>
                  <th className="text-center p-3 font-medium" colSpan={2}>Signups</th>
                  <th className="text-center p-3 font-medium" colSpan={2}>New Paid</th>
                  <th className="text-center p-3 font-medium" colSpan={2}>Total Subs</th>
                  <th className="text-center p-3 font-medium" colSpan={2}>MRR</th>
                  <th className="text-center p-3 font-medium" colSpan={2}>ARR</th>
                </tr>
                <tr className="border-b bg-muted/30 text-xs">
                  <th></th>
                  <th className="text-right p-2 text-muted-foreground font-normal">Goal</th>
                  <th className="text-right p-2 text-muted-foreground font-normal">Actual</th>
                  <th className="text-right p-2 text-muted-foreground font-normal">Goal</th>
                  <th className="text-right p-2 text-muted-foreground font-normal">Actual</th>
                  <th className="text-right p-2 text-muted-foreground font-normal">Goal</th>
                  <th className="text-right p-2 text-muted-foreground font-normal">Actual</th>
                  <th className="text-right p-2 text-muted-foreground font-normal">Goal</th>
                  <th className="text-right p-2 text-muted-foreground font-normal">Actual</th>
                  <th className="text-right p-2 text-muted-foreground font-normal">Goal</th>
                  <th className="text-right p-2 text-muted-foreground font-normal">Actual</th>
                  <th className="text-right p-2 text-muted-foreground font-normal">Goal</th>
                  <th className="text-right p-2 text-muted-foreground font-normal">Actual</th>
                </tr>
              </thead>
              <tbody>
                {projections.map((month, i) => {
                  const actual = monthlyActuals[i] || { views: 0, signups: 0, newPaid: 0, subscribers: 0, mrr: 0, arr: 0 };
                  const hasActual = actual.views > 0 || actual.signups > 0 || actual.subscribers > 0;
                  
                  return (
                    <tr key={month.month} className={`border-b ${i === projections.length - 1 ? 'bg-primary/5 font-medium' : ''}`}>
                      <td className="p-3">{month.month}</td>
                      {/* Visitors */}
                      <td className="text-right p-2 text-muted-foreground">{formatNumber(month.visitors)}</td>
                      <td className={`text-right p-2 font-medium ${hasActual && actual.views >= month.visitors ? 'text-green-600' : hasActual ? 'text-red-500' : 'text-muted-foreground'}`}>
                        {actual.views > 0 ? formatNumber(actual.views) : '—'}
                      </td>
                      {/* Signups */}
                      <td className="text-right p-2 text-muted-foreground">{formatNumber(month.signups)}</td>
                      <td className={`text-right p-2 font-medium ${hasActual && actual.signups >= month.signups ? 'text-green-600' : hasActual ? 'text-red-500' : 'text-muted-foreground'}`}>
                        {actual.signups > 0 ? formatNumber(actual.signups) : '—'}
                      </td>
                      {/* New Paid */}
                      <td className="text-right p-2 text-muted-foreground">{formatNumber(month.newPaid)}</td>
                      <td className={`text-right p-2 font-medium ${hasActual && actual.newPaid >= month.newPaid ? 'text-green-600' : hasActual ? 'text-red-500' : 'text-muted-foreground'}`}>
                        {actual.newPaid > 0 ? formatNumber(actual.newPaid) : '—'}
                      </td>
                      {/* Total Subs */}
                      <td className="text-right p-2 text-muted-foreground">{formatNumber(month.totalSubs)}</td>
                      <td className={`text-right p-2 font-medium ${hasActual && actual.subscribers >= month.totalSubs ? 'text-green-600' : hasActual ? 'text-red-500' : 'text-muted-foreground'}`}>
                        {actual.subscribers > 0 ? formatNumber(actual.subscribers) : '—'}
                      </td>
                      {/* MRR */}
                      <td className="text-right p-2 text-muted-foreground">{formatCurrency(month.mrr)}</td>
                      <td className={`text-right p-2 font-medium ${hasActual && actual.mrr >= month.mrr ? 'text-green-600' : hasActual ? 'text-red-500' : 'text-muted-foreground'}`}>
                        {actual.mrr > 0 ? formatCurrency(actual.mrr) : '—'}
                      </td>
                      {/* ARR */}
                      <td className="text-right p-2 text-muted-foreground">{formatCurrency(month.arr)}</td>
                      <td className={`text-right p-2 font-medium ${hasActual && actual.arr >= month.arr ? 'text-green-600' : hasActual ? 'text-red-500' : 'text-muted-foreground'}`}>
                        {actual.arr > 0 ? formatCurrency(actual.arr) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
      </>
      )}

      {/* Weekly Tracking View */}
      {simulatorView === 'weekly' && (
      <>
        {/* Weekly Comparison Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* ARR: Actual vs Goal */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">📈 ARR: Actual vs Goal</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[250px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={weeklyChartData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="week" tick={{ fontSize: 10 }} interval={3} />
                    <YAxis tickFormatter={(v) => `$${v.toLocaleString()}`} tick={{ fontSize: 9 }} width={80} />
                    <Tooltip formatter={(v: number) => [`$${v.toLocaleString()}`, '']} />
                    <Legend />
                    <Line type="monotone" dataKey="goalARR" name="Goal" stroke="#10b981" strokeWidth={2} dot={false} strokeDasharray="5 5" />
                    <Line type="monotone" dataKey="actualARR" name="Actual" stroke="hsl(var(--primary))" strokeWidth={3} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* Subscribers: Actual vs Goal */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">👥 Subscribers: Actual vs Goal</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[250px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={weeklyChartData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="week" tick={{ fontSize: 10 }} interval={3} />
                    <YAxis tickFormatter={(v) => v.toLocaleString()} tick={{ fontSize: 9 }} width={60} />
                    <Tooltip formatter={(v: number) => [v.toLocaleString(), '']} />
                    <Legend />
                    <Line type="monotone" dataKey="goalSubs" name="Goal" stroke="#10b981" strokeWidth={2} dot={false} strokeDasharray="5 5" />
                    <Line type="monotone" dataKey="actualSubs" name="Actual" stroke="#8b5cf6" strokeWidth={3} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* MRR: Actual vs Goal */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">💰 MRR: Actual vs Goal</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[250px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={weeklyChartData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="week" tick={{ fontSize: 10 }} interval={3} />
                    <YAxis tickFormatter={(v) => `$${v.toLocaleString()}`} tick={{ fontSize: 9 }} width={70} />
                    <Tooltip formatter={(v: number) => [`$${v.toLocaleString()}`, '']} />
                    <Legend />
                    <Line type="monotone" dataKey="goalMRR" name="Goal" stroke="#10b981" strokeWidth={2} dot={false} strokeDasharray="5 5" />
                    <Line type="monotone" dataKey="actualMRR" name="Actual" stroke="#f59e0b" strokeWidth={3} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* New Paid: Actual vs Goal */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">🎯 New Paid: Actual vs Goal</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[250px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={weeklyChartData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="week" tick={{ fontSize: 10 }} interval={3} />
                    <YAxis tickFormatter={(v) => v.toLocaleString()} tick={{ fontSize: 9 }} />
                    <Tooltip formatter={(v: number) => [v.toLocaleString(), '']} />
                    <Legend />
                    <Bar dataKey="goalNewPaid" name="Goal" fill="#10b981" opacity={0.3} />
                    <Bar dataKey="actualNewPaid" name="Actual" fill="#10b981" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Weekly Breakdown Table with Actual Data Entry */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">📊 Weekly Tracking (Dec 2025 - Jun 2026)</CardTitle>
            <CardDescription>
              Enter actual weekly data to compare against goals. Click any Actual cell to edit.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-background">
                  <tr className="border-b bg-muted/50">
                    <th className="text-left p-2 font-medium">Week</th>
                    <th className="text-left p-2 font-medium">Date Range</th>
                    <th className="text-center p-2 font-medium" colSpan={3}>Views</th>
                    <th className="text-center p-2 font-medium" colSpan={3}>Signups</th>
                    <th className="text-center p-2 font-medium" colSpan={3}>New Paid</th>
                    <th className="text-center p-2 font-medium" colSpan={3}>Subscribers</th>
                    <th className="text-center p-2 font-medium" colSpan={3}>MRR</th>
                    <th className="text-center p-2 font-medium" colSpan={3}>ARR</th>
                    <th className="p-2 w-8"></th>
                  </tr>
                  <tr className="border-b bg-muted/30">
                    <th></th>
                    <th></th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Goal</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Actual</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Var%</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Goal</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Actual</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Var%</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Goal</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Actual</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Var%</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Goal</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Actual</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Var%</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Goal</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Actual</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Var%</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Goal</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Actual</th>
                    <th className="text-right p-2 text-muted-foreground font-normal text-[10px]">Var%</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {weeklyProjections.map((week) => {
                    const actual: Partial<WeeklyActual> = actualData[week.week] || {};
                    // Get auto-fetched data
                    const autoViews = viewsByWeek[week.week] ?? 0;
                    const autoSignups = signupsByWeek[week.week] ?? 0;
                    const viewsVar = getVariance(autoViews, week.visitors);
                    const signupsVar = getVariance(autoSignups, week.signups);
                    const newPaidVar = getVariance(actual.newPaid, week.newPaid);
                    const subsVar = getVariance(actual.subscribers, week.subscribers);
                    const mrrVar = getVariance(actual.mrr, week.mrr);
                    const arrVar = getVariance(actual.arr, week.arr);
                    
                    return (
                      <tr key={week.week} className={`border-b hover:bg-muted/30 ${week.week === weeklyProjections.length ? 'bg-primary/5 font-medium' : ''}`}>
                        <td className="p-2 font-medium">W{week.week}</td>
                        <td className="p-2 text-muted-foreground whitespace-nowrap">{week.dateRange}</td>
                        {/* Views - Auto-fetched from Google Analytics */}
                        <td className="text-right p-1">{formatNumber(week.visitors)}</td>
                        <td className="text-right p-1">
                          <span className={`text-[10px] font-medium ${autoViews > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                            {autoViews > 0 ? formatNumber(autoViews) : '—'}
                          </span>
                        </td>
                        <td className={`text-right p-1 text-[10px] ${viewsVar.color}`}>
                          {autoViews > 0 ? `${viewsVar.value >= 0 ? '+' : ''}${viewsVar.value.toFixed(1)}%` : '—'}
                        </td>
                        {/* Signups - Auto-fetched from database */}
                        <td className="text-right p-1">{formatNumber(week.signups)}</td>
                        <td className="text-right p-1">
                          <span className={`text-[10px] font-medium ${autoSignups > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                            {autoSignups > 0 ? formatNumber(autoSignups) : '—'}
                          </span>
                        </td>
                        <td className={`text-right p-1 text-[10px] ${signupsVar.color}`}>
                          {autoSignups > 0 ? `${signupsVar.value >= 0 ? '+' : ''}${signupsVar.value.toFixed(1)}%` : '—'}
                        </td>
                        {/* New Paid */}
                        <td className="text-right p-1">{formatNumber(week.newPaid)}</td>
                        <td className="text-right p-1">
                          <Input
                            type="number"
                            value={getInputValue(week.week, 'newPaid')}
                            onChange={(e) => handleInputChange(week.week, 'newPaid', e.target.value)}
                            onBlur={() => handleInputBlur(week.week, 'newPaid')}
                            className="h-5 w-16 text-[10px] text-right [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                            placeholder="—"
                          />
                        </td>
                        <td className={`text-right p-1 text-[10px] ${newPaidVar.color}`}>
                          {actual.newPaid ? `${newPaidVar.value >= 0 ? '+' : ''}${newPaidVar.value.toFixed(1)}%` : '—'}
                        </td>
                        {/* Subscribers */}
                        <td className="text-right p-1 font-medium">{formatNumber(week.subscribers)}</td>
                        <td className="text-right p-1">
                          <Input
                            type="number"
                            value={getInputValue(week.week, 'subscribers')}
                            onChange={(e) => handleInputChange(week.week, 'subscribers', e.target.value)}
                            onBlur={() => handleInputBlur(week.week, 'subscribers')}
                            className="h-5 w-16 text-[10px] text-right [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                            placeholder="—"
                          />
                        </td>
                        <td className={`text-right p-1 text-[10px] ${subsVar.color}`}>
                          {actual.subscribers ? `${subsVar.value >= 0 ? '+' : ''}${subsVar.value.toFixed(1)}%` : '—'}
                        </td>
                        {/* MRR */}
                        <td className="text-right p-1">{formatCurrency(week.mrr)}</td>
                        <td className="text-right p-1">
                          <Input
                            type="number"
                            value={getInputValue(week.week, 'mrr')}
                            onChange={(e) => handleInputChange(week.week, 'mrr', e.target.value)}
                            onBlur={() => handleInputBlur(week.week, 'mrr')}
                            className="h-5 w-16 text-[10px] text-right [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                            placeholder="—"
                          />
                        </td>
                        <td className={`text-right p-1 text-[10px] ${mrrVar.color}`}>
                          {actual.mrr ? `${mrrVar.value >= 0 ? '+' : ''}${mrrVar.value.toFixed(1)}%` : '—'}
                        </td>
                        {/* ARR */}
                        <td className="text-right p-1 font-medium">{formatCurrency(week.arr)}</td>
                        <td className="text-right p-1">
                          <Input
                            type="number"
                            value={getInputValue(week.week, 'arr')}
                            onChange={(e) => handleInputChange(week.week, 'arr', e.target.value)}
                            onBlur={() => handleInputBlur(week.week, 'arr')}
                            className="h-5 w-16 text-[10px] text-right [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                            placeholder="—"
                          />
                        </td>
                        <td className={`text-right p-1 text-[10px] ${arrVar.color}`}>
                          {actual.arr ? `${arrVar.value >= 0 ? '+' : ''}${arrVar.value.toFixed(1)}%` : '—'}
                        </td>
                        <td className="p-1">
                          {(actual.newPaid || actual.subscribers || actual.mrr || actual.arr) && (
                            <button
                              onClick={() => deleteWeekActual(week.week)}
                              className="text-muted-foreground hover:text-red-500 transition-colors"
                              title={`Delete week ${week.week} data`}
                            >
                              🗑️
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </>
      )}

    </div>
  );
}

// ============================================================================
// MAIN PAGE COMPONENT
// ============================================================================

// Get current date in UTC
function getUTCToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export default function AdminAnalyticsPage() {
  const [distributionDate, setDistributionDate] = useState<Date>(getUTCToday);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  
  const utcToday = getUTCToday();
  const dateString = format(distributionDate, 'yyyy-MM-dd');
  
  const { data: summary, isLoading: summaryLoading } = useAnalyticsSummary();
  const { data: distribution } = useMessageDistribution(dateString);
  const { data: categoryDistribution } = useCategoryDistribution(dateString);
  const { data: conversionFunnel, isLoading: funnelLoading } = useConversionFunnel(dateString);
  const { refreshAll } = useRefreshAnalytics();

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
          <Button onClick={refreshAll} variant="outline">
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>

        {/* Summary Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {summaryLoading ? (
            [...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-32" />
            ))
          ) : (
            <>
              <StatCard
                title="Total Users"
                value={summary?.total_users?.toLocaleString() || '0'}
                description={`${summary?.active_users_week || 0} active this week`}
                icon={<Users className="h-4 w-4 text-primary" />}
              />
              <StatCard
                title="New Signups Today"
                value={summary?.new_signups_today || 0}
                description={`${summary?.new_signups_week || 0} this week`}
                icon={<TrendingUp className="h-4 w-4 text-primary" />}
              />
              <StatCard
                title="Conversion Rate"
                value={`${summary?.conversion_rate_week || 0}%`}
                description="Signups → Subscriptions (week)"
                icon={<Activity className="h-4 w-4 text-primary" />}
              />
              <StatCard
                title="Total Threads"
                value={summary?.total_threads?.toLocaleString() || '0'}
                description={`Avg ${summary?.avg_threads_per_user?.toFixed(1) || 0} per user`}
                icon={<MessageSquare className="h-4 w-4 text-primary" />}
              />
            </>
          )}
        </div>

        {/* Daily Analytics - Unified Card */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <BarChart3 className="h-5 w-5" />
                Daily Analytics (UTC)
              </CardTitle>
              <CardDescription>
                Conversion funnel, threads, and categories
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => {
                  const prev = new Date(distributionDate);
                  prev.setDate(prev.getDate() - 1);
                  setDistributionDate(prev);
                }}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="min-w-[160px] justify-start text-left font-normal">
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {format(distributionDate, 'MMM d, yyyy')}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="end">
                  <Calendar
                    mode="single"
                    selected={distributionDate}
                    onSelect={(date) => {
                      if (date) {
                        setDistributionDate(date);
                        setCalendarOpen(false);
                      }
                    }}
                    disabled={(date) => date > utcToday}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                disabled={format(distributionDate, 'yyyy-MM-dd') === format(utcToday, 'yyyy-MM-dd')}
                onClick={() => {
                  const next = new Date(distributionDate);
                  next.setDate(next.getDate() + 1);
                  setDistributionDate(next);
                }}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Conversion Funnel Section */}
            <div>
              <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
                <TrendingUp className="h-4 w-4" />
                Conversion Funnel
              </h3>
              {funnelLoading ? (
                <div className="grid grid-cols-3 gap-4">
                  {[...Array(3)].map((_, i) => (
                    <Skeleton key={i} className="h-20" />
                  ))}
                </div>
              ) : conversionFunnel ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-4">
                    <div className="text-center p-3 rounded-lg bg-muted/50">
                      <div className="text-2xl font-bold">{conversionFunnel.visitors.toLocaleString()}</div>
                      <p className="text-xs text-muted-foreground">Visitors</p>
                    </div>
                    <div className="text-center p-3 rounded-lg bg-muted/50">
                      <div className="text-2xl font-bold">{conversionFunnel.signups.toLocaleString()}</div>
                      <p className="text-xs text-muted-foreground">Signups ({conversionFunnel.visitor_to_signup_rate}%)</p>
                    </div>
                    <div className="text-center p-3 rounded-lg bg-muted/50">
                      <div className="text-2xl font-bold">{conversionFunnel.subscriptions.toLocaleString()}</div>
                      <p className="text-xs text-muted-foreground">Subs ({conversionFunnel.signup_to_subscription_rate}%)</p>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground text-center">
                    Overall: <span className="font-medium text-foreground">{conversionFunnel.overall_conversion_rate}%</span> conversion
                  </p>
                </div>
              ) : (
                <div className="text-center py-4 text-muted-foreground text-sm">
                  <Eye className="h-5 w-5 mx-auto mb-1 opacity-50" />
                  PostHog not configured
                </div>
              )}
            </div>

            {/* Divider */}
            <div className="border-t" />

            {/* Thread Distribution Section */}
            {distribution && (
              <div>
                <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
                  <MessageSquare className="h-4 w-4" />
                  Thread Distribution
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
            {categoryDistribution && Object.keys(categoryDistribution.distribution).length > 0 && (
              <div className="border-t" />
            )}

            {/* Category Distribution Section */}
            {categoryDistribution && Object.keys(categoryDistribution.distribution).length > 0 && (
              <div>
                <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
                  <Filter className="h-4 w-4" />
                  Category Distribution
                </h3>
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

        {/* Tabs */}
        <Tabs defaultValue="threads" className="space-y-4">
          <TabsList>
            <TabsTrigger value="threads" className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4" />
              All Threads
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

          <TabsContent value="threads">
            <ThreadBrowser
              categoryFilter={categoryFilter}
              filterDate={dateString}
              onClearCategory={() => setCategoryFilter(null)}
            />
          </TabsContent>

          <TabsContent value="retention">
            <RetentionTab />
          </TabsContent>

          <TabsContent value="simulator">
            <ARRSimulator />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

