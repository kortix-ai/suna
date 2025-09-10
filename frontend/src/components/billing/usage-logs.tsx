'use client';

import { useState, useEffect } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { ExternalLink, Loader2, AlertCircle } from 'lucide-react';
import Link from 'next/link';
import { OpenInNewWindowIcon } from '@radix-ui/react-icons';
import { useUsageLogs, useAdminUserUsageLogs } from '@/hooks/react-query/subscriptions/use-billing';
import { UsageLogEntry, DailyToolUsage } from '@/lib/api';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';


interface DailyUsage {
  date: string;
  logs: UsageLogEntry[];
  totalTokens: number;
  totalCost: number;
  requestCount: number;
  models: string[];
  toolUsage?: DailyToolUsage;
}

interface Props {
  accountId: string;
  isAdminView?: boolean;
}

export default function UsageLogs({ accountId, isAdminView = false }: Props) {
  const [page, setPage] = useState(0);
  const [allLogs, setAllLogs] = useState<UsageLogEntry[]>([]);
  const [hasMore, setHasMore] = useState(true);
  
  const ITEMS_PER_PAGE = 1000;

  // Call both hooks but enable only the appropriate one
  const adminUsageQuery = useAdminUserUsageLogs(accountId, page, ITEMS_PER_PAGE, 30);
  const regularUsageQuery = useUsageLogs(page, ITEMS_PER_PAGE);

  // Use appropriate query result based on context
  const { data: currentPageData, isLoading, error, refetch } = isAdminView 
    ? adminUsageQuery
    : regularUsageQuery;

  // Check if we have hierarchical data
  const isHierarchical = currentPageData?.is_hierarchical || false;
  const hierarchicalData = currentPageData?.hierarchical_usage || {};

  // Update accumulated logs when new data arrives (for non-hierarchical mode)
  useEffect(() => {
    if (currentPageData && !isHierarchical) {
      if (page === 0) {
        // First page - replace all logs
        setAllLogs(currentPageData.logs || []);
      } else {
        // Subsequent pages - append to existing logs
        setAllLogs(prev => [...prev, ...(currentPageData.logs || [])]);
      }
      setHasMore(currentPageData.has_more || false);
    }
  }, [currentPageData, page, isHierarchical]);

  const loadMore = () => {
    const nextPage = page + 1;
    setPage(nextPage);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  const formatCost = (cost: number | string) => {
    if (typeof cost === 'string' || cost === 0) {
      return typeof cost === 'string' ? cost : '0 credits';
    }
    return `${(cost * 1000).toFixed(0)} credits`;
  };

  const formatTotalCost = (cost: number | string) => {
    if (typeof cost === 'string' || cost === 0) {
      return typeof cost === 'string' ? cost : '$0.0000';
    }
    return `$${cost.toFixed(4)}`;
  };

  const formatCreditAmount = (amount: number) => {
    if (amount === 0) return null;
    return `$${amount.toFixed(4)}`;
  };

  const formatDateOnly = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  const handleThreadClick = (threadId: string, projectId: string) => {
    // Navigate to the thread using the correct project_id
    const threadUrl = `/projects/${projectId}/thread/${threadId}`;
    window.open(threadUrl, '_blank');
  };

  // Render hierarchical usage for enterprise mode
  const renderHierarchicalUsage = () => {
    const dates = Object.keys(hierarchicalData).sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
    
    if (dates.length === 0) {
      return (
        <div className="p-8 text-center text-muted-foreground">
          No usage data found for the selected period.
        </div>
      );
    }

    const formatDateLabel = (dateString: string) => {
      return new Date(dateString).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    };

    const formatTime = (dateString: string) => {
      return new Date(dateString).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    };

    return (
      <div className="space-y-4">
        <Accordion type="multiple" defaultValue={[dates[0]]}>
          {dates.map((date) => {
            const dayData = hierarchicalData[date];
            const projects = Object.values(dayData.projects || {}) as any[];
            
            return (
              <AccordionItem key={date} value={date} className="border rounded-lg">
                <AccordionTrigger className="px-4 py-3 hover:no-underline">
                  <div className="flex justify-between items-center w-full pr-4">
                    <div className="flex flex-col items-start">
                      <span className="text-lg font-semibold">
                        {formatDateLabel(date)}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {projects.length} chat{projects.length !== 1 ? 's' : ''} • {((dayData.total_cost || 0) * 1000).toFixed(0)} credits
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="text-lg font-semibold">
                        {((dayData.total_cost || 0) * 1000).toFixed(0)} credits
                      </span>
                    </div>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="px-4 pb-4">
                  <div className="space-y-3">
                    <Accordion type="multiple">
                      {projects.map((project) => (
                        <AccordionItem 
                          key={`${project.thread_id}`} 
                          value={`${project.thread_id}`}
                          className="border rounded-md"
                        >
                          <AccordionTrigger className="px-3 py-2 hover:no-underline">
                            <div className="flex justify-between items-center w-full pr-4">
                              <div className="flex flex-col items-start">
                                <span className="font-medium text-left">
                                  {project.project_title || 'Untitled Chat'}
                                </span>
                                <span className="text-xs text-muted-foreground text-left">
                                  {project.usage_details?.length || 0} request{(project.usage_details?.length || 0) !== 1 ? 's' : ''}
                                </span>
                              </div>
                              <div className="flex items-center gap-3">
                                <div className="text-right">
                                  <div className="text-sm font-medium">
                                    {((project.thread_cost || 0) * 1000).toFixed(0)} credits
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    ${(project.thread_cost || 0).toFixed(3)} cost
                                  </div>
                                </div>
                                {project.thread_id && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleThreadClick(project.thread_id, project.project_id || 'default');
                                    }}
                                    className="h-8 w-8 p-0"
                                  >
                                    <ExternalLink className="h-4 w-4" />
                                  </Button>
                                )}
                              </div>
                            </div>
                          </AccordionTrigger>
                          <AccordionContent className="px-3 pb-3">
                            <div className="mt-2">
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead className="w-[100px]">Time</TableHead>
                                    <TableHead>Type</TableHead>
                                    <TableHead className="text-right">Prompt</TableHead>
                                    <TableHead className="text-right">Completion</TableHead>
                                    <TableHead className="text-right">Tool</TableHead>
                                    <TableHead className="text-right">Total Cost</TableHead>
                                    <TableHead className="text-right">Credits</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {(project.usage_details || []).map((detail: any, index: number) => (
                                    <TableRow key={detail.id || index}>
                                      <TableCell className="font-mono text-xs">
                                        {formatTime(detail.created_at)}
                                      </TableCell>
                                      <TableCell>
                                        <Badge 
                                          variant={detail.usage_type === 'tool' || !detail.model_name || detail.model_name === 'Unknown' ? 'destructive' : 'default'} 
                                          className="text-xs"
                                        >
                                          {detail.usage_type === 'tool' || !detail.model_name || detail.model_name === 'Unknown' ? 'Tool' : 'Prompt'}
                                        </Badge>
                                      </TableCell>
                                      <TableCell className="text-right font-mono text-xs">
                                        {(detail.prompt_tokens || 0).toLocaleString()}
                                      </TableCell>
                                      <TableCell className="text-right font-mono text-xs">
                                        {(detail.completion_tokens || 0).toLocaleString()}
                                      </TableCell>
                                      <TableCell className="text-right font-mono text-xs">
                                        {(detail.tool_tokens || 0).toLocaleString()}
                                      </TableCell>
                                      <TableCell className="text-right font-mono text-xs">
                                        ${(detail.total_cost || detail.cost || 0).toFixed(4)}
                                      </TableCell>
                                      <TableCell className="text-right font-mono text-xs">
                                        {((detail.cost || 0) * 1000).toFixed(0)} credits
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </div>
                          </AccordionContent>
                        </AccordionItem>
                      ))}
                    </Accordion>
                  </div>
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      </div>
    );
  };

  // Group usage logs by date
  const groupLogsByDate = (logs: UsageLogEntry[], toolUsageDaily?: Record<string, DailyToolUsage>): DailyUsage[] => {
    const grouped = logs.reduce(
      (acc, log) => {
        const date = new Date(log.created_at).toDateString();

        if (!acc[date]) {
          acc[date] = {
            date,
            logs: [],
            totalTokens: 0,
            totalCost: 0,
            requestCount: 0,
            models: [],
          };
        }

        acc[date].logs.push(log);
        acc[date].totalTokens += log.total_tokens;
        acc[date].totalCost +=
          typeof log.estimated_cost === 'number' ? log.estimated_cost : 0;
        acc[date].requestCount += 1;

        if (!acc[date].models.includes(log.content.model)) {
          acc[date].models.push(log.content.model);
        }

        return acc;
      },
      {} as Record<string, DailyUsage>,
    );

    // Add tool usage data to each day
    if (toolUsageDaily) {
      Object.keys(grouped).forEach(dateKey => {
        const isoDateKey = new Date(dateKey).toISOString().split('T')[0];
        if (toolUsageDaily[isoDateKey]) {
          grouped[dateKey].toolUsage = toolUsageDaily[isoDateKey];
        }
      });
    }

    return Object.values(grouped).sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );
  };



  if (isLoading && page === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Usage Logs</CardTitle>
          <CardDescription>Loading your token usage history...</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Usage Logs</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg">
            <p className="text-sm text-destructive">
              Error: {error.message || 'Failed to load usage logs'}
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Handle local development mode message
  if (currentPageData?.message) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Usage Logs</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="p-4 bg-muted/30 border border-border rounded-lg text-center">
            <p className="text-sm text-muted-foreground">
              {currentPageData.message}
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  // For hierarchical display, render directly
  if (isHierarchical) {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Daily Usage Logs</CardTitle>
            <CardDescription>
              <div className='flex justify-between items-center'>
                Your usage organized by day and chat, showing credits and token breakdowns for each request.{" "}
                <Button variant='outline' asChild className='text-sm ml-4'>
                  <Link href="/model-pricing">
                    View Model Pricing <OpenInNewWindowIcon className='w-4 h-4' />
                  </Link>
                </Button>
              </div>
            </CardDescription>
          </CardHeader>
          <CardContent>
            {renderHierarchicalUsage()}
          </CardContent>
        </Card>
      </div>
    );
  }

  // Regular (non-hierarchical) display
  const dailyUsage = groupLogsByDate(allLogs, currentPageData?.tool_usage_daily);
  const totalUsage = allLogs.reduce(
    (sum, log) =>
      sum + (typeof log.estimated_cost === 'number' ? log.estimated_cost : 0),
    0,
  );

  // Get subscription limit from the first page data
  const subscriptionLimit = currentPageData?.subscription_limit || 0;

  return (
    <div className="space-y-6">
      {/* Show credit usage info if user has gone over limit */}
      {subscriptionLimit > 0 && totalUsage > subscriptionLimit && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Credits Being Used</AlertTitle>
          <AlertDescription>
            You've exceeded your monthly subscription limit of ${subscriptionLimit.toFixed(2)}. 
            Additional usage is being deducted from your credit balance.
          </AlertDescription>
        </Alert>
      )}

      {/* Usage Logs Accordion */}
      <Card>
        <CardHeader>
          <CardTitle>Daily Usage Logs</CardTitle>
          <CardDescription>
            <div className='flex justify-between items-center'>
              Your token usage organized by day, sorted by most recent.{" "}
              <Button variant='outline' asChild className='text-sm ml-4'>
                <Link href="/model-pricing">
                  View Model Pricing <OpenInNewWindowIcon className='w-4 h-4' />
                </Link>
              </Button>
            </div>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {dailyUsage.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-muted-foreground">No usage logs found.</p>
            </div>
          ) : (
            <>
              <Accordion type="single" collapsible className="w-full">
                {dailyUsage.map((day) => (
                  <AccordionItem key={day.date} value={day.date}>
                    <AccordionTrigger className="hover:no-underline">
                      <div className="flex justify-between items-center w-full mr-4">
                        <div className="text-left">
                          <div className="font-semibold">
                            {formatDateOnly(day.date)}
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {day.requestCount} request
                            {day.requestCount !== 1 ? 's' : ''} •{' '}
                            {day.models.join(', ')}
                            {day.toolUsage && day.toolUsage.total_calls > 0 && (
                              <> • {day.toolUsage.total_calls} tool call{day.toolUsage.total_calls !== 1 ? 's' : ''}</>
                            )}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-mono font-semibold">
                            {formatTotalCost(day.totalCost)}
                            {day.toolUsage && day.toolUsage.total_cost > 0 && (
                              <span className="text-sm text-blue-600 ml-2">
                                +{formatTotalCost(day.toolUsage.total_cost)} tools
                              </span>
                            )}
                          </div>
                          <div className="text-sm text-muted-foreground font-mono">
                            {day.totalTokens.toLocaleString()} tokens
                          </div>
                        </div>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="rounded-md border mt-4">
                        <Table>
                          <TableHeader>
                            <TableRow className="hover:bg-transparent">
                              <TableHead className="w-[180px] text-xs">Time</TableHead>
                              <TableHead className="text-xs">Model</TableHead>
                              <TableHead className="text-xs text-right">Prompt</TableHead>
                              <TableHead className="text-xs text-right">Completion</TableHead>
                              <TableHead className="text-xs text-right">Total</TableHead>
                              <TableHead className="text-xs text-right">Credits</TableHead>
                              <TableHead className="text-xs text-right">Payment</TableHead>
                              <TableHead className="w-[100px] text-xs text-center">Thread</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {day.logs.map((log, index) => (
                              <TableRow
                                key={`${log.message_id}_${index}`}
                                className="hover:bg-muted/50 group"
                              >
                                <TableCell className="font-mono text-xs text-muted-foreground">
                                  {new Date(log.created_at).toLocaleTimeString()}
                                </TableCell>
                                <TableCell className="text-xs">
                                  <Badge variant="secondary" className="font-mono text-xs">
                                    {log.content.model.replace('openrouter/', '').replace('anthropic/', '')}
                                  </Badge>
                                </TableCell>
                                <TableCell className="text-right font-mono text-xs">
                                  {log.content.usage.prompt_tokens.toLocaleString()}
                                </TableCell>
                                <TableCell className="text-right font-mono text-xs">
                                  {log.content.usage.completion_tokens.toLocaleString()}
                                </TableCell>
                                <TableCell className="text-right font-mono text-xs">
                                  {log.total_tokens.toLocaleString()}
                                </TableCell>
                                <TableCell className="text-right font-mono text-xs">
                                  {formatCost(log.estimated_cost)}
                                </TableCell>
                                <TableCell className="text-right text-xs">
                                  {log.payment_method === 'credits' ? (
                                    <div className="flex items-center justify-end gap-2">
                                      <Badge variant="outline" className="text-xs">
                                        Credits
                                      </Badge>
                                      {log.credit_used && log.credit_used > 0 && (
                                        <span className="text-xs text-muted-foreground">
                                          -{formatCreditAmount(log.credit_used)}
                                        </span>
                                      )}
                                    </div>
                                  ) : (
                                    <Badge variant="secondary" className="text-xs">
                                      Subscription
                                    </Badge>
                                  )}
                                </TableCell>
                                <TableCell className="text-center">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleThreadClick(log.thread_id, log.project_id)}
                                    className="h-6 px-2 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                                  >
                                    <ExternalLink className="h-3 w-3" />
                                  </Button>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                      
                      {/* Tool Usage Section */}
                      {day.toolUsage && day.toolUsage.total_calls > 0 && (
                        <div className="mt-4 p-4 bg-blue-50/50 dark:bg-blue-950/20 rounded-lg border border-blue-200/60 dark:border-blue-800/30">
                          <div className="flex items-center justify-between mb-3">
                            <h4 className="font-medium text-blue-900 dark:text-blue-100 flex items-center gap-2">
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                              </svg>
                              Tool Usage
                            </h4>
                            <div className="text-sm font-mono text-blue-800 dark:text-blue-200">
                              {day.toolUsage.total_calls} calls • {formatTotalCost(day.toolUsage.total_cost)}
                            </div>
                          </div>
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                            {Object.entries(day.toolUsage.tools).map(([toolName, usage]) => (
                              <div key={toolName} className="bg-white/60 dark:bg-gray-800/40 rounded-md p-3 border border-blue-100/80 dark:border-blue-800/20">
                                <div className="font-medium text-sm text-gray-900 dark:text-gray-100 truncate" title={toolName}>
                                  {toolName}
                                </div>
                                <div className="flex justify-between items-center mt-1">
                                  <span className="text-xs text-blue-600 dark:text-blue-400">
                                    {usage.calls} call{usage.calls !== 1 ? 's' : ''}
                                  </span>
                                  <span className="text-xs font-mono text-gray-600 dark:text-gray-400">
                                    {formatTotalCost(usage.cost)}
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>

              {hasMore && (
                <div className="flex justify-center pt-6">
                  <Button
                    onClick={loadMore}
                    disabled={isLoading}
                    variant="outline"
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Loading...
                      </>
                    ) : (
                      'Load More'
                    )}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
