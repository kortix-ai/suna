'use client';

import { Elapsed, RunStatusBadge } from '@/components/runs/run-parts';
import { relativeTime } from '@/lib/utils';
import type { api } from '@convex/_generated/api';
import { Skeleton } from '@kortix/ui/skeleton';
import { ChatCircleTextIcon, FileMagnifyingGlassIcon, ListChecksIcon, PenNibIcon, TableIcon } from '@phosphor-icons/react';
import type { FunctionReturnType } from 'convex/server';
import Link from 'next/link';

export type HistoryItem = FunctionReturnType<typeof api.workflows.firmHistory>[number];

export const KIND: Record<string, { label: string; icon: typeof TableIcon }> = {
  review: { label: 'Review', icon: TableIcon },
  column: { label: 'Review columns', icon: TableIcon },
  ask: { label: 'Question', icon: ChatCircleTextIcon },
  contract_review: { label: 'Contract review', icon: ListChecksIcon },
  diligence: { label: 'Due diligence', icon: FileMagnifyingGlassIcon },
  draft: { label: 'Draft', icon: PenNibIcon },
  thread: { label: 'Conversation', icon: ChatCircleTextIcon },
};

export function historyHref(i: HistoryItem) {
  const base = `/app/matters/${i.matterId}`;
  if (i.type === 'thread') return `${base}/assistant/${i._id}`;
  if ((i.kind === 'review' || i.kind === 'column') && i.reviewId) return `${base}/reviews/${i.reviewId}`;
  return `${base}/runs/${i._id}`;
}

/** Runs and conversations, newest first. `showMatter` adds the matter name (firm-wide lists). */
export function HistoryList({ items, empty, showMatter, rows = 6 }: {
  items: HistoryItem[] | null | undefined; empty: string; showMatter?: boolean; rows?: number;
}) {
  if (items === undefined) {
    return <div className="space-y-2">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-12 w-full rounded-xl" />)}</div>;
  }
  if (!items || items.length === 0) {
    return <p className="rounded-xl border border-dashed border-border bg-card px-5 py-12 text-center text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      {items.map((i) => {
        const k = KIND[i.kind] ?? KIND.review;
        return (
          <li key={`${i.type}:${i._id}`}>
            <Link href={historyHref(i)} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 sm:px-5" data-testid="history-row" data-kind={i.kind}>
              <k.icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{i.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {k.label}
                  {showMatter && <> · {i.matterName}</>} · {relativeTime(new Date(i.at).toISOString())}
                  {i.startedAt ? <> · <Elapsed from={i.startedAt} to={i.finishedAt} /></> : null}
                </span>
              </span>
              {i.status && <RunStatusBadge status={i.status as never} />}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
