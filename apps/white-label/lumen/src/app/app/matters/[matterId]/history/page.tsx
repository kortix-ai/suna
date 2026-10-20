'use client';

import { useMatter } from '@/components/access';
import { Elapsed, RunStatusBadge } from '@/components/runs/run-parts';
import { relativeTime } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import { Skeleton } from '@kortix/ui/skeleton';
import { ChatCircleTextIcon, FileMagnifyingGlassIcon, ListChecksIcon, PenNibIcon, TableIcon } from '@phosphor-icons/react';
import { useQuery } from 'convex/react';
import Link from 'next/link';

const KIND: Record<string, { label: string; icon: typeof TableIcon }> = {
  review: { label: 'Review', icon: TableIcon },
  column: { label: 'Review columns', icon: TableIcon },
  ask: { label: 'Question', icon: ChatCircleTextIcon },
  contract_review: { label: 'Contract review', icon: ListChecksIcon },
  diligence: { label: 'Due diligence', icon: FileMagnifyingGlassIcon },
  draft: { label: 'Draft', icon: PenNibIcon },
  thread: { label: 'Conversation', icon: ChatCircleTextIcon },
};

export default function HistoryPage() {
  const { matter } = useMatter();
  const items = useQuery(api.workflows.history, { matterId: matter._id });
  const base = `/app/matters/${matter._id}`;
  const href = (i: NonNullable<typeof items>[number]) =>
    i.type === 'thread'
      ? `${base}/assistant/${i._id}`
      : (i.kind === 'review' || i.kind === 'column') && i.reviewId
        ? `${base}/reviews/${i.reviewId}`
        : `${base}/runs/${i._id}`;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-6">
      <div className="mb-4">
        <h2 className="text-sm font-medium">History</h2>
        <p className="text-xs text-muted-foreground">Every run and conversation on this matter, newest first.</p>
      </div>
      {items === undefined ? (
        <div className="space-y-2">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-12 w-full rounded-xl" />)}</div>
      ) : !items || items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-card px-5 py-12 text-center text-sm text-muted-foreground">
          Runs and conversations on this matter appear here.
        </p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {items.map((i) => {
            const k = KIND[i.kind] ?? KIND.review;
            return (
              <li key={`${i.type}:${i._id}`}>
                <Link href={href(i)} className="flex items-center gap-3 px-5 py-3 hover:bg-muted/40" data-testid="history-row" data-kind={i.kind}>
                  <k.icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{i.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {k.label} · {relativeTime(new Date(i.at).toISOString())}
                      {i.startedAt ? <> · <Elapsed from={i.startedAt} to={i.finishedAt} /></> : null}
                    </span>
                  </span>
                  {i.status && <RunStatusBadge status={i.status as never} />}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
