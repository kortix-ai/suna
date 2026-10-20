'use client';

import type { api } from '@convex/_generated/api';
import { cn } from '@kortix/ui';
import { Badge } from '@kortix/ui/badge';
import Loading from '@kortix/ui/loading';
import { CheckCircleIcon, CircleDashedIcon, QuestionIcon, WarningCircleIcon, XCircleIcon } from '@phosphor-icons/react';
import type { FunctionReturnType } from 'convex/server';
import { useEffect, useState } from 'react';

export type RunView = NonNullable<FunctionReturnType<typeof api.runs.get>>;
export type RunStatus = RunView['run']['status'];
export type CitationView = RunView['cells'][number]['citations'][number];

export const RUN_STATUS: Record<RunStatus, { label: string; variant: 'highlight' | 'success' | 'warning' | 'destructive' | 'muted' }> = {
  queued: { label: 'Queued', variant: 'muted' },
  preparing: { label: 'Preparing', variant: 'highlight' },
  running: { label: 'Running', variant: 'highlight' },
  finalizing: { label: 'Finishing', variant: 'highlight' },
  succeeded: { label: 'Succeeded', variant: 'success' },
  partial: { label: 'Partly done', variant: 'warning' },
  failed: { label: 'Failed', variant: 'destructive' },
  canceled: { label: 'Canceled', variant: 'muted' },
};

export const isActive = (s: RunStatus) => s === 'queued' || s === 'preparing' || s === 'running' || s === 'finalizing';

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const s = RUN_STATUS[status];
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

/** "4m 12s", ticking while the run is live. */
export function Elapsed({ from, to }: { from?: number; to?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!from || to) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [from, to]);
  if (!from) return null;
  const s = Math.max(0, Math.round(((to ?? now) - from) / 1000));
  return <span className="font-mono tabular-nums">{s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`}</span>;
}

const CITATION_STATUS = {
  verified: { label: 'Verified', icon: CheckCircleIcon, className: 'text-brand' },
  relocated: { label: 'Verified, anchor corrected', icon: CheckCircleIcon, className: 'text-brand' },
  unverified: { label: 'Not found in source', icon: QuestionIcon, className: 'text-muted-foreground' },
} as const;

/** The paragraph with the quoted words marked. A quote the source does not contain is shown apart, never as a fact. */
function Highlighted({ text, quote }: { text: string; quote: string }) {
  const at = text.indexOf(quote);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-brand/15 px-0.5 text-foreground">{text.slice(at, at + quote.length)}</mark>
      {text.slice(at + quote.length)}
    </>
  );
}

export function CitationCard({ c, n }: { c: Pick<CitationView, 'filename' | 'page' | 'status' | 'quote' | 'text'>; n: number }) {
  const s = CITATION_STATUS[c.status];
  return (
    <figure className="rounded-lg border border-border bg-background p-3" data-testid="citation">
      <figcaption className="mb-1.5 flex items-center gap-2 text-xs">
        <span className="grid size-5 place-items-center rounded-full bg-muted font-mono text-[11px]">{n}</span>
        <span className="min-w-0 truncate font-medium">{c.filename}</span>
        <span className="shrink-0 whitespace-nowrap font-mono text-muted-foreground">p. {c.page}</span>
        <span className={cn('ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap', s.className)} data-status={c.status}>
          <s.icon className="size-3.5" weight="fill" /> {s.label}
        </span>
      </figcaption>
      {c.status === 'unverified' ? (
        <blockquote className="border-l-2 border-border pl-3 text-sm italic text-muted-foreground">“{c.quote}”</blockquote>
      ) : (
        <p className="text-sm leading-relaxed">
          <Highlighted text={c.text} quote={c.quote} />
        </p>
      )}
    </figure>
  );
}

export const BATCH_ICON = {
  pending: { icon: CircleDashedIcon, className: 'text-muted-foreground', label: 'Queued' },
  starting: { icon: Loading, className: 'text-brand', label: 'Starting a secure workspace' },
  working: { icon: Loading, className: 'text-brand', label: 'Working' },
  validating: { icon: Loading, className: 'text-brand', label: 'Checking citations' },
  succeeded: { icon: CheckCircleIcon, className: 'text-brand', label: 'Done' },
  failed: { icon: XCircleIcon, className: 'text-destructive', label: 'Failed' },
  canceled: { icon: WarningCircleIcon, className: 'text-muted-foreground', label: 'Canceled' },
} as const;
