'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Calendar } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
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
import {
  CheckCircle2,
  XCircle,
  RotateCcw,
  Trash2,
  Loader2,
  Sparkles,
  Calendar as CalendarIcon,
  Palette,
  X,
  Check,
  ChevronDown,
} from 'lucide-react';

const HUE_OPTIONS = [
  { hue: 0, name: 'Rose' },
  { hue: 30, name: 'Orange' },
  { hue: 50, name: 'Amber' },
  { hue: 120, name: 'Emerald' },
  { hue: 170, name: 'Teal' },
  { hue: 210, name: 'Sky' },
  { hue: 260, name: 'Indigo' },
  { hue: 290, name: 'Violet' },
  { hue: 330, name: 'Pink' },
];

const PILL_TRIGGER = cn(
  'group inline-flex items-center gap-1.5 rounded-full bg-muted/40 px-2.5 py-1 text-xs',
  'text-foreground transition-colors hover:bg-muted',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30',
);

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
          isEdit ? 'sm:max-w-[640px] max-h-[88vh] flex flex-col' : 'sm:max-w-[560px]',
        )}
      >
        <DialogTitle className="sr-only">
          {isEdit ? `Milestone M${milestone.number}` : 'New milestone'}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {isEdit ? 'Edit milestone details, linked tickets, and activity.' : 'Create a new outcome-level goal.'}
        </DialogDescription>
        {isEdit && milestone
          ? <EditPanel projectId={projectId} milestone={milestone} onClose={() => onOpenChange(false)} />
          : <CreatePanel projectId={projectId} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function CreatePanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [dueAt, setDueAt] = useState<Date | undefined>(undefined);
  const [hue, setHue] = useState<number | null>(null);
  const createM = useCreateMilestone();
  const titleRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed) { toast.error('Title is required'); return; }
    try {
      await createM.mutateAsync({
        projectId,
        title: trimmed,
        description_md: description || undefined,
        acceptance_md: acceptance || undefined,
        due_at: dueAt ? dueAt.toISOString().slice(0, 10) : null,
        color_hue: hue,
      });
      toast.success(`Created milestone "${trimmed}"`);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    }
  };

  const onTitleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };
  const onBodyKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="relative flex flex-col">
      <div className="flex items-center gap-2 px-5 pt-4">
        <Sparkles className="size-3.5 text-muted-foreground/50" />
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          New milestone
        </span>
      </div>

      <div className="px-5 pt-3">
        <textarea
          ref={titleRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={onTitleKey}
          placeholder="What outcome are you tracking?"
          rows={1}
          maxLength={120}
          className="w-full resize-none overflow-hidden border-0 bg-transparent text-lg font-semibold leading-tight tracking-tight outline-none placeholder:text-muted-foreground/30 focus:ring-0"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={onBodyKey}
          placeholder="One line on what this covers (optional)"
          rows={1}
          className="mt-0.5 w-full resize-none overflow-hidden border-0 bg-transparent text-sm leading-snug outline-none placeholder:text-muted-foreground/40 focus:ring-0"
        />
      </div>

      <div className="px-5 pt-3">
        <AcceptanceField
          value={acceptance}
          onChange={setAcceptance}
          onKeyDown={onBodyKey}
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-5 pb-4 pt-3">
        <DuePill value={dueAt} onChange={setDueAt} />
        <ColorPill hue={hue} setHue={setHue} />
      </div>

      <div className="flex items-center gap-2 border-t border-border/40 px-5 py-3">
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-muted px-1 font-mono text-[10px]">⌘</kbd>
          <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-muted px-1 font-mono text-[10px]">↵</kbd>
          <span className="ml-0.5">to create</span>
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={createM.isPending}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={createM.isPending || !title.trim()}>
            {createM.isPending && <Loader2 className="size-3.5 animate-spin" />}
            Create milestone
          </Button>
        </div>
      </div>
    </div>
  );
}

