'use client';

import { useMatter } from '@/components/access';
import { RunStatusBadge } from '@/components/runs/run-parts';
import { relativeTime } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import { Button } from '@kortix/ui/button';
import { Skeleton } from '@kortix/ui/skeleton';
import { PlusIcon, TableIcon } from '@phosphor-icons/react';
import { useQuery } from 'convex/react';
import Link from 'next/link';

export default function ReviewsPage() {
  const { matter } = useMatter();
  const reviews = useQuery(api.reviews.listForMatter, { matterId: matter._id });
  const base = `/app/matters/${matter._id}/reviews`;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium">Reviews</h2>
          <p className="text-xs text-muted-foreground">Each row is a document, each column a question. Every answer cites its clause.</p>
        </div>
        <Button size="sm" asChild>
          <Link href={`${base}/new`}>
            <PlusIcon className="size-4" /> New review
          </Link>
        </Button>
      </div>
      {reviews === undefined ? (
        <div className="space-y-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}</div>
      ) : !reviews || reviews.length === 0 ? (
        <div className="flex flex-col items-center rounded-xl border border-dashed border-border bg-card px-6 py-14 text-center">
          <div className="grid size-11 place-items-center rounded-full border border-border bg-background">
            <TableIcon className="size-5 text-muted-foreground" />
          </div>
          <h3 className="mt-3 text-sm font-medium">Turn documents into a table</h3>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Each row is a document, each column a question. Start from the commercial contract preset or write your own columns.
          </p>
          <Button size="sm" className="mt-4" asChild>
            <Link href={`${base}/new`}>
              <PlusIcon className="size-4" /> New review
            </Link>
          </Button>
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {reviews.map((r) => (
            <li key={r._id}>
              <Link href={`${base}/${r._id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-muted/40" data-testid="review-row">
                <TableIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{r.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {r.documentCount} documents × {r.columnCount} columns{r.diligence ? ' · due diligence' : ''} ·{' '}
                    {relativeTime(new Date(r._creationTime).toISOString())}
                  </span>
                </span>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  {r.filled}/{r.cells}
                </span>
                {r.lastRunStatus && <RunStatusBadge status={r.lastRunStatus} />}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
