'use client';

import { useState } from 'react';
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
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  AlertCircle,
  TrendingUp,
  TrendingDown,
  DollarSign,
  Clock,
  Infinity,
  Plus,
  Minus,
  RefreshCw,
  Info,
} from 'lucide-react';
import { useTransactions, useTransactionsSummary, useUsageLogs, useBillingStatus, useSubscriptionInfo } from '@/hooks/react-query/billing/use-transactions';
import { cn } from '@/lib/utils';

interface Props {
  accountId?: string;
}

export default function CreditTransactions({ accountId }: Props) {
  const [offset, setOffset] = useState(0);
  const [typeFilter, setTypeFilter] = useState<string | undefined>(undefined);
  const limit = 50;
  
  const isEnterpriseMode = process.env.NEXT_PUBLIC_ENTERPRISE_MODE === 'true';
  
  // Use appropriate hooks based on mode
  const transactionsQuery = useTransactions(limit, offset, typeFilter);
  const usageLogsQuery = useUsageLogs(Math.floor(offset / limit), limit);
  const billingStatusQuery = useBillingStatus();
  
  // Select the right data source based on enterprise mode
  const { data, isLoading, error, refetch } = isEnterpriseMode ? usageLogsQuery : transactionsQuery;

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatAmount = (amount: number) => {
    const absAmount = Math.abs(amount);
    const formatted = `$${absAmount.toFixed(4)}`;
    return amount >= 0 ? `+${formatted}` : `-${formatted}`;
  };

  const formatBalance = (balance: number) => {
    return `$${balance.toFixed(4)}`;
  };

  const getTransactionIcon = (type: string, amount: number) => {
    if (amount > 0) {
      return <Plus className="h-4 w-4 text-green-500" />;
    }
    if (type === 'usage') {
      return <Minus className="h-4 w-4 text-orange-500" />;
    }
    if (type === 'expired') {
      return <Clock className="h-4 w-4 text-red-500" />;
    }
    return <Minus className="h-4 w-4 text-red-500" />;
  };

  const getTransactionBadge = (type: string) => {
    const badges: Record<string, { label: string; variant: any }> = {
      'tier_grant': { label: 'Tier Grant', variant: 'default' },
      'purchase': { label: 'Purchase', variant: 'default' },
      'admin_grant': { label: 'Admin Grant', variant: 'secondary' },
      'promotional': { label: 'Promotional', variant: 'secondary' },
      'usage': { label: 'Usage', variant: 'outline' },
      'refund': { label: 'Refund', variant: 'secondary' },
      'adjustment': { label: 'Adjustment', variant: 'outline' },
      'expired': { label: 'Expired', variant: 'destructive' },
    };

    const badge = badges[type] || { label: type, variant: 'outline' };
    return <Badge variant={badge.variant as any}>{badge.label}</Badge>;
  };

  const handlePrevPage = () => {
    setOffset(Math.max(0, offset - limit));
  };

  const handleNextPage = () => {
    // Handle different pagination structures for enterprise vs non-enterprise
    const hasMore = isEnterpriseMode 
      ? (data as any)?.has_more 
      : (data as any)?.pagination?.has_more;
    if (hasMore) {
      setOffset(offset + limit);
    }
  };

  const handleTypeFilterChange = (value: string) => {
    setTypeFilter(value === 'all' ? undefined : value);
    setOffset(0); // Reset pagination when filter changes
  };

  if (isLoading && offset === 0) {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Credit Transactions</CardTitle>
            <CardDescription>Loading your transaction history...</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Credit Transactions</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>
              {error.message || 'Failed to load transactions'}
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  // Enterprise vs non-enterprise data handling
  const currentBalance = isEnterpriseMode ? null : (data as any)?.current_balance;
  const transactions = isEnterpriseMode ? [] : (data as any)?.transactions || [];
  const enterpriseUsage = isEnterpriseMode ? data : null; // In enterprise mode, data is the usage logs response
  const billingStatus = billingStatusQuery.data;
  
  // Render enterprise usage in hierarchical format
  const renderEnterpriseUsage = () => {
    const hierarchicalData = (enterpriseUsage as any)?.hierarchical_usage;
    if (!hierarchicalData) {
      return (
        <div className="text-center py-8">
          <p className="text-muted-foreground">No usage data found.</p>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        {Object.entries(hierarchicalData).map(([date, dateData]: [string, any]) => (
          <Card key={date} className="border-l-4 border-l-blue-500">
            <CardHeader className="pb-3">
              <div className="flex justify-between items-center">
                <CardTitle className="text-lg">{new Date(date).toLocaleDateString()}</CardTitle>
                <Badge variant="outline">
                  ${dateData.total_cost?.toFixed(4) || '0.0000'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              {Object.entries(dateData.projects || {}).map(([projectId, projectData]: [string, any]) => (
                <div key={projectId} className="mb-4 p-3 bg-muted/50 rounded-lg">
                  <div className="flex justify-between items-center mb-2">
                    <h4 className="font-medium">Project: {projectData.project_name || projectId}</h4>
                    <span className="text-sm font-mono">${projectData.total_cost?.toFixed(4) || '0.0000'}</span>
                  </div>
                  
                  {Object.entries(projectData.threads || {}).map(([threadId, threadData]: [string, any]) => (
                    <div key={threadId} className="ml-4 mb-3 p-2 bg-background rounded border">
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-sm text-muted-foreground">Thread: {threadId.slice(0, 8)}...</span>
                        <span className="text-sm font-mono">${threadData.total_cost?.toFixed(4) || '0.0000'}</span>
                      </div>
                      
                      {threadData.usage_details?.map((usage: any, index: number) => (
                        <div key={index} className="ml-4 text-xs text-muted-foreground flex justify-between">
                          <span>{usage.model_name} ({usage.tokens_used} tokens)</span>
                          <span>${usage.cost?.toFixed(4) || '0.0000'}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Enterprise Balance Summary Card */}
      {isEnterpriseMode && billingStatus?.enterprise_info && (
        <Card>
          <CardHeader>
            <CardTitle>Enterprise Usage Summary</CardTitle>
            <CardDescription>Your monthly usage limits and current spending</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-3">
              <div>
                <div className="text-2xl font-bold">
                  ${billingStatus.enterprise_info.current_usage?.toFixed(4) || '0.0000'}
                </div>
                <p className="text-xs text-muted-foreground">Current Month Usage</p>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <DollarSign className="h-4 w-4 text-green-500" />
                  <span className="text-lg font-semibold">
                    ${billingStatus.enterprise_info.remaining?.toFixed(4) || '0.0000'}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">Remaining This Month</p>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-blue-500" />
                  <span className="text-lg font-semibold">
                    ${billingStatus.enterprise_info.monthly_limit?.toFixed(4) || '0.0000'}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">Monthly Limit</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Non-Enterprise Balance Summary Card */}
      {!isEnterpriseMode && currentBalance && (
        <Card>
          <CardHeader>
            <CardTitle>Current Balance</CardTitle>
            <CardDescription>Your credit balance breakdown</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-3">
              <div>
                <div className="text-2xl font-bold">
                  {formatBalance(currentBalance.total)}
                </div>
                <p className="text-xs text-muted-foreground">Total Balance</p>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-orange-500" />
                  <span className="text-lg font-semibold">
                    {formatBalance(currentBalance.expiring)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">Expiring Credits</p>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <Infinity className="h-4 w-4 text-blue-500" />
                  <span className="text-lg font-semibold">
                    {formatBalance(currentBalance.non_expiring)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">Non-Expiring Credits</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
      <Card className='p-0 px-0 bg-transparent shadow-none border-none'>
        <CardHeader className='px-0'>
          <CardTitle>{isEnterpriseMode ? 'Usage History' : 'Transaction History'}</CardTitle>
          <CardDescription>
            {isEnterpriseMode 
              ? 'Your usage organized by date, project, and conversation' 
              : 'All credit additions and deductions'
            }
          </CardDescription>
        </CardHeader>
        <CardContent className='px-0'>
          {isEnterpriseMode ? (
            // Enterprise mode: Show hierarchical usage data
            renderEnterpriseUsage()
          ) : (
            // Non-enterprise mode: Show traditional transaction table
            transactions.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-muted-foreground">
                  {typeFilter ? `No ${typeFilter} transactions found.` : 'No transactions found.'}
                </p>
              </div>
            ) : (
            <>
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[180px]">Date</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-center">Credit Type</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="text-right">Balance After</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {transactions.map((tx) => (
                      <TableRow key={tx.id}>
                        <TableCell className="font-mono text-xs">
                          {formatDate(tx.created_at)}
                        </TableCell>
                        <TableCell>
                          {getTransactionBadge(tx.type)}
                        </TableCell>
                        <TableCell className="text-sm">
                          <div className="flex items-center gap-2">
                            {getTransactionIcon(tx.type, tx.amount)}
                            {tx.description || 'No description'}
                          </div>
                        </TableCell>
                        <TableCell className="text-center">
                          {tx.is_expiring !== undefined && (
                            <div className="flex items-center justify-center gap-1">
                              {tx.is_expiring ? (
                                <>
                                  <Clock className="h-3 w-3 text-orange-500" />
                                  <span className="text-xs text-muted-foreground">Expiring</span>
                                </>
                              ) : (
                                <>
                                  <Infinity className="h-3 w-3 text-blue-500" />
                                  <span className="text-xs text-muted-foreground">Permanent</span>
                                </>
                              )}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className={cn(
                          "text-right font-mono font-semibold",
                          tx.amount >= 0 ? "text-green-600" : "text-red-600"
                        )}>
                          {formatAmount(tx.amount)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatBalance(tx.balance_after)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              {((data as any)?.pagination || isEnterpriseMode) && (
                <div className="flex items-center justify-between mt-4">
                  <p className="text-sm text-muted-foreground">
                    {isEnterpriseMode ? (
                      `Showing usage data`
                    ) : (
                      `Showing ${offset + 1}-${Math.min(offset + limit, (data as any)?.pagination?.total || 0)} of ${(data as any)?.pagination?.total || 0} transactions`
                    )}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handlePrevPage}
                      disabled={offset === 0}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleNextPage}
                      disabled={isEnterpriseMode ? !(data as any)?.has_more : !(data as any)?.pagination?.has_more}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
            )
          )}
        </CardContent>
      </Card>
    </div>
  );
} 