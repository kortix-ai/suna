'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsListCompact, TabsTrigger } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { getUsageRollup } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';
import { Copy, Users } from 'lucide-react';
import { useState } from 'react';
import { useBillingAccountId } from '@/stores/billing-account-context';
import { toEndUserUsageRows } from './end-user-usage';

const WINDOWS = [
  { key: '7', label: '7 days' },
  { key: '30', label: '30 days' },
  { key: '90', label: '90 days' },
] as const;

function startOfWindow(days: number): string {
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return start.toISOString();
}

function formatUsd(value: number): string {
  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 0.01 && value > 0 ? 4 : 2,
  });
}

/**
 * Spend attributed to each end-user of a Kortix-as-a-Backend wrapper.
 *
 * `origin_ref` is the label a backend passes when it starts a session on behalf
 * of one of its own users. Until now it was queryable only over the API, so
 * per-end-user cost was invisible in the dashboard.
 *
 * Renders nothing at all when no session has ever carried an origin_ref — for a
 * normal interactive account this card would otherwise be a permanently empty box.
 */
export function EndUserUsageCard() {
  const [windowKey, setWindowKey] = useState<(typeof WINDOWS)[number]['key']>('30');

  // Scope to the account being VIEWED, not the caller's default. For a browser
  // session the server takes the account from this query param, so omitting it
  // would show your personal spend on a team account's page.
  const accountId = useBillingAccountId();

  const usageQuery = useQuery({
    queryKey: ['usage', 'origin_ref', windowKey, accountId ?? 'default'],
    queryFn: () =>
      getUsageRollup({
        groupBy: 'origin_ref',
        start: startOfWindow(Number(windowKey)),
        accountId,
      }),
    staleTime: 60_000,
  });

  const rows = toEndUserUsageRows(usageQuery.data?.breakdown);

  // Hide entirely rather than show an empty table: only KaaB accounts have
  // origin_ref rows at all, and a permanently blank card reads as broken.
  if (!usageQuery.isLoading && rows.length === 0) return null;

  const copyOriginRef = (originRef: string) => {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard) {
      errorToast('Could not copy — select the id and copy it manually.');
      return;
    }
    clipboard.writeText(originRef).then(
      () => successToast('End-user id copied'),
      () => errorToast('Could not copy — select the id and copy it manually.'),
    );
  };

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          <Users className="size-4 shrink-0" />
          Spend by end-user
        </CardTitle>
        <CardDescription>
          Sessions your backend started on behalf of one of its own users, grouped by the{' '}
          <code className="text-xs">origin_ref</code> it passed.
        </CardDescription>
        <CardAction>
          <Tabs value={windowKey} onValueChange={(v) => setWindowKey(v as typeof windowKey)}>
            <TabsListCompact>
              {WINDOWS.map((w) => (
                <TabsTrigger key={w.key} value={w.key}>
                  {w.label}
                </TabsTrigger>
              ))}
            </TabsListCompact>
          </Tabs>
        </CardAction>
      </CardHeader>
      <CardContent className="px-0">
        {usageQuery.isLoading ? (
          <div className="space-y-2 px-4">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>End-user</TableHead>
                <TableHead className="w-[110px] text-right">Sessions</TableHead>
                <TableHead className="w-[130px] text-right">Share</TableHead>
                <TableHead className="w-[130px] text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.originRef} className="group">
                  <TableCell className="max-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-xs">{row.originRef}</span>
                      <Hint label="Copy end-user id">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                          onClick={() => copyOriginRef(row.originRef)}
                          aria-label={`Copy end-user id ${row.originRef}`}
                        >
                          <Copy className="size-3 shrink-0" />
                        </Button>
                      </Hint>
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.sessions}</TableCell>
                  <TableCell className="text-right">
                    <Badge variant="outline" size="sm" className="tabular-nums">
                      {Math.round(row.share * 100)}%
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatUsd(row.cost)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {usageQuery.isFetching && !usageQuery.isLoading ? (
          <div className="text-muted-foreground flex items-center gap-2 px-4 pt-3 text-xs">
            <Loading className="size-3 shrink-0" />
            Refreshing
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default EndUserUsageCard;
