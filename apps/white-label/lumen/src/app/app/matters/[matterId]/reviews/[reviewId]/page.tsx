'use client';

import { Notice, useMatter } from '@/components/access';
import { type ColumnDraft, ColumnBuilder, FORMATS, blankColumn, columnsReady, toColumns } from '@/components/reviews/column-builder';
import { CitationCard, Elapsed, RunStatusBadge, isActive } from '@/components/runs/run-parts';
import { downloadCsv } from '@/lib/csv';
import { type CellFormat, cellText, reviewCsv, reviewSheets, valueText, yesNo } from '@/lib/review-cells';
import { xlsxBytes } from '@/lib/xlsx';
import { promptFor } from '@convex/lib/columns';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kortix/ui/select';
import { errorText } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { cn } from '@kortix/ui';
import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@kortix/ui/dropdown-menu';
import Loading from '@kortix/ui/loading';
import { Modal, ModalBody, ModalContent, ModalHeader, ModalTitle } from '@kortix/ui/modal';
import { Skeleton } from '@kortix/ui/skeleton';
import { Textarea } from '@kortix/ui/textarea';
import { errorToast } from '@kortix/ui/toast';
import {
  ArrowClockwiseIcon, CaretDownIcon, CaretLeftIcon, CheckCircleIcon, DownloadSimpleIcon, FileXlsIcon, FileCsvIcon, FlagIcon, MagicWandIcon,
  PencilSimpleIcon, PlusIcon, StopIcon, TableIcon, TrashIcon, XIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

type View = NonNullable<FunctionReturnType<typeof api.reviews.get>>;
type Cell = View['cells'][number];
type Column = View['columns'][number];

function CellValue({ cell, col, full = false }: { cell: Cell | undefined; col: Column; full?: boolean }) {
  if (!cell || cell.state === 'pending') return <Skeleton className="h-4 w-24" />;
  if (cell.state === 'error') return <span className="text-xs text-destructive">Not read</span>;
  if (cell.state === 'not_found' && !cell.edited) return <span className="text-xs text-muted-foreground">Not addressed</span>;
  if (col.format === 'yes_no' && yesNo(cell.value) !== null) {
    const yes = yesNo(cell.value);
    return <Badge variant={yes ? 'highlight' : 'muted'} className="normal-case">{yes ? 'Yes' : 'No'}</Badge>;
  }
  if (col.format === 'tag' && typeof cell.value === 'string') return <Badge variant="muted">{cell.value}</Badge>;
  // An answer with no value of the column's type (an uncapped liability in a money column): the agent's note says why.
  if (valueText(cell.value, col.format as CellFormat) === '') {
    return <span className={cn('text-muted-foreground', full ? 'whitespace-pre-wrap' : 'line-clamp-3')}>{cell.note || 'No value'}</span>;
  }
  return <span className={full ? 'whitespace-pre-wrap' : 'line-clamp-3'}>{valueText(cell.value, col.format as CellFormat)}</span>;
}

function Marks({ cell }: { cell: Cell | undefined }) {
  if (!cell) return null;
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      {cell.reviewStatus === 'verified' && <CheckCircleIcon className="size-3.5 text-brand" weight="fill" aria-label="Verified" />}
      {cell.reviewStatus === 'flagged' && <FlagIcon className="size-3.5 text-flag" weight="fill" aria-label="Flagged" />}
      {cell.edited && <PencilSimpleIcon className="size-3.5" aria-label="Edited" />}
      {cell.state === 'needs_review' && <span>Citation not found</span>}
      {cell.aiValue !== undefined && cell.aiValue !== null && <span className="text-brand">Newer AI answer</span>}
    </span>
  );
}

