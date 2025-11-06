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
  AlertCircle,
  Minus,
  TrendingDown,
} from 'lucide-react';
import { useCreditUsage } from '@/hooks/billing/use-credit-usage';
import { formatCredits } from '@/lib/utils/credit-formatter';

export default function CreditUsage() {
  const [offset, setOffset] = useState(0);
  const [days, setDays] = useState(30);
  const limit = 50;

  const { data, isLoading, error, refetch } = useCreditUsage(limit, offset, days);

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getUsageTypeBadge = (type: string) => {
    const badges: Record<string, { label: string; variant: any }> = {
      'usage': { label: 'Usage', variant: 'outline' },
      'debit': { label: 'Debit', variant: 'outline' },
      'expired': { label: 'Expired', variant: 'destructive' },
      'adjustment': { label: 'Adjustment', variant: 'secondary' },
    };

    const badge = badges[type] || { label: type, variant: 'outline' };
    return <Badge variant={badge.variant as any}>{badge.label}</Badge>;
  };

  const handlePrevPage = () => {
    setOffset(Math.max(0, offset - limit));
  };

  const handleNextPage = () => {
    if (data?.pagination.has_more) {
      setOffset(offset + limit);
    }
  };

  const handleDaysChange = (value: string) => {
    setDays(parseInt(value));
    setOffset(0);
  };

  if (isLoading && offset === 0) {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Credit Usage</CardTitle>
            <CardDescription>Loading your usage history...</CardDescription>
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
          <CardTitle>Credit Usage</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>
              {error.message || 'Failed to load usage history'}
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const usageRecords = data?.usage_records || [];
  const summary = data?.summary;

  return (
    <div className="space-y-6">
      {summary && (
        <Card>
          <CardHeader>
            <CardTitle>Usage Summary</CardTitle>
            <CardDescription>Total credits consumed in the selected period</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <TrendingDown className="h-5 w-5 text-red-500" />
              <div>
                <div className="text-3xl font-semibold text-red-600">
                  {formatCredits(summary.total_credits_used)}
                </div>
                <p className="text-sm text-muted-foreground">
                  Credits used in the last {summary.period_days} days
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className='p-0 px-0 bg-transparent shadow-none border-none'>
        <CardHeader className='px-0'>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Usage History</CardTitle>
              <CardDescription>
                Detailed breakdown of credit consumption
              </CardDescription>
            </div>
            <Select value={days.toString()} onValueChange={handleDaysChange}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Select period" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="60">Last 60 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
                <SelectItem value="180">Last 180 days</SelectItem>
                <SelectItem value="365">Last year</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className='px-0'>
          {usageRecords.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-muted-foreground">
                No usage found in the last {days} days.
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
                      <TableHead className="text-right">Credits Used</TableHead>
                      <TableHead className="text-right">Credits After</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {usageRecords.map((record) => (
                      <TableRow key={record.id}>
                        <TableCell className="font-mono text-xs">
                          {formatDate(record.created_at)}
                        </TableCell>
                        <TableCell>
                          {getUsageTypeBadge(record.type)}
                        </TableCell>
                        <TableCell className="text-sm">
                          <div className="flex items-center gap-2">
                            <Minus className="h-4 w-4 text-red-500" />
                            {record.description || 'No description'}
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono font-semibold text-red-600">
                          {formatCredits(record.credits_used)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatCredits(record.balance_after)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {data?.pagination && (
                <div className="flex items-center justify-between mt-4">
                  <p className="text-sm text-muted-foreground">
                    Showing {offset + 1}-{Math.min(offset + limit, data.pagination.total)} of {data.pagination.total} records
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
                      disabled={!data.pagination.has_more}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

