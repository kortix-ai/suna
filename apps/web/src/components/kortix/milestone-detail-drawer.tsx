'use client';

/**
 * Milestone detail drawer — right-side sheet with inline edits, linked
 * tickets, activity log, close/reopen controls.
 *
 * Opens when the user clicks a row on the Milestones tab. Stays open until
 * dismissed; we fetch with polling so live status changes from agents land
 * without refresh.
 *
 * Inline edits: title / description / acceptance are click-to-edit (like
 * Linear). Clicking the field swaps in a Textarea, autosaves on blur OR
 * Enter (for title). No modal form — fast, everything stays in context.
 */

import { Fragment, useEffect, useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import {
  useMilestone,
  useMilestoneEvents,
  useUpdateMilestone,
  useCloseMilestone,
  useReopenMilestone,
  useDeleteMilestone,
} from '@/hooks/kortix/use-milestones';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { CheckCircle2, XCircle, RotateCcw, Trash2, Loader2 } from 'lucide-react';

export function MilestoneDetailDrawer({
  projectId,
  milestoneRef,
  onOpenChange,
}: {
  projectId: string;
  milestoneRef: string | null;
  onOpenChange: (o: boolean) => void;
}) {
  const open = milestoneRef !== null;
  const { data: m, isLoading } = useMilestone(projectId, milestoneRef ?? undefined);
  const { data: events } = useMilestoneEvents(projectId, milestoneRef ?? undefined);
  const updateM = useUpdateMilestone();
  const closeM = useCloseMilestone();
  const reopenM = useReopenMilestone();
  const deleteM = useDeleteMilestone();

  const [closeSummary, setCloseSummary] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) {
      setCloseSummary('');
      setConfirmDelete(false);
    }
  }, [open]);

  const onClose = (cancelled: boolean) => async () => {
    if (!m) return;
    if (!closeSummary.trim()) {
      toast.error('Add a summary before closing — record the evidence.');
      return;
    }
    try {
      await closeM.mutateAsync({
        projectId,
        ref: m.id,
        summary_md: closeSummary,
        cancelled,
      });
      toast.success(cancelled ? `Cancelled M${m.number}` : `Closed M${m.number}`);
      setCloseSummary('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Close failed');
    }
  };

  const onReopen = async () => {
    if (!m) return;
    try {
      await reopenM.mutateAsync({ projectId, ref: m.id });
      toast.success(`Reopened M${m.number}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Reopen failed');
    }
  };

  const onDelete = async () => {
    if (!m) return;
    try {
      await deleteM.mutateAsync({ projectId, ref: m.id });
      toast.success(`Deleted M${m.number}`);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl flex flex-col gap-0 p-0">
        {isLoading && (
          <div className="flex-1 flex items-center justify-center text-muted-foreground/60">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        )}
        {!isLoading && !m && (
          <div className="flex-1 flex items-center justify-center text-muted-foreground/60 text-[13px]">
            Milestone not found.
          </div>
        )}
        {m && (
          <>
            <SheetHeader className="px-5 py-4 border-b border-border/40 gap-1">
              <div className="flex items-center gap-2 text-[10.5px] uppercase tracking-[0.06em] text-muted-foreground/55 font-semibold">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: `hsl(${m.color_hue ?? 210} 70% 55%)` }}
                />
                Milestone · M{m.number} · {m.status}
              </div>
              <SheetTitle>
                <EditableTitle
                  initial={m.title}
                  onSave={async (v) => {
                    if (v.trim() === m.title) return;
                    try {
                      await updateM.mutateAsync({ projectId, ref: m.id, patch: { title: v.trim() } });
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : 'Update failed');
                    }
                  }}
                />
              </SheetTitle>
              <SheetDescription className="text-[11.5px] text-muted-foreground/55">
                {m.progress.done}/{m.progress.total} tickets done · {m.percent_complete}% complete
                {m.due_at && <> · due {new Date(m.due_at).toLocaleDateString()}</>}
              </SheetDescription>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 text-[13px]">
              <Section label="Description">
                <EditableMarkdown
                  initial={m.description_md}
                  placeholder="Add a description — 1–3 lines of context."
                  rows={2}
                  onSave={async (v) => {
                    try {
                      await updateM.mutateAsync({ projectId, ref: m.id, patch: { description_md: v } });
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : 'Update failed');
                    }
                  }}
                />
              </Section>

              <Section label="Acceptance criteria">
                <EditableMarkdown
                  initial={m.acceptance_md}
                  placeholder={'Done when: <concrete check — curl, bun test, visual>'}
                  rows={3}
                  mono
                  onSave={async (v) => {
                    try {
                      await updateM.mutateAsync({ projectId, ref: m.id, patch: { acceptance_md: v } });
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : 'Update failed');
                    }
                  }}
                />
              </Section>

              <Section label={`Linked tickets (${m.tickets.length})`}>
                {m.tickets.length === 0 ? (
                  <p className="text-[11.5px] text-muted-foreground/55">
                    No tickets yet. TL links tickets during decomposition; you can also set a ticket's milestone from its detail view.
                  </p>
                ) : (
                  <ul className="rounded-lg border border-border/40 divide-y divide-border/30 overflow-hidden">
                    {m.tickets.map((t) => (
                      <li
                        key={t.id}
                        className="flex items-center justify-between gap-3 px-3 py-2 text-left"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-[11px] text-muted-foreground/50 font-mono shrink-0">#{t.number}</span>
                          <span className="text-[12.5px] truncate">{t.title}</span>
                        </div>
                        <TicketStatusBadge status={t.status} />
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section label="Activity">
                {events && events.length > 0 ? (
                  <ul className="space-y-1.5">
                    {events.map((e) => (
                      <li key={e.id} className="flex items-start gap-2 text-[11.5px] leading-snug">
                        <span className="text-muted-foreground/45 tabular-nums shrink-0 w-[110px]">
                          {new Date(e.created_at).toLocaleString(undefined, {
                            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                          })}
                        </span>
                        <span className={cn(
                          'text-[10px] uppercase tracking-[0.05em] font-semibold px-1 rounded shrink-0',
                          e.actor_type === 'agent' ? 'bg-primary/10 text-primary' : 'bg-muted/40 text-muted-foreground/70',
                        )}>
                          {e.actor_type}
                        </span>
                        <span className="text-foreground/80">
                          {e.type.replace(/_/g, ' ')}{e.message ? ` — ${truncate(e.message, 100)}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[11.5px] text-muted-foreground/55">No activity yet.</p>
                )}
              </Section>
            </div>

            {/* Action footer */}
            <div className="px-5 py-3 border-t border-border/40 bg-muted/10 space-y-3">
              {m.status === 'open' ? (
                <>
                  <Textarea
                    value={closeSummary}
                    onChange={(e) => setCloseSummary(e.target.value)}
                    placeholder="Closing summary — evidence that the acceptance criteria pass (file:line, test output, curl result)."
                    rows={2}
                    className="text-[12px] resize-y"
                  />
                  <div className="flex items-center gap-2">
                    <Button size="sm" onClick={onClose(false)} disabled={closeM.isPending} className="gap-1.5">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Mark as done
                    </Button>
                    <Button size="sm" variant="ghost" onClick={onClose(true)} disabled={closeM.isPending} className="gap-1.5">
                      <XCircle className="h-3.5 w-3.5" />
                      Cancel milestone
                    </Button>
                    <div className="ml-auto">
                      <DeleteButton
                        confirm={confirmDelete}
                        pending={deleteM.isPending}
                        onClick={() => confirmDelete ? onDelete() : setConfirmDelete(true)}
                        onCancelConfirm={() => setConfirmDelete(false)}
                      />
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={onReopen} disabled={reopenM.isPending} className="gap-1.5">
                    <RotateCcw className="h-3.5 w-3.5" />
                    Reopen
                  </Button>
                  <div className="ml-auto">
                    <DeleteButton
                      confirm={confirmDelete}
                      pending={deleteM.isPending}
                      onClick={() => confirmDelete ? onDelete() : setConfirmDelete(true)}
                      onCancelConfirm={() => setConfirmDelete(false)}
                    />
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="text-[10px] uppercase tracking-[0.08em] font-semibold text-muted-foreground/55 mb-1.5">{label}</div>
      {children}
    </section>
  );
}

function EditableTitle({ initial, onSave }: { initial: string; onSave: (v: string) => Promise<void> }) {
  const [value, setValue] = useState(initial);
  const [editing, setEditing] = useState(false);
  useEffect(() => { setValue(initial); }, [initial]);

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="text-left text-[17px] font-semibold hover:text-foreground/80 transition-colors"
      >
        {initial}
      </button>
    );
  }
  return (
    <Input
      value={value}
      autoFocus
      onChange={(e) => setValue(e.target.value)}
      onBlur={async () => { setEditing(false); await onSave(value); }}
      onKeyDown={async (e) => {
        if (e.key === 'Enter') { e.preventDefault(); setEditing(false); await onSave(value); }
        if (e.key === 'Escape') { setValue(initial); setEditing(false); }
      }}
      className="text-[17px] font-semibold h-auto py-1"
    />
  );
}

