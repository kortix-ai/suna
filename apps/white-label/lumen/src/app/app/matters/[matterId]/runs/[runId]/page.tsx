'use client';

import { Notice, useMatter } from '@/components/access';
import { BATCH_ICON, CitationCard, Elapsed, type RunView, RunStatusBadge, isActive } from '@/components/runs/run-parts';
import { errorText } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { cn } from '@kortix/ui';
import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { UnifiedMarkdown } from '@kortix/ui/markdown';
import { Skeleton } from '@kortix/ui/skeleton';
import { errorToast } from '@kortix/ui/toast';
import { ArrowClockwiseIcon, CaretLeftIcon, FileMagnifyingGlassIcon, StopIcon, XIcon } from '@phosphor-icons/react';
import { useMutation, useQuery } from 'convex/react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';

type Cell = RunView['cells'][number];
type Column = RunView['columns'][number];

function display(cell: Cell | undefined, col: Column, full = false): React.ReactNode {
  if (!cell || cell.state === 'pending') return <Skeleton className="h-4 w-24" />;
  if (cell.state === 'error') return <span className="text-xs text-destructive">Not read</span>;
  if (cell.state === 'not_found' || cell.value === null || cell.value === undefined) {
    return <span className="text-xs text-muted-foreground">Not addressed</span>;
  }
  if (col.format === 'yes_no') {
    const yes = cell.value === true || /^yes/i.test(String(cell.value));
    return <Badge variant={yes ? 'highlight' : 'muted'}>{yes ? 'Yes' : 'No'}</Badge>;
  }
  return <span className={full ? '' : 'line-clamp-2'}>{typeof cell.value === 'string' ? cell.value : JSON.stringify(cell.value)}</span>;
}

