'use client';

/**
 * New-ticket composer.
 *
 * Flow:
 *   - No templates defined → form directly.
 *   - Templates present → step-1 picker (grid of cards), then form.
 *
 * Layout mirrors the seamless GitHub / Linear composer — title input flows
 * straight into the markdown body with no visible textarea border. Meta
 * (status, assignees, template) lives in a clearly labeled metadata block
 * below the body, styled like the project About view.
 */

import { useEffect, useMemo, useRef, useState, useLayoutEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  ArrowLeft,
  FileText,
  FileStack,
  Sparkles,
  Bug,
  Zap,
  Wrench,
  X,
  UserPlus,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  Loader2,
  CheckCircle2,
  UserCircle2,
  Bot,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { AgentAvatar, UserAvatar, useCurrentUserAvatarProps } from '@/components/kortix/agent-avatar';
import { MentionTextarea } from '@/components/kortix/mention-textarea';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useMilestones, type Milestone } from '@/hooks/kortix/use-milestones';
import {
  useCreateTicket,
  useTemplates,
  useReplaceTemplates,
  useProjectAgents,
  useUserHandle,
  type TicketColumn,
  type TicketTemplate,
  type ProjectAgent,
  type AssigneeType,
} from '@/hooks/kortix/use-kortix-tickets';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  columns: TicketColumn[];
  defaultStatus?: string;
}

type Step = 'pick' | 'form';

interface PendingAssignee { type: AssigneeType; id: string; label: string }

