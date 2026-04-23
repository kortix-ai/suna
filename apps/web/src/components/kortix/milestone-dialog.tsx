'use client';

/**
 * Milestone dialog — single modal for create AND edit.
 *
 * Create mode: compact form (title, description, acceptance, due, color).
 *
 * Edit mode: expanded — same form + linked tickets + activity log + close
 * / reopen / delete buttons. Replaces the old right-side drawer because
 * modal-in-place keeps the user in context and fixes the a11y warning
 * (DialogTitle always rendered).
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  useCloseMilestone,
  useCreateMilestone,
  useDeleteMilestone,
  useMilestone,
  useMilestoneEvents,
  useReopenMilestone,
  useUpdateMilestone,
  type Milestone,
} from '@/hooks/kortix/use-milestones';
import { cn } from '@/lib/utils';
import { CheckCircle2, XCircle, RotateCcw, Trash2, Loader2 } from 'lucide-react';

const HUE_OPTIONS = [0, 30, 50, 120, 170, 210, 260, 290, 330];

export function MilestoneDialog({
  projectId,
  open,
  onOpenChange,
  milestone,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  milestone: Milestone | null;
}) {
  const isEdit = milestone !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'p-0 overflow-hidden gap-0 border-border/60 bg-background',
          // Wider in edit mode — needs room for the tickets + activity
          // sections. Create mode stays compact.
          isEdit ? 'sm:max-w-[640px] max-h-[85vh] flex flex-col' : 'sm:max-w-[540px]',
        )}
      >
        {isEdit && milestone
          ? <EditPanel projectId={projectId} milestone={milestone} onClose={() => onOpenChange(false)} />
          : <CreatePanel projectId={projectId} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

// ── Create ──────────────────────────────────────────────────────────────────

function CreatePanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [hue, setHue] = useState<number | null>(null);
  const createM = useCreateMilestone();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) { toast.error('Title is required'); return; }
    try {
      await createM.mutateAsync({
        projectId,
        title: trimmed,
        description_md: description || undefined,
        acceptance_md: acceptance || undefined,
        due_at: dueAt || null,
        color_hue: hue,
      });
      toast.success(`Created milestone "${trimmed}"`);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    }
  };

  return (
    <>
      <DialogHeader className="px-5 py-4 border-b border-border/40">
        <DialogTitle>New milestone</DialogTitle>
        <DialogDescription>
          An outcome-level goal that groups tickets. Keep the acceptance criteria concrete — PM will run it to verify "done".
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={submit} className="p-5 space-y-4">
        <FormFields
          title={title} setTitle={setTitle}
          description={description} setDescription={setDescription}
          acceptance={acceptance} setAcceptance={setAcceptance}
          dueAt={dueAt} setDueAt={setDueAt}
          hue={hue} setHue={setHue}
          autoFocusTitle
        />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={createM.isPending}>Cancel</Button>
          <Button type="submit" disabled={createM.isPending || !title.trim()}>
            {createM.isPending ? 'Saving…' : 'Create milestone'}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

// ── Edit (with tickets + activity) ──────────────────────────────────────────

function EditPanel({
  projectId,
  milestone,
  onClose,
}: {
  projectId: string;
  milestone: Milestone;
  onClose: () => void;
}) {
  // Live re-fetch to keep linked tickets + activity fresh
  const { data: detail } = useMilestone(projectId, String(milestone.number));
  const { data: events } = useMilestoneEvents(projectId, String(milestone.number));
  const updateM = useUpdateMilestone();
  const closeM = useCloseMilestone();
  const reopenM = useReopenMilestone();
  const deleteM = useDeleteMilestone();

  const [title, setTitle] = useState(milestone.title);
  const [description, setDescription] = useState(milestone.description_md);
  const [acceptance, setAcceptance] = useState(milestone.acceptance_md);
  const [dueAt, setDueAt] = useState(milestone.due_at ? milestone.due_at.slice(0, 10) : '');
  const [hue, setHue] = useState<number | null>(milestone.color_hue);
  const [closeSummary, setCloseSummary] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Keep form inputs synced if the cached Milestone prop changes under us
  useEffect(() => {
    setTitle(milestone.title);
    setDescription(milestone.description_md);
    setAcceptance(milestone.acceptance_md);
    setDueAt(milestone.due_at ? milestone.due_at.slice(0, 10) : '');
    setHue(milestone.color_hue);
  }, [milestone]);

  const tickets = detail?.tickets ?? [];
  const isOpen = milestone.status === 'open';
  const anyPending = updateM.isPending || closeM.isPending || reopenM.isPending || deleteM.isPending;

  const saveChanges = async () => {
    try {
      await updateM.mutateAsync({
        projectId, ref: milestone.id,
        patch: {
          title: title.trim(),
          description_md: description,
          acceptance_md: acceptance,
          due_at: dueAt || null,
          color_hue: hue,
        },
      });
      toast.success('Saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    }
  };

  const doClose = (cancelled: boolean) => async () => {
    if (!closeSummary.trim()) { toast.error('Add a summary — record the evidence.'); return; }
    try {
      await closeM.mutateAsync({ projectId, ref: milestone.id, summary_md: closeSummary, cancelled });
      toast.success(cancelled ? `Cancelled M${milestone.number}` : `Closed M${milestone.number}`);
      setCloseSummary('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Close failed');
    }
  };

  const doReopen = async () => {
    try {
      await reopenM.mutateAsync({ projectId, ref: milestone.id });
      toast.success(`Reopened M${milestone.number}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Reopen failed');
    }
  };

  const doDelete = async () => {
    try {
      await deleteM.mutateAsync({ projectId, ref: milestone.id });
      toast.success(`Deleted M${milestone.number}`);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  return (
    <>
      <DialogHeader className="px-5 py-4 border-b border-border/40">
        <div className="flex items-center gap-2 text-[10.5px] uppercase tracking-[0.06em] text-muted-foreground/55 font-semibold">
          <span
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: `hsl(${milestone.color_hue ?? 210} 70% 55%)` }}
          />
          M{milestone.number} · {milestone.status}
        </div>
        <DialogTitle className="text-[16px] font-semibold">
          {milestone.title}
        </DialogTitle>
        <DialogDescription className="text-[11.5px] text-muted-foreground/55">
          {milestone.progress.done}/{milestone.progress.total} tickets done · {milestone.percent_complete}% complete
          {milestone.due_at && isOpen && <> · due {new Date(milestone.due_at).toLocaleDateString()}</>}
        </DialogDescription>
      </DialogHeader>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 text-[13px]">
        <FormFields
          title={title} setTitle={setTitle}
          description={description} setDescription={setDescription}
          acceptance={acceptance} setAcceptance={setAcceptance}
          dueAt={dueAt} setDueAt={setDueAt}
          hue={hue} setHue={setHue}
        />

        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={saveChanges} disabled={anyPending}>
            {updateM.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>

        <Section label={`Linked tickets (${tickets.length})`}>
          {tickets.length === 0
            ? (
              <p className="text-[11.5px] text-muted-foreground/55">
                No tickets yet. TL links sub-tickets during decomposition; you can also set a ticket's milestone from its detail view.
              </p>
            ) : (
              <ul className="rounded-md border border-border/40 divide-y divide-border/30 overflow-hidden">
                {tickets.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[10.5px] text-muted-foreground/50 font-mono shrink-0">#{t.number}</span>
                      <span className="text-[12.5px] truncate">{t.title}</span>
                    </div>
                    <TicketStatusBadge status={t.status} />
                  </li>
                ))}
              </ul>
            )}
        </Section>

        <Section label="Activity">
          {events && events.length > 0
            ? (
              <ul className="space-y-1.5">
                {events.slice(0, 20).map((e) => (
                  <li key={e.id} className="flex items-start gap-2 text-[11.5px] leading-snug">
                    <span className="text-muted-foreground/45 tabular-nums shrink-0 w-[110px]">
                      {new Date(e.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span className={cn(
                      'text-[10px] uppercase tracking-[0.05em] font-semibold px-1 rounded shrink-0',
                      e.actor_type === 'agent' ? 'bg-primary/10 text-primary' : 'bg-muted/40 text-muted-foreground/70',
                    )}>
                      {e.actor_type}
                    </span>
                    <span className="text-foreground/80">
                      {e.type.replace(/_/g, ' ')}{e.message ? ` — ${truncate(e.message, 120)}` : ''}
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
        {isOpen ? (
          <>
            <Textarea
              value={closeSummary}
              onChange={(e) => setCloseSummary(e.target.value)}
              placeholder="Closing summary — evidence the acceptance criteria pass (file:line, test output, curl result)."
              rows={2}
              className="text-[12px] resize-y"
            />
            <div className="flex items-center gap-2 flex-wrap">
              <Button size="sm" onClick={doClose(false)} disabled={anyPending} className="gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5" /> Mark as done
              </Button>
              <Button size="sm" variant="ghost" onClick={doClose(true)} disabled={anyPending} className="gap-1.5">
                <XCircle className="h-3.5 w-3.5" /> Cancel milestone
              </Button>
              <div className="ml-auto">
                <DeleteButton confirm={confirmDelete} pending={deleteM.isPending}
                  onClick={() => confirmDelete ? doDelete() : setConfirmDelete(true)}
                  onCancelConfirm={() => setConfirmDelete(false)}
                />
              </div>
            </div>
          </>
        ) : (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={doReopen} disabled={anyPending} className="gap-1.5">
              <RotateCcw className="h-3.5 w-3.5" /> Reopen
            </Button>
            <div className="ml-auto">
              <DeleteButton confirm={confirmDelete} pending={deleteM.isPending}
                onClick={() => confirmDelete ? doDelete() : setConfirmDelete(true)}
                onCancelConfirm={() => setConfirmDelete(false)}
              />
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ── Shared form fields (used in both create + edit panels) ──────────────────

function FormFields({
  title, setTitle,
  description, setDescription,
  acceptance, setAcceptance,
  dueAt, setDueAt,
  hue, setHue,
  autoFocusTitle,
}: {
  title: string; setTitle: (v: string) => void;
  description: string; setDescription: (v: string) => void;
  acceptance: string; setAcceptance: (v: string) => void;
  dueAt: string; setDueAt: (v: string) => void;
  hue: number | null; setHue: (v: number | null) => void;
  autoFocusTitle?: boolean;
}) {
  return (
    <div className="space-y-4">
      <FieldRow label="Title">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Delivery path e2e"
          autoFocus={autoFocusTitle}
          maxLength={120}
        />
      </FieldRow>

      <FieldRow label="Description">
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="1–3 lines of context — what this outcome covers."
          rows={2}
          className="resize-y"
        />
      </FieldRow>

      <FieldRow label="Acceptance criteria">
        <Textarea
          value={acceptance}
          onChange={(e) => setAcceptance(e.target.value)}
          placeholder="Done when: POST /events → subscriber receives signed hook within 3 attempts."
          rows={3}
          className="resize-y font-mono text-[12px]"
        />
        <p className="text-[10.5px] text-muted-foreground/50 mt-1">
          A concrete check — shell command, curl, test name, manual verification step.
        </p>
      </FieldRow>

      <div className="grid grid-cols-2 gap-4">
        <FieldRow label="Due date (optional)">
          <Input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        </FieldRow>
        <FieldRow label="Color">
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={() => setHue(null)}
              className={cn('h-5 w-5 rounded-full border transition',
                hue === null ? 'border-foreground ring-2 ring-foreground/20' : 'border-border/50 hover:border-border',
              )}
              aria-label="No color"
              title="No color"
            >
              <span className="block h-full w-full rounded-full bg-muted/40" />
            </button>
            {HUE_OPTIONS.map((h) => (
              <button
                key={h}
                type="button"
                onClick={() => setHue(h)}
                className={cn('h-5 w-5 rounded-full border transition',
                  hue === h ? 'border-foreground ring-2 ring-foreground/30' : 'border-border/40 hover:border-foreground/40',
                )}
                style={{ backgroundColor: `hsl(${h} 70% 55%)` }}
                aria-label={`hue ${h}`}
                title={`hue ${h}`}
              />
            ))}
          </div>
        </FieldRow>
      </div>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-[11px] uppercase tracking-[0.06em] font-semibold text-muted-foreground/70">{label}</label>
      {children}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="text-[10px] uppercase tracking-[0.08em] font-semibold text-muted-foreground/55 mb-2">{label}</div>
      {children}
    </section>
  );
}

function DeleteButton({
  confirm, pending, onClick, onCancelConfirm,
}: {
  confirm: boolean; pending: boolean; onClick: () => void; onCancelConfirm: () => void;
}) {
  if (confirm) {
    return (
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="ghost" onClick={onCancelConfirm} disabled={pending}>Cancel</Button>
        <Button size="sm" variant="destructive" onClick={onClick} disabled={pending} className="gap-1.5">
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          Confirm delete
        </Button>
      </div>
    );
  }
  return (
    <Button size="sm" variant="ghost" onClick={onClick} className="gap-1.5 text-muted-foreground/60 hover:text-destructive">
      <Trash2 className="h-3.5 w-3.5" /> Delete
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
      !['done', 'in_progress', 'review', 'blocked', 'backlog'].includes(status) && 'bg-muted/30 text-muted-foreground/60',
    )}>
      {status}
    </span>
  );
}

function truncate(s: string, n: number) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
