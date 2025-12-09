'use client';

import { useState, useMemo } from 'react';
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
  useAnalyticsSummary,
  useDailyStats,
  useThreadBrowser,
  useMessageDistribution,
  useCategoryDistribution,
  useRetentionData,
  useTranslate,
  useRefreshAnalytics,
  type ThreadAnalytics,
  type RetentionData,
  type ThreadBrowseParams,
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
  onClearCategory?: () => void;
}

function ThreadBrowser({ categoryFilter, onClearCategory }: ThreadBrowserProps) {
  const [params, setParams] = useState<ThreadBrowseParams>({
    page: 1,
    page_size: 15,
    sort_by: 'created_at',
    sort_order: 'desc',
  });
  const [emailSearch, setEmailSearch] = useState('');
  const [messageFilter, setMessageFilter] = useState<string>('all');
  const [translations, setTranslations] = useState<Record<string, string>>({});
  
  // Include category filter in query params
  const queryParams: ThreadBrowseParams = {
    ...params,
    category: categoryFilter || undefined,
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
  const { data: dailyStats } = useDailyStats(7);
  const { data: distribution } = useMessageDistribution(dateString);
  const { data: categoryDistribution } = useCategoryDistribution(dateString);
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

        {/* Message Distribution */}
        {distribution && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <BarChart3 className="h-5 w-5" />
                Thread Distribution (UTC)
              </CardTitle>
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
            <CardContent>
              <div className="grid grid-cols-3 gap-4">
                <div className="text-center p-4 rounded-lg bg-muted/50">
                  <div className="text-3xl font-bold">
                    {distribution.distribution['1_message']}
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">1 message</p>
                  <p className="text-xs text-muted-foreground">
                    ({distribution.total_threads > 0 ? ((distribution.distribution['1_message'] / distribution.total_threads) * 100).toFixed(1) : '0.0'}%)
                  </p>
                </div>
                <div className="text-center p-4 rounded-lg bg-muted/50">
                  <div className="text-3xl font-bold">
                    {distribution.distribution['2_3_messages']}
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">2-3 messages</p>
                  <p className="text-xs text-muted-foreground">
                    ({distribution.total_threads > 0 ? ((distribution.distribution['2_3_messages'] / distribution.total_threads) * 100).toFixed(1) : '0.0'}%)
                  </p>
                </div>
                <div className="text-center p-4 rounded-lg bg-muted/50">
                  <div className="text-3xl font-bold">
                    {distribution.distribution['5_plus_messages']}
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">5+ messages</p>
                  <p className="text-xs text-muted-foreground">
                    ({distribution.total_threads > 0 ? ((distribution.distribution['5_plus_messages'] / distribution.total_threads) * 100).toFixed(1) : '0.0'}%)
                  </p>
                </div>
              </div>
              <p className="text-sm text-muted-foreground mt-4 text-center">
                Total: <span className="font-semibold text-foreground">{distribution.total_threads}</span> threads on {format(distributionDate, 'MMM d, yyyy')}
              </p>
            </CardContent>
          </Card>
        )}

        {/* Category Distribution */}
        {categoryDistribution && Object.keys(categoryDistribution.distribution).length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Filter className="h-5 w-5" />
                Category Distribution (UTC)
              </CardTitle>
              <CardDescription>
                Project categories for {format(distributionDate, 'MMM d, yyyy')}
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-2">
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
                <p className="text-xs text-muted-foreground mt-3">
                  <button onClick={() => setCategoryFilter(null)} className="text-primary hover:underline">Clear filter</button>
                </p>
              )}
            </CardContent>
          </Card>
        )}

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
          </TabsList>

          <TabsContent value="threads">
            <ThreadBrowser 
              categoryFilter={categoryFilter} 
              onClearCategory={() => setCategoryFilter(null)} 
            />
          </TabsContent>

          <TabsContent value="retention">
            <RetentionTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