export function NewTicketDialog({ open, onOpenChange, projectId, columns, defaultStatus }: Props) {
  const { data: templatesData } = useTemplates(projectId);
  const { data: agentsData } = useProjectAgents(projectId);
  const templates = useMemo(() => templatesData ?? [], [templatesData]);
  const agents = useMemo(() => agentsData ?? [], [agentsData]);
  const hasTemplates = templates.length > 0;
  const userHandle = useUserHandle();

  const create = useCreateTicket();
  const replaceTemplates = useReplaceTemplates();
  const { data: milestonesData } = useMilestones(projectId, 'open');
  const milestones = useMemo(() => milestonesData ?? [], [milestonesData]);

  const [step, setStep] = useState<Step>('pick');
  const [template, setTemplate] = useState<TicketTemplate | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [status, setStatus] = useState<string>('');
  const [milestoneId, setMilestoneId] = useState<string>('');
  const [pending, setPending] = useState<PendingAssignee[]>([]);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setBody('');
    setTemplate(null);
    setPending([]);
    setMilestoneId('');
    setStatus(defaultStatus || columns[0]?.key || '');
    setStep(hasTemplates ? 'pick' : 'form');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const goToForm = (t: TicketTemplate | null) => {
    setTemplate(t);
    setBody(t?.body_md ?? '');
    setStep('form');
  };

  const submit = () => {
    if (!title.trim()) return;
    create.mutate(
      {
        project_id: projectId,
        title: title.trim(),
        body_md: body,
        status: status || undefined,
        template_id: template?.id ?? null,
        milestone_id: milestoneId || null,
        // Passing `assign_to` at create time makes the server skip the
        // column's default-assignee rule. User-picked assignees win, backlog
        // default (PM) doesn't redundantly attach.
        assign_to: pending.length
          ? pending.map((p) => ({ type: p.type, id: p.id }))
          : undefined,
      },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'gap-0 overflow-hidden p-0',
          step === 'pick' ? 'max-w-sm sm:max-w-sm' : 'max-w-2xl sm:max-w-2xl',
        )}
        hideCloseButton
      >
        <DialogTitle className="sr-only">New ticket</DialogTitle>
        <DialogDescription className="sr-only">Create a ticket</DialogDescription>

        {step === 'pick' && hasTemplates ? (
          <TemplatePicker
            templates={templates}
            onPick={goToForm}
            onCancel={() => onOpenChange(false)}
          />
        ) : (
          <TicketForm
            template={template}
            title={title}
            body={body}
            status={status}
            columns={columns}
            agents={agents}
            milestones={milestones}
            milestoneId={milestoneId}
            userHandle={userHandle}
            pending={pending}
            showBack={hasTemplates}
            onBack={() => setStep('pick')}
            onClose={() => onOpenChange(false)}
            onTitleChange={setTitle}
            onBodyChange={setBody}
            onStatusChange={setStatus}
            onMilestoneChange={setMilestoneId}
            onAddAssignee={(a) => setPending((p) => (p.some((x) => x.type === a.type && x.id === a.id) ? p : [...p, a]))}
            onRemoveAssignee={(a) => setPending((p) => p.filter((x) => !(x.type === a.type && x.id === a.id)))}
            onSubmit={submit}
            submitting={create.isPending}
            onSaveAsTemplate={(name) => new Promise<void>((resolve, reject) => {
              replaceTemplates.mutate(
                { projectId, templates: [...templates.map((t) => ({ name: t.name, body_md: t.body_md })), { name, body_md: body }] },
                { onSuccess: () => resolve(), onError: (e) => reject(e) },
              );
            })}
            savingTemplate={replaceTemplates.isPending}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Template picker ────────────────────────────────────────────────────────

function TemplatePicker({
  templates,
  onPick,
  onCancel,
}: {
  templates: TicketTemplate[];
  onPick: (t: TicketTemplate | null) => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-start px-5 pt-5 pb-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">New ticket</div>
          <h2 className="text-[15px] font-semibold tracking-tight mt-1">Start from a template</h2>
        </div>
        <Button variant="ghost" size="sm" className="ml-auto h-7 w-7 p-0 text-muted-foreground/60 hover:text-foreground" onClick={onCancel}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="px-5 pb-4">
        <div className="rounded-xl border border-border/40 divide-y divide-border/30 overflow-hidden bg-card">
          <TemplateRow
            title="Blank"
            hint="Start from an empty ticket."
            icon={<FileText className="h-3.5 w-3.5 text-muted-foreground/55" />}
            onClick={() => onPick(null)}
          />
          {templates.map((t) => (
            <TemplateRow
              key={t.id}
              title={t.name}
              hint={summarise(t.body_md)}
              icon={iconForName(t.name)}
              onClick={() => onPick(t)}
            />
          ))}
        </div>
      </div>

      <div className="px-5 pb-4 text-[11px] text-muted-foreground/40">
        Templates live in Settings → Templates.
      </div>
    </div>
  );
}

function TemplateRow({ title, hint, icon, onClick }: { title: string; hint: string; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/20 transition-colors cursor-pointer outline-none focus-visible:bg-muted/25"
    >
      <span className="shrink-0 w-6 h-6 rounded-full bg-muted/40 flex items-center justify-center">
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-semibold tracking-tight text-foreground leading-tight">
          {title}
        </div>
        <p className="text-[11.5px] text-muted-foreground/60 line-clamp-1 leading-snug mt-0.5">
          {hint}
        </p>
      </div>
      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/25 group-hover:text-foreground transition-colors" />
    </button>
  );
}

function summarise(body: string): string {
  const clean = (body || '').replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Empty template.';
  return clean.length > 110 ? `${clean.slice(0, 107)}…` : clean;
}

function iconForName(name: string): React.ReactNode {
  const n = name.toLowerCase();
  if (n.includes('bug') || n.includes('fix')) return <Bug className="h-4 w-4 text-rose-400/70" />;
  if (n.includes('feature') || n.includes('feat')) return <Sparkles className="h-4 w-4 text-amber-400/70" />;
  if (n.includes('spike') || n.includes('research')) return <Zap className="h-4 w-4 text-purple-400/70" />;
  if (n.includes('chore') || n.includes('task')) return <Wrench className="h-4 w-4 text-emerald-400/70" />;
  return <FileText className="h-4 w-4 text-muted-foreground/60" />;
}

// ─── Ticket form ────────────────────────────────────────────────────────────

function TicketForm({
  template,
  title,
  body,
  status,
  columns,
  agents,
  milestones,
  milestoneId,
  userHandle,
  pending,
  showBack,
  onBack,
  onClose,
  onTitleChange,
  onBodyChange,
  onStatusChange,
  onMilestoneChange,
  onAddAssignee,
  onRemoveAssignee,
  onSubmit,
  submitting,
  onSaveAsTemplate,
  savingTemplate,
}: {
  template: TicketTemplate | null;
  title: string;
  body: string;
  status: string;
  columns: TicketColumn[];
  agents: ProjectAgent[];
  milestones: Milestone[];
  milestoneId: string;
  userHandle: string;
  pending: PendingAssignee[];
  showBack: boolean;
  onBack: () => void;
  onClose: () => void;
  onTitleChange: (v: string) => void;
  onBodyChange: (v: string) => void;
  onStatusChange: (v: string) => void;
  onMilestoneChange: (v: string) => void;
  onAddAssignee: (a: PendingAssignee) => void;
  onRemoveAssignee: (a: PendingAssignee) => void;
  onSubmit: () => void;
  submitting: boolean;
  onSaveAsTemplate: (name: string) => Promise<void>;
  savingTemplate: boolean;
}) {
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const { avatarUrl: myAvatarUrl } = useCurrentUserAvatarProps();

  // Auto-size title and body to fit content — the seamless feel requires that
  // neither field has a visible edge.
  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [title]);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(160, el.scrollHeight)}px`;
  }, [body]);

  useEffect(() => {
    setTimeout(() => titleRef.current?.focus(), 40);
  }, []);

  const onTitleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter') {
      // Newlines in a title are pointless — jump to body.
      e.preventDefault();
      if ((e.metaKey || e.ctrlKey) && title.trim()) onSubmit();
      else bodyRef.current?.focus();
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSubmit();
    }
  };
  const onBodyKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="relative flex flex-col">
      <div className="flex items-center gap-2 px-5 pt-4">
        <Sparkles className="size-3.5 text-muted-foreground/50" />
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          New ticket
        </span>
        {template && (
          <>
            <span className="text-muted-foreground/30">·</span>
            <span className="text-xs text-muted-foreground">
              From <span className="font-medium text-foreground">{template.name}</span>
            </span>
          </>
        )}
        <div className="ml-auto flex items-center gap-1">
          {showBack && (
            <Button
              variant="ghost"
              size="xs"
              className="text-muted-foreground hover:text-foreground"
              onClick={onBack}
            >
              <ArrowLeft />
              Templates
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            <X />
          </Button>
        </div>
      </div>

      <div className="flex items-start gap-3 px-5 pt-5">
        <StatusCircle columns={columns} value={status} onChange={onStatusChange} />
        <textarea
          ref={titleRef}
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          onKeyDown={onTitleKey}
          placeholder="Ticket title"
          rows={1}
          className="w-full resize-none overflow-hidden border-0 bg-transparent pt-px text-lg font-semibold leading-tight tracking-tight outline-none placeholder:text-muted-foreground/30 focus:ring-0"
        />
      </div>

      <div className="px-5 pt-2 pb-3 pl-[3.25rem]">
        <MentionTextarea
          ref={bodyRef}
          value={body}
          onChange={onBodyChange}
          onKeyDown={onBodyKey}
          agents={agents}
          userHandle={userHandle}
          userAvatarUrl={myAvatarUrl}
          placeholder="Add a description… markdown supported, @ to mention"
          rows={3}
          className="w-full resize-none border-0 bg-transparent text-sm leading-relaxed outline-none placeholder:text-muted-foreground/30 focus:ring-0"
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-5 pb-4">
        <StatusPill columns={columns} value={status} onChange={onStatusChange} />
        <AssigneePill
          agents={agents}
          userHandle={userHandle}
          pending={pending}
          onAdd={onAddAssignee}
          onRemove={onRemoveAssignee}
        />
        {milestones.length > 0 && (
          <MilestonePill
            milestones={milestones}
            value={milestoneId}
            onChange={onMilestoneChange}
          />
        )}
      </div>

      <div className="flex items-center gap-2 px-5 pb-4 pt-1">
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-muted px-1 font-mono text-[10px]">⌘</kbd>
          <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-muted px-1 font-mono text-[10px]">↵</kbd>
          <span className="ml-1">to create</span>
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <SaveAsTemplateButton
            disabled={!body.trim() || savingTemplate}
            saving={savingTemplate}
            onSave={onSaveAsTemplate}
          />
          <Button size="sm" onClick={onSubmit} disabled={!title.trim() || submitting}>
            {submitting ? 'Creating…' : 'Create ticket'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function StatusCircle({
  columns,
  value,
  onChange,
}: {
  columns: TicketColumn[];
  value: string;
  onChange: (k: string) => void;
}) {
  const selected = columns.find((c) => c.key === value) ?? columns[0];
  if (!selected) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex size-6 shrink-0 items-center justify-center rounded-md',
            'transition-colors hover:bg-muted',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30',
          )}
          aria-label={`Status: ${selected.label}`}
          title={selected.label}
        >
          {columnIcon(selected)}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="z-[10000] w-48">
        <DropdownMenuLabel className="text-xs uppercase tracking-wider text-muted-foreground">
          Status
        </DropdownMenuLabel>
        {columns.map((c) => {
          const active = c.key === value;
          return (
            <DropdownMenuItem
              key={c.key}
              onClick={() => onChange(c.key)}
              className="gap-2"
            >
              {columnIcon(c)}
              <span className="flex-1 truncate">{c.label}</span>
              {active && <Check className="size-3 text-primary" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── Save-as-template popover ──────────────────────────────────────────────

function SaveAsTemplateButton({ disabled, saving, onSave }: {
  disabled: boolean; saving: boolean; onSave: (name: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName('');
      setError(null);
      setTimeout(() => inputRef.current?.focus(), 40);
    }
  }, [open]);

  const commit = async () => {
    if (!name.trim()) { setError('Name required'); return; }
    try {
      await onSave(name.trim());
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  };

  return (
    <Popover open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-7 w-7 p-0 text-muted-foreground/50 hover:text-foreground',
            disabled && 'opacity-40 cursor-not-allowed',
          )}
          disabled={disabled}
          title="Save current body as a template"
          aria-label="Save as template"
        >
          <FileStack className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-72 p-3 z-[10000]">
        <div className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold mb-2">
          Save as template
        </div>
        <p className="text-[11.5px] text-muted-foreground/60 mb-2.5 leading-snug">
          Reuse this ticket's body later as a fresh template in the picker.
        </p>
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => { setName(e.target.value); setError(null); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
          }}
          placeholder="Template name — e.g. Bug, Feature…"
          className="h-7 w-full text-[12px] bg-transparent border border-border/50 rounded px-2 outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/20"
        />
        {error && <p className="text-[11px] text-destructive mt-1.5">{error}</p>}
        <div className="flex items-center gap-2 mt-2.5">
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            size="sm"
            className="ml-auto h-6 px-2.5 text-[11px] gap-1"
            onClick={commit}
            disabled={!name.trim() || saving}
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            Save template
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── Status picker ──────────────────────────────────────────────────────────

const PILL_TRIGGER = cn(
  'group inline-flex items-center gap-1.5 rounded-full bg-muted/40 px-2.5 py-1 text-xs',
  'text-foreground transition-colors hover:bg-muted',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30',
);

function columnIcon(c: TicketColumn) {
  const cls = c.is_terminal
    ? 'size-3 text-emerald-500'
    : c.key === 'in_progress'
      ? 'size-3 text-blue-500'
      : c.key === 'review'
        ? 'size-3 text-amber-500'
        : 'size-3 text-muted-foreground/60';
  if (c.is_terminal) return <CheckCircle2 className={cls} />;
  if (c.key === 'in_progress') return <Loader2 className={cls} />;
  if (c.key === 'review') return <CircleDot className={cls} />;
  return <Circle className={cls} />;
}

function StatusPill({
  columns,
  value,
  onChange,
}: {
  columns: TicketColumn[];
  value: string;
  onChange: (k: string) => void;
}) {
  const selected = columns.find((c) => c.key === value) ?? columns[0];
  if (!selected) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" className={cn(PILL_TRIGGER, 'bg-muted text-muted-foreground hover:bg-muted/70')} aria-label={`Status: ${selected.label}`}>
          {columnIcon(selected)}
          <span className="font-medium">{selected.label}</span>
          <ChevronDown className="size-3 text-muted-foreground/50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="z-[10000] w-48">
        <DropdownMenuLabel className="text-xs uppercase tracking-wider text-muted-foreground">
          Status
        </DropdownMenuLabel>
        {columns.map((c) => {
          const active = c.key === value;
          return (
            <DropdownMenuItem
              key={c.key}
              onClick={() => onChange(c.key)}
              className="gap-2"
            >
              {columnIcon(c)}
              <span className="flex-1 truncate">{c.label}</span>
              {active && <Check className="size-3 text-primary" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MilestonePill({
  milestones,
  value,
  onChange,
}: {
  milestones: Milestone[];
  value: string;
  onChange: (v: string) => void;
}) {
  const selected = milestones.find((m) => m.id === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" className={cn(PILL_TRIGGER, 'bg-muted text-muted-foreground hover:bg-muted/70')} aria-label="Milestone">
          <CircleDot className="size-3 text-violet-500" />
          <span className={cn('font-medium', !selected && 'text-muted-foreground')}>
            {selected ? selected.title : 'No milestone'}
          </span>
          <ChevronDown className="size-3 text-muted-foreground/50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="z-[10000] w-56">
        <DropdownMenuLabel className="text-xs uppercase tracking-wider text-muted-foreground">
          Milestone
        </DropdownMenuLabel>
        <DropdownMenuItem onClick={() => onChange('')} className="gap-2">
          <Circle className="size-3 text-muted-foreground/40" />
          <span className="flex-1 truncate text-muted-foreground">No milestone</span>
          {!value && <Check className="size-3 text-primary" />}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {milestones.map((m) => (
          <DropdownMenuItem
            key={m.id}
            onClick={() => onChange(m.id)}
            className="gap-2"
          >
            <CircleDot className="size-3 text-violet-500" />
            <span className="flex-1 truncate">
              <span className="font-mono text-muted-foreground">M{m.number}</span> {m.title}
            </span>
            {m.id === value && <Check className="size-3 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AssigneePill({
  agents,
  userHandle,
  pending,
  onAdd,
  onRemove,
}: {
  agents: ProjectAgent[];
  userHandle: string;
  pending: PendingAssignee[];
  onAdd: (a: PendingAssignee) => void;
  onRemove: (a: PendingAssignee) => void;
}) {
  const { avatarUrl: myAvatarUrl } = useCurrentUserAvatarProps();
  const alreadyAdded = (t: AssigneeType, id: string) =>
    pending.some((x) => x.type === t && x.id === id);

  return (
    <>
      {pending.map((a) => {
        const ag = a.type === 'agent' ? agents.find((x) => x.id === a.id) : null;
        return (
          <span
            key={`${a.type}:${a.id}`}
            className="inline-flex items-center gap-1.5 rounded-full bg-muted/40 py-0.5 pl-0.5 pr-1.5 text-xs"
          >
            {ag ? (
              <AgentAvatar
                hue={ag.color_hue}
                icon={ag.icon}
                slug={ag.slug}
                name={ag.name}
                size="sm"
              />
            ) : (
              <UserAvatar
                handle={a.label}
                avatarUrl={a.type === 'user' && a.label === userHandle ? myAvatarUrl : null}
                size="sm"
              />
            )}
            <span className="font-mono text-foreground/90">@{a.label}</span>
            <button
              type="button"
              onClick={() => onRemove(a)}
              className="grid size-4 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Remove assignee"
            >
              <X className="size-2.5" />
            </button>
          </span>
        );
      })}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="xs"
            className={cn(
              PILL_TRIGGER,
              'bg-muted text-muted-foreground hover:bg-muted/70',
            )}
            aria-label="Add assignee"
          >
            <UserPlus className="size-3" />
            <span className="font-medium">{pending.length === 0 ? 'Assign' : 'Add'}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="z-[10000] w-56">
          <DropdownMenuLabel className="text-xs uppercase tracking-wider text-muted-foreground">
            Assign to
          </DropdownMenuLabel>
          <DropdownMenuItem
            disabled={alreadyAdded('user', userHandle)}
            onClick={() => onAdd({ type: 'user', id: userHandle, label: userHandle })}
            className="gap-2"
          >
            <UserAvatar handle={userHandle} avatarUrl={myAvatarUrl} size="sm" />
            <span className="flex-1 truncate">@{userHandle}</span>
            <span className="text-xs text-muted-foreground">you</span>
          </DropdownMenuItem>
          {agents.length > 0 && <DropdownMenuSeparator />}
          {agents.map((a) => (
            <DropdownMenuItem
              key={a.id}
              disabled={alreadyAdded('agent', a.id)}
              onClick={() => onAdd({ type: 'agent', id: a.id, label: a.slug })}
              className="gap-2"
            >
              <AgentAvatar
                hue={a.color_hue}
                icon={a.icon}
                slug={a.slug}
                name={a.name}
                size="sm"
              />
              <span className="flex-1 truncate">@{a.slug}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

