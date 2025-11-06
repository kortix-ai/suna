'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { format } from 'date-fns';
import type { DateRange } from 'react-day-picker';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { DateRangePicker } from '@/components/ui/date-range-picker';
import {
  AlertCircle,
  TrendingDown,
  ExternalLink,
} from 'lucide-react';
import { useThreadUsage } from '@/hooks/billing/use-thread-usage';
import { formatCredits } from '@/lib/utils/credit-formatter';

export default function ThreadUsage() {
  const router = useRouter();
  const [offset, setOffset] = useState(0);
  const [dateRange, setDateRange] = useState<DateRange>({
    from: new Date(new Date().setDate(new Date().getDate() - 29)),
    to: new Date(),
  });
  const limit = 50;

  const { data, isLoading, error } = useThreadUsage({
    limit,
    offset,
    startDate: dateRange?.from,
    endDate: dateRange?.to,
  });

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const handlePrevPage = () => {
    setOffset(Math.max(0, offset - limit));
  };

  const handleNextPage = () => {
    if (data?.pagination.has_more) {
      setOffset(offset + limit);
    }
  };

  const handleDateRangeUpdate = (values: { range: DateRange }) => {
    setDateRange(values.range);
    setOffset(0);
  };

  const handleOpenThread = (threadId: string, projectId: string | null) => {
    if (projectId) {
      window.open(`/projects/${projectId}/thread/${threadId}`, '_blank');
    }
  };

  // Show skeleton loader on initial load or during pagination
  const showSkeleton = isLoading && offset === 0;
  const showPaginationSkeleton = isLoading && offset > 0;

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Thread Usage</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>
              {error.message || 'Failed to load thread usage'}
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const threadRecords = data?.thread_usage || [];
  const summary = data?.summary;

  if (showSkeleton) {
    return (
      <div className="space-y-6">
        {summary && (
          <Card className='w-full'>
            <CardHeader className='flex items-center justify-between'>
              <div>
                <CardTitle>Total Usage</CardTitle>
                <CardDescription className='mt-2'>
                  {dateRange.from && dateRange.to
                    ? `${format(dateRange.from, "MMM dd, yyyy")} - ${format(dateRange.to, "MMM dd, yyyy")}`
                    : 'Selected period'}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <TrendingDown className="h-5 w-5 text-muted-foreground" />
                <div>
                  <Skeleton className="h-9 w-24 mb-2" />
                  <Skeleton className="h-4 w-32" />
                </div>
              </div>
            </CardHeader>
          </Card>
        )}
        <Card className='p-0 px-0 bg-transparent shadow-none border-none'>
          <CardHeader className='px-0'>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Usage</CardTitle>
                <CardDescription className='mt-2'>
                  Credit consumption per conversation
                </CardDescription>
              </div>
              <Skeleton className="h-10 w-[280px]" />
            </div>
          </CardHeader>
          <CardContent className='px-0'>
            <div className="rounded-xl border overflow-hidden">
              <Table>
                <TableHeader className='bg-muted/50'>
                  <TableRow>
                    <TableHead>Thread</TableHead>
                    <TableHead className="w-[180px]">Last Used</TableHead>
                    <TableHead className="text-right">Credits Used</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...Array(5)].map((_, i) => (
                    <TableRow key={i}>
                      <TableCell>
                        <Skeleton className="h-5 w-48" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-4 w-32" />
                      </TableCell>
                      <TableCell className="text-right">
                        <Skeleton className="h-4 w-20 ml-auto" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {summary && (
          <Card className='w-full'>
            <CardHeader className='flex items-center justify-between'>
              <div>
                <CardTitle>Total Usage</CardTitle>
                <CardDescription className='mt-2'>
                  {dateRange.from && dateRange.to
                    ? `${format(dateRange.from, "MMM dd, yyyy")} - ${format(dateRange.to, "MMM dd, yyyy")}`
                    : 'Selected period'}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <TrendingDown className="h-5 w-5 text-muted-foreground" />
                <div>
                  <div className="text-3xl font-semibold">
                    {formatCredits(summary.total_credits_used)}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Credits consumed
                  </p>
                </div>
              </div>
            </CardHeader>
          </Card>
      )}
      <Card className='p-0 px-0 bg-transparent shadow-none border-none'>
        <CardHeader className='px-0'>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Usage</CardTitle>
              <CardDescription className='mt-2'>
                Credit consumption per conversation
              </CardDescription>
            </div>
            <DateRangePicker
              initialDateFrom={dateRange.from}
              initialDateTo={dateRange.to}
              onUpdate={handleDateRangeUpdate}
              align="end"
            />
          </div>
        </CardHeader>
        <CardContent className='px-0'>
          {threadRecords.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-muted-foreground">
                {dateRange.from && dateRange.to
                  ? `No thread usage found between ${format(dateRange.from, "MMM dd, yyyy")} and ${format(dateRange.to, "MMM dd, yyyy")}.`
                  : 'No thread usage found.'}
              </p>
            </div>
          ) : (
            <>
              <div className="rounded-xl border overflow-hidden">
                <Table>
                  <TableHeader className='bg-muted/50'>
                    <TableRow>
                      <TableHead>Thread</TableHead>
                      <TableHead className="w-[180px]">Last Used</TableHead>
                      <TableHead className="text-right">Credits Used</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {showPaginationSkeleton ? (
                      // Show skeleton rows during pagination
                      [...Array(5)].map((_, i) => (
                        <TableRow key={`skeleton-${i}`}>
                          <TableCell>
                            <Skeleton className="h-5 w-48" />
                          </TableCell>
                          <TableCell>
                            <Skeleton className="h-4 w-32" />
                          </TableCell>
                          <TableCell className="text-right">
                            <Skeleton className="h-4 w-20 ml-auto" />
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      threadRecords.map((record) => (
                        <TableRow 
                          key={record.thread_id}
                          className="cursor-pointer hover:bg-muted/50 transition-colors"
                          onClick={() => handleOpenThread(record.thread_id, record.project_id)}
                        >
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <span className="truncate font-semibold">{record.project_name}</span>
                              <ExternalLink className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                            </div>
                          </TableCell>
                          <TableCell className="text-sm">
                            {formatDate(record.last_used)}
                          </TableCell>
                          <TableCell className="text-right">
                            {formatCredits(record.credits_used)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
              {data?.pagination && (
                <div className="flex items-center justify-between mt-4">
                  <p className="text-sm text-muted-foreground">
                    Showing {offset + 1}-{Math.min(offset + limit, data.pagination.total)} of {data.pagination.total} threads
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handlePrevPage}
                      disabled={offset === 0 || isLoading}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleNextPage}
                      disabled={!data.pagination.has_more || isLoading}
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

