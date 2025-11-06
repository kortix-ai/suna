'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertCircle,
  TrendingDown,
  ExternalLink,
} from 'lucide-react';
import { useThreadUsage } from '@/hooks/react-query/billing/use-thread-usage';

export default function ThreadUsage() {
  const router = useRouter();
  const [offset, setOffset] = useState(0);
  const [days, setDays] = useState(30);
  const limit = 50;

  const { data, isLoading, error } = useThreadUsage(limit, offset, days);

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatCredits = (credits: number) => {
    return credits.toFixed(1);
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

  const handleOpenThread = (threadId: string, projectId: string | null) => {
    if (projectId) {
      window.open(`/projects/${projectId}/thread/${threadId}`, '_blank');
    }
  };

  if (isLoading && offset === 0) {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Thread Usage</CardTitle>
            <CardDescription>Loading thread usage data...</CardDescription>
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

  return (
    <div className="space-y-6">
      {summary && (
          <Card className='w-full'>
            <CardHeader>
              <CardTitle>Total Usage</CardTitle>
              <CardDescription>Credits consumed across all threads</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <TrendingDown className="h-5 w-5 text-red-500" />
                <div>
                  <div className="text-3xl font-semibold text-red-600">
                    {formatCredits(summary.total_credits_used)}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Last {summary.period_days} days
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
              <CardTitle>Usage</CardTitle>
              <CardDescription className='mt-2'>
                Credit consumption per conversation
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
          {threadRecords.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-muted-foreground">
                No thread usage found in the last {days} days.
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
                    {threadRecords.map((record) => (
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
                        <TableCell className="text-right text-red-600">
                          {formatCredits(record.credits_used)}
                        </TableCell>
                      </TableRow>
                    ))}
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