function EditableMarkdown({
  initial,
  placeholder,
  rows,
  mono,
  onSave,
}: {
  initial: string;
  placeholder: string;
  rows: number;
  mono?: boolean;
  onSave: (v: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [editing, setEditing] = useState(false);
  useEffect(() => { setValue(initial); }, [initial]);

  if (!editing) {
    const hasValue = initial.trim().length > 0;
    return (
      <button
        onClick={() => setEditing(true)}
        className={cn(
          'w-full text-left text-[12.5px] leading-relaxed whitespace-pre-wrap break-words rounded-md py-1.5 px-2 hover:bg-muted/15 transition-colors',
          mono && 'font-mono text-[12px]',
          !hasValue && 'text-muted-foreground/40 italic',
        )}
      >
        {hasValue ? initial : placeholder}
      </button>
    );
  }
  return (
    <Textarea
      value={value}
      autoFocus
      onChange={(e) => setValue(e.target.value)}
      onBlur={async () => { setEditing(false); await onSave(value); }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { setValue(initial); setEditing(false); }
      }}
      rows={rows}
      className={cn('resize-y text-[12.5px]', mono && 'font-mono text-[12px]')}
      placeholder={placeholder}
    />
  );
}

function DeleteButton({
  confirm,
  pending,
  onClick,
  onCancelConfirm,
}: {
  confirm: boolean;
  pending: boolean;
  onClick: () => void;
  onCancelConfirm: () => void;
}) {
  if (confirm) {
    return (
      <Fragment>
        <Button size="sm" variant="ghost" onClick={onCancelConfirm} disabled={pending}>Cancel</Button>
        <Button size="sm" variant="destructive" onClick={onClick} disabled={pending} className="gap-1.5">
          <Trash2 className="h-3.5 w-3.5" />
          Confirm delete
        </Button>
      </Fragment>
    );
  }
  return (
    <Button size="sm" variant="ghost" onClick={onClick} className="gap-1.5 text-muted-foreground/60 hover:text-destructive">
      <Trash2 className="h-3.5 w-3.5" />
      Delete
    </Button>
  );
}

function TicketStatusBadge({ status }: { status: string }) {
  return (
    <span className={cn(
      'inline-flex items-center h-4 px-1.5 rounded text-[9.5px] font-mono uppercase tracking-[0.04em] shrink-0',
      status === 'done' && 'bg-emerald-500/10 text-emerald-500/90',
      status === 'in_progress' && 'bg-blue-500/10 text-blue-500/90',
      status === 'review' && 'bg-purple-500/10 text-purple-500/90',
      status === 'blocked' && 'bg-amber-500/10 text-amber-500/90',
      status === 'backlog' && 'bg-muted/40 text-muted-foreground/70',
      !['done','in_progress','review','blocked','backlog'].includes(status) && 'bg-muted/30 text-muted-foreground/60',
    )}>
      {status}
    </span>
  );
}

function truncate(s: string, n: number) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