function EditPanel({
  projectId,
  milestone,
  onClose,
}: {
  projectId: string;
  milestone: Milestone;
  onClose: () => void;
}) {
  const { data: detail } = useMilestone(projectId, String(milestone.number));
  const { data: events } = useMilestoneEvents(projectId, String(milestone.number));
  const updateM = useUpdateMilestone();
  const closeM = useCloseMilestone();
  const reopenM = useReopenMilestone();
  const deleteM = useDeleteMilestone();

  const [title, setTitle] = useState(milestone.title);
  const [description, setDescription] = useState(milestone.description_md);
  const [acceptance, setAcceptance] = useState(milestone.acceptance_md);
  const [dueAt, setDueAt] = useState<Date | undefined>(milestone.due_at ? new Date(milestone.due_at) : undefined);
  const [hue, setHue] = useState<number | null>(milestone.color_hue);
  const [closeSummary, setCloseSummary] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setTitle(milestone.title);
    setDescription(milestone.description_md);
    setAcceptance(milestone.acceptance_md);
    setDueAt(milestone.due_at ? new Date(milestone.due_at) : undefined);
    setHue(milestone.color_hue);
  }, [milestone]);

  const tickets = detail?.tickets ?? [];
  const isOpen = milestone.status === 'open';
  const anyPending = updateM.isPending || closeM.isPending || reopenM.isPending || deleteM.isPending;

  const dueIso = dueAt ? dueAt.toISOString().slice(0, 10) : '';
  const milestoneDueIso = milestone.due_at ? milestone.due_at.slice(0, 10) : '';
  const dirty =
    title.trim() !== milestone.title ||
    description !== milestone.description_md ||
    acceptance !== milestone.acceptance_md ||
    dueIso !== milestoneDueIso ||
    hue !== milestone.color_hue;

  const saveChanges = async () => {
    try {
      await updateM.mutateAsync({
        projectId, ref: milestone.id,
        patch: {
          title: title.trim(),
          description_md: description,
          acceptance_md: acceptance,
          due_at: dueIso || null,
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
      <div className="flex items-center gap-2 px-5 pt-4 shrink-0">
        <Sparkles className="size-3.5 text-muted-foreground/50" />
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Milestone
        </span>
        <span className="text-muted-foreground/30">·</span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          M{milestone.number}
        </span>
        <span className="text-muted-foreground/30">·</span>
        <span className="text-xs uppercase tracking-wider text-muted-foreground">
          {milestone.status}
        </span>
      </div>

      <div className="px-5 pt-3 shrink-0">
        <textarea
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What outcome are you tracking?"
          rows={1}
          maxLength={120}
          className="w-full resize-none overflow-hidden border-0 bg-transparent text-lg font-semibold leading-tight tracking-tight outline-none placeholder:text-muted-foreground/30 focus:ring-0"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="One line on what this covers (optional)"
          rows={1}
          className="mt-0.5 w-full resize-none overflow-hidden border-0 bg-transparent text-sm leading-snug outline-none placeholder:text-muted-foreground/40 focus:ring-0"
        />
      </div>

      <div className="flex flex-1 min-h-0 flex-col overflow-y-auto">
        <div className="px-5 pt-3">
          <AcceptanceField
            value={acceptance}
            onChange={setAcceptance}
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5 px-5 pt-3 pb-2">
          <DuePill value={dueAt} onChange={setDueAt} />
          <ColorPill hue={hue} setHue={setHue} />
          <ProgressPill done={milestone.progress.done} total={milestone.progress.total} percent={milestone.percent_complete} />
        </div>

        <Section label={`Linked tickets · ${tickets.length}`}>
          {tickets.length === 0 ? (
            <p className="text-xs text-muted-foreground/60">
              No tickets yet. TL links sub-tickets during decomposition.
            </p>
          ) : (
            <ul className="overflow-hidden rounded-2xl bg-muted/30">
              {tickets.map((t, i) => (
                <li
                  key={t.id}
                  className={cn(
                    'flex items-center justify-between gap-3 px-3 py-2',
                    i !== tickets.length - 1 && 'border-b border-border/40',
                  )}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono text-[10.5px] text-muted-foreground/55 shrink-0">#{t.number}</span>
                    <span className="text-sm truncate">{t.title}</span>
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
              {events.slice(0, 20).map((e) => (
                <li key={e.id} className="flex items-start gap-2 text-xs leading-snug">
                  <span className="text-muted-foreground/45 tabular-nums shrink-0 w-[110px]">
                    {new Date(e.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className="text-foreground/80">
                    <span className="font-medium text-foreground">@{e.actor_id ?? e.actor_type}</span>
                    {' '}
                    {e.type.replace(/_/g, ' ')}{e.message ? ` — ${truncate(e.message, 120)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground/60">No activity yet.</p>
          )}
        </Section>

        {isOpen && (
          <Section label="Close milestone">
            <Textarea
              value={closeSummary}
              onChange={(e) => setCloseSummary(e.target.value)}
              placeholder="Closing summary — evidence the acceptance criteria pass (file:line, test output, curl result)."
              rows={2}
              className="text-xs resize-y"
            />
          </Section>
        )}

        <div className="px-5 pb-5" />
      </div>

      <div className="flex items-center gap-2 border-t border-border/40 px-5 py-3 shrink-0">
        <DeleteButton
          confirm={confirmDelete}
          pending={deleteM.isPending}
          onClick={() => confirmDelete ? doDelete() : setConfirmDelete(true)}
          onCancelConfirm={() => setConfirmDelete(false)}
        />

        <div className="ml-auto flex items-center gap-2">
          {dirty && (
            <Button size="sm" variant="outline" onClick={saveChanges} disabled={anyPending}>
              {updateM.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Save changes
            </Button>
          )}
          {isOpen ? (
            <>
              <Button size="sm" variant="ghost" onClick={doClose(true)} disabled={anyPending} className="gap-1.5 text-muted-foreground hover:text-foreground">
                <XCircle className="size-3.5" />
                Cancel
              </Button>
              <Button size="sm" onClick={doClose(false)} disabled={anyPending} className="gap-1.5">
                <CheckCircle2 className="size-3.5" />
                Mark as done
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={doReopen} disabled={anyPending} className="gap-1.5">
              <RotateCcw className="size-3.5" />
              Reopen
            </Button>
          )}
        </div>
      </div>
    </>
  );
}

function ColorPill({ hue, setHue }: { hue: number | null; setHue: (h: number | null) => void }) {
  const current = HUE_OPTIONS.find((h) => h.hue === hue);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className={PILL_TRIGGER} aria-label="Color">
          {hue === null ? (
            <>
              <Palette className="size-3 text-muted-foreground/70" />
              <span className="text-muted-foreground">No color</span>
            </>
          ) : (
            <>
              <span
                className="size-2.5 rounded-full"
                style={{ backgroundColor: `hsl(${hue} 70% 55%)` }}
              />
              <span className="font-medium">{current?.name ?? 'Custom'}</span>
            </>
          )}
          <ChevronDown className="size-3 text-muted-foreground/50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-3">
        <ColorSwatchGrid hue={hue} setHue={setHue} />
      </PopoverContent>
    </Popover>
  );
}

function ColorSwatchGrid({ hue, setHue }: { hue: number | null; setHue: (h: number | null) => void }) {
  return (
    <div>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60">
        Color
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setHue(null)}
          className={cn(
            'inline-flex size-7 items-center justify-center rounded-full bg-muted transition-colors hover:bg-muted/70',
            hue === null && 'ring-2 ring-foreground/70 ring-offset-2 ring-offset-background',
          )}
          aria-label="No color"
          title="No color"
        >
          <span className="block size-3 rounded-full border-2 border-dashed border-muted-foreground/40" />
        </button>
        {HUE_OPTIONS.map((opt) => (
          <button
            key={opt.hue}
            type="button"
            onClick={() => setHue(opt.hue)}
            className={cn(
              'inline-flex size-7 items-center justify-center rounded-full transition-transform hover:scale-110',
              hue === opt.hue && 'ring-2 ring-foreground/80 ring-offset-2 ring-offset-background',
            )}
            style={{ backgroundColor: `hsl(${opt.hue} 70% 55%)` }}
            aria-label={opt.name}
            title={opt.name}
          >
            {hue === opt.hue && <Check className="size-3.5 text-white" />}
          </button>
        ))}
      </div>
    </div>
  );
}

function DuePill({ value, onChange }: { value: Date | undefined; onChange: (v: Date | undefined) => void }) {
  const presets = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const inWeek = new Date(today);
    inWeek.setDate(today.getDate() + 7);
    const inMonth = new Date(today);
    inMonth.setDate(today.getDate() + 30);
    return [
      { label: 'Today', date: today },
      { label: 'Tomorrow', date: tomorrow },
      { label: 'In a week', date: inWeek },
      { label: 'In a month', date: inMonth },
    ];
  }, []);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className={PILL_TRIGGER} aria-label="Due date">
          <CalendarIcon className="size-3 text-muted-foreground/70" />
          {value ? (
            <span className="font-medium tabular-nums">
              {format(value, 'MMM d, yyyy')}
            </span>
          ) : (
            <span className="text-muted-foreground">No due date</span>
          )}
          {value && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onChange(undefined); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onChange(undefined); } }}
              className="-mr-1 ml-0.5 inline-flex size-3.5 cursor-pointer items-center justify-center rounded-full text-muted-foreground/55 hover:bg-muted hover:text-foreground"
              aria-label="Clear due date"
            >
              <X className="size-2.5" />
            </span>
          )}
          {!value && <ChevronDown className="size-3 text-muted-foreground/50" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <div className="flex">
          <div className="flex w-32 flex-col gap-0.5 border-r border-border/50 p-2">
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60">
              Quick
            </div>
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => onChange(p.date)}
                className="rounded-md px-2 py-1.5 text-left text-xs text-foreground/80 transition-colors hover:bg-muted/60 hover:text-foreground"
              >
                {p.label}
              </button>
            ))}
            {value && (
              <>
                <div className="my-1 h-px bg-border/40" />
                <button
                  type="button"
                  onClick={() => onChange(undefined)}
                  className="rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                >
                  Clear
                </button>
              </>
            )}
          </div>
          <Calendar
            mode="single"
            selected={value}
            onSelect={(d) => onChange(d)}
            initialFocus
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ProgressPill({ done, total, percent }: { done: number; total: number; percent: number }) {
  return (
    <span className={cn(PILL_TRIGGER, 'pointer-events-none')}>
      <span className="tabular-nums text-foreground">{done}</span>
      <span className="text-muted-foreground/60">/{total}</span>
      <span className="text-muted-foreground/30">·</span>
      <span className="font-medium tabular-nums">{percent}%</span>
    </span>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="px-5 pt-5">
      <div className="text-[10px] uppercase tracking-[0.08em] font-semibold text-muted-foreground/55 mb-2">
        {label}
      </div>
      {children}
    </section>
  );
}

function AcceptanceField({
  value,
  onChange,
  onKeyDown,
}: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <div
      onClick={() => ref.current?.focus()}
      className={cn(
        'group/accept rounded-xl bg-muted/40 px-3.5 py-3 cursor-text',
        'transition-colors hover:bg-muted/55 focus-within:bg-muted/55',
        'focus-within:ring-2 focus-within:ring-ring/20',
      )}
    >
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/70">
        <CheckCircle2 className="size-3" />
        Done when
      </div>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Subscriber receives signed hook within 3 attempts"
        rows={2}
        className="mt-1.5 w-full resize-none border-0 bg-transparent font-mono text-[12.5px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/45 focus:ring-0"
      />
    </div>
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
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
          Confirm delete
        </Button>
      </div>
    );
  }
  return (
    <Button size="sm" variant="ghost" onClick={onClick} className="gap-1.5 text-muted-foreground/60 hover:text-destructive">
      <Trash2 className="size-3.5" />
      Delete
    </Button>
  );
}

function TicketStatusBadge({ status }: { status: string }) {
  return (
    <span className={cn(
      'inline-flex h-5 items-center rounded-md bg-muted/60 px-1.5 text-[9.5px] font-mono uppercase tracking-[0.04em] text-muted-foreground shrink-0',
    )}>
      {status}
    </span>
  );
}

function truncate(s: string, n: number) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
