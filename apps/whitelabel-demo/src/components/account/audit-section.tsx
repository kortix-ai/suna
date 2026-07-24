'use client';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { kortix } from '@/lib/kortix';
import { relativeTime } from '@/lib/utils';
import { ApiError } from '@kortix/sdk';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Loader2, ScrollText, Search } from 'lucide-react';
import { useState } from 'react';

function shortId(id: string) {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

/**
 * Audit log — `accounts.audit.log(accountId, { action, cursor, limit })`,
 * keyset-paginated via `next_cursor`. Reads are entitlement-gated server-side
 * (Enterprise `auditAccess`), so a 403 renders as a quiet note, not an error.
 */
export function AuditSection({ accountId }: { accountId: string }) {
  const [filterInput, setFilterInput] = useState('');
  const [filter, setFilter] = useState('');

  const audit = useInfiniteQuery({
    queryKey: ['account-audit', accountId, filter],
    queryFn: ({ pageParam }) =>
      kortix.accounts.audit.log(accountId, {
        action: filter || undefined,
        cursor: pageParam ?? undefined,
        limit: 25,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });

  const events = audit.data?.pages.flatMap((p) => p.events) ?? [];
  const gated =
    audit.isError &&
    audit.error instanceof ApiError &&
    (audit.error.status === 402 || audit.error.status === 403);

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">Audit log</h3>

      {/* Action-prefix filter, applied on submit */}
      <Card className="p-4">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter(filterInput.trim());
          }}
        >
          <Input
            value={filterInput}
            onChange={(e) => setFilterInput(e.target.value)}
            placeholder="Filter by action, e.g. iam."
            className="flex-1"
            aria-label="Filter audit events by action prefix"
          />
          <Button type="submit" variant="outline">
            <Search className="size-4" /> Filter
          </Button>
        </form>
      </Card>

      {/* Events — accounts.audit.log */}
      <Card className="divide-y divide-border p-0">
        {audit.isLoading && (
          <div className="space-y-2 p-4">
            <Skeleton className="h-5 w-64" />
            <Skeleton className="h-5 w-52" />
          </div>
        )}
        {gated && (
          <div className="p-6 text-center text-sm text-muted-foreground">
            Audit log requires an Enterprise plan.
          </div>
        )}
        {audit.isError && !gated && (
          <div className="p-6 text-center text-sm text-destructive">
            Couldn&apos;t load the audit log.
          </div>
        )}
        {audit.isSuccess && events.length === 0 && (
          <div className="p-6 text-center text-sm text-muted-foreground">
            {filter ? 'No events match this filter.' : 'No audit events yet.'}
          </div>
        )}
        {events.map((ev) => (
          <div key={ev.event_id} className="flex items-center gap-3 px-4 py-3">
            <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted">
              <ScrollText className="size-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-xs">{ev.action}</div>
              <div className="truncate text-xs text-muted-foreground">
                <span className="font-mono">
                  {ev.actor_user_id ? shortId(ev.actor_user_id) : 'system'}
                </span>
                {ev.resource_type && <span> · {ev.resource_type}</span>}
                {ev.resource_id && <span className="font-mono"> {shortId(ev.resource_id)}</span>}
              </div>
            </div>
            <div className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {relativeTime(ev.occurred_at)}
            </div>
          </div>
        ))}
        {audit.hasNextPage && (
          <div className="p-3 text-center">
            <Button
              variant="ghost"
              size="sm"
              disabled={audit.isFetchingNextPage}
              onClick={() => audit.fetchNextPage()}
            >
              {audit.isFetchingNextPage && <Loader2 className="size-4 animate-spin" />}
              Load more
            </Button>
          </div>
        )}
      </Card>
    </section>
  );
}