function Grid({ view, selected, onSelect, onRerun, onEdit, onDelete, busy }: {
  view: View; selected: string | null; onSelect: (k: string) => void; onRerun: (key: string) => void; busy: boolean;
  onEdit: (key: string) => void; onDelete: (key: string) => void;
}) {
  const at = new Map(view.cells.map((c) => [`${c.documentId}:${c.columnKey}`, c]));
  return (
    <div className="overflow-auto rounded-xl border border-border bg-card" data-testid="review-grid">
      <table className="w-max min-w-full border-separate border-spacing-0 text-[13px]">
        <thead>
          <tr>
            <th className="sticky left-0 top-0 z-20 w-32 border-b border-r border-border bg-card px-3 py-2 text-left text-xs sm:w-56 font-medium text-muted-foreground">
              Document
            </th>
            {view.columns.map((c) => (
              <th key={c.key} className="sticky top-0 z-10 w-44 border-b sm:w-52 border-border bg-card px-1 py-1 text-left text-xs font-medium text-muted-foreground">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
                    title={c.prompt}
                    data-testid="column-header"
                  >
                    <span className="min-w-0 flex-1 truncate">{c.label}</span>
                    <CaretDownIcon className="size-3 shrink-0" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-64">
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">{c.prompt}</p>
                    <DropdownMenuItem disabled={busy} onSelect={() => onEdit(c.key)}>
                      <PencilSimpleIcon className="size-4" /> Edit column
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={busy} onSelect={() => onRerun(c.key)}>
                      <ArrowClockwiseIcon className="size-4" /> Re-run this column
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled={busy || view.columns.length === 1} variant="destructive" onSelect={() => onDelete(c.key)}>
                      <TrashIcon className="size-4" /> Delete column
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.documents.map((d) => (
            <tr key={d._id}>
              <th className="sticky left-0 z-10 max-w-32 truncate border-b border-r border-border bg-card px-3 py-2.5 sm:max-w-56 text-left align-top font-medium" scope="row" title={d.filename}>
                {d.filename}
              </th>
              {view.columns.map((col) => {
                const k = `${d._id}:${col.key}`;
                const cell = at.get(k);
                return (
                  <td key={col.key} className="border-b border-border p-0 align-top">
                    <Button
                      variant="ghost"
                      data-testid="review-cell"
                      data-state={cell?.state}
                      data-review={cell?.reviewStatus}
                      data-col={col.key}
                      onClick={() => onSelect(k)}
                      ref={selected === k ? (el) => el?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) : undefined}
                      className={cn(
                        'relative flex h-auto min-h-11 w-44 sm:w-52 flex-col items-start justify-start gap-1 whitespace-normal rounded-none py-2 pr-6 pl-3 text-left text-[13px] font-normal hover:bg-muted/40',
                        selected === k && 'bg-brand/5 ring-1 ring-inset ring-brand/40',
                        cell?.reviewStatus === 'flagged' && 'bg-flag/5',
                      )}
                    >
                      <CellValue cell={cell} col={col} />
                      <Marks cell={cell} />
                      {cell && cell.state !== 'pending' && cell.confidence && (
                        <span
                          aria-label={`Confidence: ${cell.confidence}`}
                          title={`Confidence: ${cell.confidence}`}
                          className={cn(
                            'absolute top-2 right-2 size-1.5 rounded-full',
                            cell.confidence === 'high' ? 'bg-verified' : cell.confidence === 'medium' ? 'bg-flag' : 'bg-risk',
                          )}
                        />
                      )}
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

function CellPanel({ view, k, onClose, onMove }: { view: View; k: string; onClose: () => void; onMove: (k: string) => void }) {
  const [docId, key] = k.split(':') as [Id<'documents'>, string];
  const cell = view.cells.find((c) => c.documentId === docId && c.columnKey === key);
  const col = view.columns.find((c) => c.key === key)!;
  const doc = view.documents.find((d) => d._id === docId);
  const setCell = useMutation(api.reviews.setCell);
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => setEditing(null), [k]);
  const act = (action: 'verify' | 'flag' | 'clear' | 'edit' | 'revert' | 'accept_ai', value?: string | boolean | null) =>
    setCell({ reviewId: view.review._id, documentId: docId, columnKey: key, action, value }).catch((e) =>
      errorToast('Could not save', { description: errorText(e) }),
    );
  const done = cell && cell.state !== 'pending';
  const startEdit = () => cell && setEditing(cellText(cell, col.format as CellFormat) === 'Not addressed' ? '' : cellText(cell, col.format as CellFormat));

  // The grid's keyboard: arrows move, V verifies, F flags, E edits, Esc closes. Typing in a field is left alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest('input, textarea, [contenteditable="true"], [role="dialog"]')) return;
      const docs = view.documents.map((d) => d._id as string);
      const cols = view.columns.map((c) => c.key);
      const [r, c] = [docs.indexOf(docId), cols.indexOf(key)];
      const go = (rr: number, cc: number) => {
        if (!docs[rr] || !cols[cc]) return;
        e.preventDefault();
        onMove(`${docs[rr]}:${cols[cc]}`);
      };
      const k = e.key.toLowerCase();
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowUp') go(r - 1, c);
      else if (e.key === 'ArrowDown') go(r + 1, c);
      else if (e.key === 'ArrowLeft') go(r, c - 1);
      else if (e.key === 'ArrowRight') go(r, c + 1);
      else if (done && k === 'v') void act(cell.reviewStatus === 'verified' ? 'clear' : 'verify');
      else if (done && k === 'f') void act(cell.reviewStatus === 'flagged' ? 'clear' : 'flag');
      else if (done && k === 'e') {
        e.preventDefault();
        startEdit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <aside className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" data-testid="cell-panel">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs text-muted-foreground">{doc?.filename}</p>
          <h3 className="text-sm font-medium">{col.label}</h3>
          <p className="text-xs text-muted-foreground">{col.prompt}</p>
        </div>
        <Button size="icon" variant="ghost" aria-label="Close" onClick={onClose}>
          <XIcon className="size-4" />
        </Button>
      </div>
      {editing !== null ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act('edit', col.format === 'yes_no' ? (yesNo(editing) ?? editing) : editing).then(() => setEditing(null));
          }}
        >
          <Textarea aria-label="Value" value={editing} onChange={(e) => setEditing(e.target.value)} className="min-h-20 text-sm" autoFocus />
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={!editing.trim()}>Save</Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <div className="text-sm leading-relaxed" data-testid="cell-value">
          <CellValue cell={cell} col={col} full />
        </div>
      )}
      {cell?.edited && <p className="text-xs text-muted-foreground">Edited by a lawyer. Runs never overwrite it.</p>}
      {cell?.aiValue !== undefined && cell.aiValue !== null && (
        <div className="rounded-lg border border-brand/30 bg-brand/5 p-2.5 text-xs">
          <p className="font-medium">A newer AI answer differs</p>
          <p className="mt-1 text-muted-foreground">{valueText(cell.aiValue, col.format as CellFormat)}</p>
          <Button size="sm" variant="outline" className="mt-2 h-7" onClick={() => act('accept_ai')}>Use the newer answer</Button>
        </div>
      )}
      {cell?.note && <p className="text-xs leading-relaxed text-muted-foreground">{cell.note}</p>}
      {done && editing === null && (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant={cell.reviewStatus === 'verified' ? 'default' : 'outline'} className="h-7" onClick={() => act(cell.reviewStatus === 'verified' ? 'clear' : 'verify')}>
            <CheckCircleIcon className="size-4" /> {cell.reviewStatus === 'verified' ? 'Verified' : 'Verify'}
          </Button>
          <Button size="sm" variant={cell.reviewStatus === 'flagged' ? 'default' : 'outline'} className="h-7" onClick={() => act(cell.reviewStatus === 'flagged' ? 'clear' : 'flag')}>
            <FlagIcon className="size-4" /> {cell.reviewStatus === 'flagged' ? 'Flagged' : 'Flag'}
          </Button>
          <Button size="sm" variant="outline" className="h-7" onClick={startEdit}>
            <PencilSimpleIcon className="size-4" /> Edit
          </Button>
          {cell.edited && (
            <Button size="sm" variant="ghost" className="h-7" onClick={() => act('revert')}>Back to the AI answer</Button>
          )}
        </div>
      )}
      {done && editing === null && (
        <p className="hidden font-mono text-[11px] text-muted-foreground md:block" aria-hidden>
          ←↑↓→ move · V verify · F flag · E edit · Esc close
        </p>
      )}
      <div className="space-y-2">
        {cell?.citations.map((c, i) => <CitationCard key={i} c={c} n={i + 1} />)}
        {cell && cell.citations.length === 0 && done && (
          <p className="text-xs text-muted-foreground">No citation: the documents do not address this column.</p>
        )}
      </div>
    </aside>
  );
}

function ColumnEditor({ view, columnKey, onClose }: { view: View; columnKey: string; onClose: () => void }) {
  const edit = useMutation(api.reviews.editColumn);
  const col = view.columns.find((c) => c.key === columnKey)!;
  const [label, setLabel] = useState(col.label);
  const [prompt, setPrompt] = useState(col.prompt);
  const [format, setFormat] = useState<CellFormat>(col.format as CellFormat);
  const [options, setOptions] = useState((col.options ?? []).join(', '));
  const [pending, setPending] = useState(false);
  const rerun = prompt.trim() !== col.prompt || format !== col.format || options.split(',').map((o) => o.trim()).filter(Boolean).join('|') !== (col.options ?? []).join('|');
  const ok = label.trim() && prompt.trim().length >= 3 && (format !== 'tag' || options.split(',').some((o) => o.trim()));
  return (
    <Modal open onOpenChange={(o) => !o && onClose()}>
      <ModalContent className="lg:max-w-xl">
        <ModalHeader>
          <ModalTitle>Edit column</ModalTitle>
        </ModalHeader>
        <ModalBody className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_11rem]">
            <div className="space-y-1.5">
              <Label htmlFor="col-label">Label</Label>
              <Input id="col-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="col-format">Answer format</Label>
              <Select value={format} onValueChange={(f) => setFormat(f as CellFormat)}>
                <SelectTrigger id="col-format" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FORMATS.map((f) => (
                    <SelectItem key={f.value} value={f.value}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="col-prompt">Question</Label>
              <Button type="button" size="sm" variant="ghost" className="h-7 text-muted-foreground" onClick={() => setPrompt(promptFor(label, format))}>
                <MagicWandIcon className="size-4" /> Write it for me
              </Button>
            </div>
            <Textarea id="col-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} className="min-h-20 text-sm" />
          </div>
          {format === 'tag' && (
            <div className="space-y-1.5">
              <Label htmlFor="col-options">Options</Label>
              <Input id="col-options" value={options} onChange={(e) => setOptions(e.target.value)} placeholder="Options, separated by commas" />
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {rerun
              ? `A new question or format runs this column again on ${view.documents.length} documents. Verified and edited cells keep their value.`
              : 'A new label changes nothing else.'}
          </p>
          <Button
            className="w-full"
            disabled={pending || !ok}
            onClick={async () => {
              setPending(true);
              try {
                await edit({
                  reviewId: view.review._id, columnKey, label, prompt, format,
                  ...(format === 'tag' ? { options: options.split(',').map((o) => o.trim()).filter(Boolean) } : {}),
                });
                onClose();
              } catch (e) {
                errorToast('Could not save the column', { description: errorText(e) });
                setPending(false);
              }
            }}
          >
            {pending && <Loading className="size-4" />} {rerun ? 'Save and run the column' : 'Save'}
          </Button>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

function AddColumns({ view, onClose }: { view: View; onClose: () => void }) {
  const add = useMutation(api.reviews.addColumns);
  const taken = new Set(view.columns.map((c) => c.key));
  const [columns, setColumns] = useState<ColumnDraft[]>([blankColumn(taken)]);
  const [pending, setPending] = useState(false);
  // Keys stay unique against the review's existing columns.
  const all = [...view.columns.map((c) => ({ ...c, format: c.format as CellFormat })), ...columns];
  return (
    <Modal open onOpenChange={(o) => !o && onClose()}>
      <ModalContent className="lg:max-w-2xl">
        <ModalHeader>
          <ModalTitle>Add columns</ModalTitle>
        </ModalHeader>
        <ModalBody className="space-y-4">
          <p className="text-sm text-muted-foreground">Only the new columns run, on the {view.documents.length} existing rows. Other cells do not change.</p>
          <ColumnBuilder columns={all} locked={view.columns.length} onChange={(next) => setColumns(next.slice(view.columns.length))} />
          <Button
            className="w-full"
            disabled={pending || !columnsReady(all, view.columns.length)}
            onClick={async () => {
              setPending(true);
              try {
                await add({ reviewId: view.review._id, columns: toColumns(columns) });
                onClose();
              } catch (e) {
                errorToast('Could not add the columns', { description: errorText(e) });
                setPending(false);
              }
            }}
          >
            {pending && <Loading className="size-4" />} Add and run {columns.length} column{columns.length === 1 ? '' : 's'}
          </Button>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

export default function ReviewPage() {
  const { matter } = useMatter();
  const reviewId = String(useParams().reviewId) as Id<'reviews'>;
  const view = useQuery(api.reviews.get, { reviewId });
  const rerun = useMutation(api.reviews.rerunColumn);
  const cancel = useMutation(api.runs.cancel);
  const logExport = useMutation(api.workflows.logExport);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const deleteColumn = useMutation(api.reviews.deleteColumn);
  const base = `/app/matters/${matter._id}`;

  if (view === undefined) return <div className="mx-auto w-full max-w-6xl space-y-3 px-4 py-6 sm:px-6">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-9 w-full" />)}</div>;
  if (view === null) return <Notice icon={TableIcon} title="Review not found" body="It may belong to another matter." href={`${base}/reviews`} cta="Back to reviews" />;

  const live = view.runs.find((r) => isActive(r.status as never));
  const latest = view.runs[0];
  const liveKeys = live?.columnKeys ? new Set(live.columnKeys) : null;
  const scope = view.cells.filter((c) => !liveKeys || liveKeys.has(c.columnKey));
  const filled = scope.filter((c) => c.state !== 'pending').length;
  const verified = view.cells.filter((c) => c.reviewStatus === 'verified').length;
  const flagged = view.cells.filter((c) => c.reviewStatus === 'flagged').length;

  const fileBase = () => view!.review.title.replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '') || 'review';
  async function exportXlsx() {
    const name = `${fileBase()}.xlsx`;
    const bytes = await xlsxBytes(reviewSheets({ ...view!, title: view!.review.title, columns: view!.columns.map((c) => ({ ...c, format: c.format as CellFormat })) }));
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    void logExport({ runId: latest!._id, file: name, title: view!.review.title });
  }

  function exportCsv() {
    const name = `${view!.review.title.replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '') || 'review'}.csv`;
    downloadCsv(name, reviewCsv({ ...view!, columns: view!.columns.map((c) => ({ ...c, format: c.format as CellFormat })) }));
    void logExport({ runId: latest!._id, file: name, title: view!.review.title });
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`${base}/reviews`} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <CaretLeftIcon className="size-3" /> Reviews
        </Link>
        <h2 className="min-w-0 flex-1 truncate font-display text-xl tracking-tight" data-testid="review-title">{view.review.title}</h2>
        <span className="text-xs text-muted-foreground">
          {view.documents.length} documents × {view.columns.length} columns · {verified} verified · {flagged} flagged
        </span>
        <Button size="sm" variant="outline" disabled={!!live} onClick={() => setAdding(true)}>
          <PlusIcon className="size-4" /> Add column
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" disabled={!latest} data-testid="export">
              <DownloadSimpleIcon className="size-4" /> Export <CaretDownIcon className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={() => void exportXlsx()} data-testid="export-xlsx">
              <FileXlsIcon className="size-4" /> Excel (.xlsx)
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={exportCsv} data-testid="export-csv">
              <FileCsvIcon className="size-4" /> CSV
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {live && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-2.5" data-testid="run-progress">
          <Loading className="size-4 text-brand" />
          <span className="text-sm">{live.columnKeys ? `Filling ${live.columnKeys.length} column${live.columnKeys.length === 1 ? '' : 's'}` : 'Reading the documents'}</span>
          <div className="h-1.5 min-w-32 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-brand transition-all" style={{ width: `${(filled / Math.max(1, scope.length)) * 100}%` }} />
          </div>
          <span className="font-mono text-xs tabular-nums" data-testid="cell-counter">{filled} / {scope.length} cells</span>
          <span className="text-xs text-muted-foreground"><Elapsed from={live.startedAt} to={live.finishedAt} /></span>
          <Link href={`${base}/runs/${live._id}`} className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Run details</Link>
          <Button size="sm" variant="ghost" className="h-7" onClick={() => cancel({ runId: live._id }).catch((e) => errorToast('Could not cancel', { description: errorText(e) }))}>
            <StopIcon className="size-4" /> Cancel
          </Button>
        </div>
      )}
      {!live && latest && latest.status !== 'succeeded' && (
        <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-2.5 text-sm">
          <RunStatusBadge status={latest.status as never} />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{latest.title}</span>
          <Link href={`${base}/runs/${latest._id}`} className="text-xs underline-offset-2 hover:underline">Run details</Link>
        </div>
      )}

      <div className={cn('grid gap-4', selected && 'xl:grid-cols-[minmax(0,1fr)_24rem]')}>
        <div className="min-w-0">
          <Grid
            view={view}
            selected={selected}
            onSelect={setSelected}
            busy={!!live}
            onRerun={(key) => rerun({ reviewId, columnKey: key }).catch((e) => errorToast('Could not re-run the column', { description: errorText(e) }))}
            onEdit={setEditing}
            onDelete={setDeleting}
          />
        </div>
        {selected && <CellPanel view={view} k={selected} onClose={() => setSelected(null)} onMove={setSelected} />}
      </div>
      {adding && <AddColumns view={view} onClose={() => setAdding(false)} />}
      {editing && <ColumnEditor view={view} columnKey={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this column?"
        description={`Every cell in "${view.columns.find((c) => c.key === deleting)?.label ?? ''}" goes, verified and edited ones included. The audit log keeps the record.`}
        confirmLabel="Delete column"
        confirmVariant="destructive"
        onConfirm={async () => {
          const key = deleting!;
          setDeleting(null);
          if (selected?.endsWith(`:${key}`)) setSelected(null);
          await deleteColumn({ reviewId, columnKey: key }).catch((e) => errorToast('Could not delete the column', { description: errorText(e) }));
        }}
      />
    </div>
  );
}