function ReviewGrid({ view, selected, onSelect }: { view: RunView; selected: string | null; onSelect: (k: string) => void }) {
  const cellOf = new Map(view.cells.map((c) => [`${c.documentId}:${c.columnKey}`, c]));
  return (
    <div className="overflow-auto rounded-xl border border-border bg-card" data-testid="review-grid">
      <table className="w-max min-w-full border-separate border-spacing-0 text-[13px]">
        <thead>
          <tr>
            <th className="sticky left-0 top-0 z-20 w-56 border-b border-r border-border bg-card px-3 py-2 text-left text-xs font-medium text-muted-foreground">
              Document
            </th>
            {view.columns.map((c) => (
              <th key={c.key} className="sticky top-0 z-10 w-48 border-b border-border bg-card px-3 py-2 text-left text-xs font-medium text-muted-foreground" title={c.prompt}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.documents.map((d) => (
            <tr key={d._id}>
              <th className="sticky left-0 z-10 max-w-56 truncate border-b border-r border-border bg-card px-3 py-2 text-left font-medium" scope="row">
                {d.filename}
              </th>
              {view.columns.map((col) => {
                const k = `${d._id}:${col.key}`;
                const cell = cellOf.get(k);
                const unsupported = cell?.state === 'needs_review';
                return (
                  <td key={col.key} className="border-b border-border p-0 align-top">
                    <Button
                      variant="ghost"
                      data-testid="review-cell"
                      data-state={cell?.state}
                      onClick={() => onSelect(k)}
                      className={cn(
                        'flex h-auto min-h-11 w-48 flex-col items-start justify-start gap-1 whitespace-normal rounded-none px-3 py-2 text-left text-[13px] font-normal hover:bg-muted/40',
                        selected === k && 'bg-brand/5 ring-1 ring-inset ring-brand/40',
                      )}
                    >
                      {display(cell, col)}
                      {unsupported && <span className="text-[11px] text-muted-foreground">Citation not found</span>}
                    </Button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CellPanel({ view, k, onClose }: { view: RunView; k: string; onClose: () => void }) {
  const [docId, key] = k.split(':');
  const cell = view.cells.find((c) => c.documentId === docId && c.columnKey === key);
  const col = view.columns.find((c) => c.key === key)!;
  const doc = view.documents.find((d) => d._id === docId);
  return (
    <aside className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" data-testid="cell-panel">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs text-muted-foreground">{doc?.filename}</p>
          <h3 className="text-sm font-medium">{col.label}</h3>
        </div>
        <Button size="icon" variant="ghost" aria-label="Close" onClick={onClose}>
          <XIcon className="size-4" />
        </Button>
      </div>
      <div className="text-sm leading-relaxed">{display(cell, col, true)}</div>
      {cell?.note && <p className="text-xs leading-relaxed text-muted-foreground">{cell.note}</p>}
      {cell?.confidence && <p className="text-xs text-muted-foreground">Confidence: {cell.confidence}</p>}
      <div className="space-y-2">
        {cell?.citations.map((c, i) => <CitationCard key={i} c={c} n={i + 1} />)}
        {cell && cell.citations.length === 0 && cell.state !== 'pending' && (
          <p className="text-xs text-muted-foreground">No citation: the documents do not address this column.</p>
        )}
      </div>
    </aside>
  );
}

function Progress({ view }: { view: RunView }) {
  const filled = view.cells.filter((c) => c.state !== 'pending').length;
  return (
    <aside className="space-y-4 rounded-xl border border-border bg-card p-4" data-testid="run-progress">
      {view.cells.length > 0 && (
        <div>
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-muted-foreground">Cells</span>
            <span className="font-mono tabular-nums" data-testid="cell-counter">{filled} / {view.cells.length}</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-brand transition-all" style={{ width: `${(filled / Math.max(1, view.cells.length)) * 100}%` }} />
          </div>
        </div>
      )}
      <ol className="space-y-2">
        {view.batches.map((b) => {
          const s = BATCH_ICON[b.status];
          return (
            <li key={b._id} className="flex items-start gap-2 text-sm" data-testid="batch-row" data-status={b.status}>
              <s.icon className={cn('mt-0.5 size-4 shrink-0', s.className)} />
              <span className="min-w-0 flex-1">
                <span className="block">
                  Batch {b.index + 1} <span className="text-muted-foreground">· {b.documentCount} document{b.documentCount === 1 ? "" : "s"}</span>
                </span>
                <span className="block text-xs text-muted-foreground">
                  {s.label}
                  {b.startedAt ? <> · <Elapsed from={b.startedAt} to={b.finishedAt} /></> : null}
                  {b.attempts.repair + b.attempts.nudge + b.attempts.relaunch > 0 &&
                    ` · ${b.attempts.repair} repair, ${b.attempts.nudge} nudge, ${b.attempts.relaunch} restart`}
                </span>
                {b.error && <span className="block text-xs text-destructive">{b.error}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      <details className="text-xs" open>
        <summary className="cursor-pointer text-muted-foreground">Activity</summary>
        <ol className="mt-2 max-h-64 space-y-1 overflow-auto" data-testid="run-events">
          {[...view.events].reverse().slice(0, 40).map((e, i) => (
            <li key={i} className="flex gap-2">
              <span className="w-16 shrink-0 font-mono tabular-nums text-muted-foreground">{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
              <span>{e.detail ?? e.type}</span>
            </li>
          ))}
        </ol>
      </details>
    </aside>
  );
}

function AnswerView({ view }: { view: RunView }) {
  if (!view.answer) {
    return (
      <section className="space-y-2 rounded-xl border border-border bg-card p-5">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/5" />
      </section>
    );
  }
  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-5" data-testid="answer">
      {!view.answer.addressed && <Badge variant="muted">Not addressed by the documents</Badge>}
      <div className="max-w-[72ch] text-[15px] leading-relaxed">
        <UnifiedMarkdown content={view.answer.answerMd} trust="agent" />
      </div>
      {view.answer.citations.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">Sources</h3>
          {view.answer.citations.map((c, i) => <CitationCard key={i} c={c} n={i + 1} />)}
        </div>
      )}
    </section>
  );
}

export default function RunPage() {
  const { matter } = useMatter();
  const runId = String(useParams().runId) as Id<'runs'>;
  const view = useQuery(api.runs.get, { runId });
  const cancel = useMutation(api.runs.cancel);
  const retry = useMutation(api.runs.retryFailed);
  const [selected, setSelected] = useState<string | null>(null);
  const base = `/app/matters/${matter._id}`;

  if (view === undefined) return <div className="mx-auto w-full max-w-6xl space-y-3 px-6 py-6">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-9 w-full" />)}</div>;
  if (view === null) return <Notice icon={FileMagnifyingGlassIcon} title="Run not found" body="It may belong to another matter." href={`${base}/runs`} cta="Back to runs" />;
  const { run } = view;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 px-6 py-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`${base}/runs`} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <CaretLeftIcon className="size-3" /> Runs
        </Link>
        <h2 className="min-w-0 flex-1 truncate font-display text-xl tracking-tight" data-testid="run-title">{run.title}</h2>
        <span className="text-xs text-muted-foreground"><Elapsed from={run.startedAt} to={run.finishedAt} /></span>
        <span data-testid="run-status" data-status={run.status}><RunStatusBadge status={run.status} /></span>
        {isActive(run.status) && (
          <Button size="sm" variant="outline" onClick={() => cancel({ runId }).catch((e) => errorToast('Could not cancel', { description: errorText(e) }))}>
            <StopIcon className="size-4" /> Cancel
          </Button>
        )}
        {(run.status === 'partial' || run.status === 'failed') && (
          <Button size="sm" variant="outline" onClick={() => retry({ runId }).catch((e) => errorToast('Could not retry', { description: errorText(e) }))}>
            <ArrowClockwiseIcon className="size-4" /> Retry failed
          </Button>
        )}
      </div>
      {view.question && <p className="text-sm text-muted-foreground">{view.question}</p>}
      {view.error && <p className="text-sm text-destructive">{view.error}</p>}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          {run.kind === 'review' ? <ReviewGrid view={view} selected={selected} onSelect={setSelected} /> : <AnswerView view={view} />}
        </div>
        <div className="space-y-4">
          {selected && run.kind === 'review' && <CellPanel view={view} k={selected} onClose={() => setSelected(null)} />}
          <Progress view={view} />
        </div>
      </div>
    </div>
  );
}
