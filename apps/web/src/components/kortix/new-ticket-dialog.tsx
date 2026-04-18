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
  Sparkles,
  Bug,
  Zap,
  Wrench,
  X,
  UserPlus,
  Check,
  ChevronDown,
  Circle,
  CircleDot,
  Loader2,
  CheckCircle2,
  UserCircle2,
  Bot,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { UnifiedMarkdown } from '@/components/markdown';
import {
  useCreateTicket,
  useAssignTicket,
  useTemplates,
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
  const assign = useAssignTicket();

  const [step, setStep] = useState<Step>('pick');
  const [template, setTemplate] = useState<TicketTemplate | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [status, setStatus] = useState<string>('');
  const [pending, setPending] = useState<PendingAssignee[]>([]);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setBody('');
    setTemplate(null);
    setPending([]);
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
      },
      {
        onSuccess: (r) => {
          // Apply any manually-picked assignees after create — the column rule
          // may have auto-assigned someone (e.g. PM for backlog), so this adds
          // on top. Duplicate-safe on the server.
          for (const p of pending) {
            assign.mutate({ id: r.ticket.id, assignee_type: p.type, assignee_id: p.id });
          }
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'p-0 overflow-hidden gap-0 border-border/60 bg-background',
          step === 'pick' ? 'max-w-md' : 'max-w-2xl',
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
            userHandle={userHandle}
            pending={pending}
            showBack={hasTemplates}
            onBack={() => setStep('pick')}
            onClose={() => onOpenChange(false)}
            onTitleChange={setTitle}
            onBodyChange={setBody}
            onStatusChange={setStatus}
            onAddAssignee={(a) => setPending((p) => (p.some((x) => x.type === a.type && x.id === a.id) ? p : [...p, a]))}
            onRemoveAssignee={(a) => setPending((p) => p.filter((x) => !(x.type === a.type && x.id === a.id)))}
            onSubmit={submit}
            submitting={create.isPending}
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
      <div className="flex items-center px-5 pt-5 pb-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">New ticket</div>
          <h2 className="text-[15px] font-semibold tracking-tight mt-1">Start from a template</h2>
        </div>
        <Button variant="ghost" size="sm" className="ml-auto h-7 w-7 p-0 text-muted-foreground/60" onClick={onCancel}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="px-5 pb-5 grid grid-cols-2 gap-2">
        <TemplateCard
          title="Blank"
          hint="Empty ticket."
          icon={<FileText className="h-4 w-4 text-muted-foreground/60" />}
          onClick={() => onPick(null)}
        />
        {templates.map((t) => (
          <TemplateCard
            key={t.id}
            title={t.name}
            hint={summarise(t.body_md)}
            icon={iconForName(t.name)}
            onClick={() => onPick(t)}
          />
        ))}
      </div>

      <div className="px-5 pb-4 text-[11px] text-muted-foreground/40">
        Templates live in Settings → Templates.
      </div>
    </div>
  );
}

function TemplateCard({ title, hint, icon, onClick }: { title: string; hint: string; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group text-left rounded-xl border border-border/40 bg-card/70 hover:bg-muted/30 hover:border-border p-3.5 transition-all cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
    >
      <div className="flex items-center gap-2 mb-1.5">
        {icon}
        <span className="text-[13px] font-semibold tracking-tight">{title}</span>
      </div>
      <p className="text-[11.5px] text-muted-foreground/65 line-clamp-2 leading-relaxed">{hint}</p>
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
  userHandle,
  pending,
  showBack,
  onBack,
  onClose,
  onTitleChange,
  onBodyChange,
  onStatusChange,
  onAddAssignee,
  onRemoveAssignee,
  onSubmit,
  submitting,
}: {
  template: TicketTemplate | null;
  title: string;
  body: string;
  status: string;
  columns: TicketColumn[];
  agents: ProjectAgent[];
  userHandle: string;
  pending: PendingAssignee[];
  showBack: boolean;
  onBack: () => void;
  onClose: () => void;
  onTitleChange: (v: string) => void;
  onBodyChange: (v: string) => void;
  onStatusChange: (v: string) => void;
  onAddAssignee: (a: PendingAssignee) => void;
  onRemoveAssignee: (a: PendingAssignee) => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [bodyMode, setBodyMode] = useState<'write' | 'preview'>('write');

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
    <div className="flex flex-col">
      {/* Header */}
      <div className="flex items-center px-5 pt-4 pb-3 gap-3">
        {showBack ? (
          <Button variant="ghost" size="sm" className="h-6 px-1.5 -ml-1.5 text-muted-foreground/60 hover:text-foreground text-[11px]" onClick={onBack}>
            <ArrowLeft className="h-3.5 w-3.5 mr-1" />
            Templates
          </Button>
        ) : (
          <div className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">
            New ticket{template ? ` · ${template.name}` : ''}
          </div>
        )}
        <div className="ml-auto inline-flex items-center gap-3 text-[11px]">
          <button
            onClick={() => setBodyMode('write')}
            className={cn(
              'transition-colors cursor-pointer',
              bodyMode === 'write' ? 'text-foreground' : 'text-muted-foreground/40 hover:text-foreground/80',
            )}
          >
            Write
          </button>
          <button
            onClick={() => setBodyMode('preview')}
            className={cn(
              'transition-colors cursor-pointer',
              bodyMode === 'preview' ? 'text-foreground' : 'text-muted-foreground/40 hover:text-foreground/80',
            )}
          >
            Preview
          </button>
          <span className="h-4 w-px bg-border/50" aria-hidden />
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground/50 hover:text-foreground" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Body — 2-column layout: seamless editor on the left, meta rail on the right */}
      <div className="grid grid-cols-[1fr_220px] min-h-[360px]">
        <div className="px-6 pt-6 pb-5 flex flex-col min-w-0">
          <textarea
            ref={titleRef}
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            onKeyDown={onTitleKey}
            placeholder="Ticket title"
            rows={1}
            className="w-full text-[22px] font-semibold tracking-tight bg-transparent border-0 outline-none focus:ring-0 placeholder:text-muted-foreground/25 resize-none overflow-hidden leading-tight"
          />

          {bodyMode === 'write' ? (
            <textarea
              ref={bodyRef}
              value={body}
              onChange={(e) => onBodyChange(e.target.value)}
              onKeyDown={onBodyKey}
              placeholder={"Description, acceptance criteria, notes…\n\nMarkdown supported. Reference agents with @slug."}
              rows={8}
              className="w-full mt-3 text-[13.5px] leading-[1.7] bg-transparent border-0 outline-none focus:ring-0 resize-none placeholder:text-muted-foreground/25 font-mono overflow-hidden"
            />
          ) : body.trim() ? (
            <article className="prose prose-sm dark:prose-invert max-w-none prose-p:my-2 prose-ul:my-2 prose-ol:my-2 text-[13.5px] leading-relaxed min-h-[200px] mt-3">
              <UnifiedMarkdown content={body} />
            </article>
          ) : (
            <div className="text-[13px] text-muted-foreground/40 min-h-[200px] mt-3">
              Nothing to preview yet.
            </div>
          )}
        </div>

        {/* Meta rail — no divider, same bg as body. Reads as one surface. */}
        <aside className="px-4 pt-6 pb-5 space-y-5">
          <MetaBlock label="Assignees">
            <AssigneePicker
              agents={agents}
              userHandle={userHandle}
              pending={pending}
              onAdd={onAddAssignee}
              onRemove={onRemoveAssignee}
            />
          </MetaBlock>
          <MetaBlock label="Status">
            <StatusPicker columns={columns} value={status} onChange={onStatusChange} />
          </MetaBlock>
        </aside>
      </div>

      {/* Footer */}
      <div className="border-t border-border/40 px-5 py-2.5 flex items-center">
        <span className="text-[11px] text-muted-foreground/50">
          <kbd className="inline-flex items-center justify-center min-w-[18px] h-4 px-1 rounded border border-border/50 bg-muted/40 text-[10px] font-mono leading-none">⌘</kbd>
          <kbd className="inline-flex items-center justify-center min-w-[18px] h-4 px-1 ml-0.5 rounded border border-border/50 bg-muted/40 text-[10px] font-mono leading-none">↵</kbd>
          <span className="ml-1.5">to create</span>
        </span>
        <Button
          size="sm"
          className="ml-auto h-7 px-3 text-[12px]"
          onClick={onSubmit}
          disabled={!title.trim() || submitting}
        >
          {submitting ? 'Creating…' : 'Create ticket'}
        </Button>
      </div>
    </div>
  );
}

// ─── Meta block (right-rail section) ────────────────────────────────────────

function MetaBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold mb-2">{label}</div>
      {children}
    </div>
  );
}

// ─── Status picker: single chip → dropdown with every column ────────────────

function columnIcon(c: TicketColumn, active: boolean) {
  const className = active
    ? 'h-3.5 w-3.5'
    : c.is_terminal
      ? 'h-3.5 w-3.5 text-emerald-500/70'
      : c.key === 'in_progress'
        ? 'h-3.5 w-3.5 text-blue-500/80'
        : c.key === 'review'
          ? 'h-3.5 w-3.5 text-amber-500/70'
          : 'h-3.5 w-3.5 text-muted-foreground/55';
  if (c.is_terminal) return <CheckCircle2 className={className} />;
  if (c.key === 'in_progress') return <Loader2 className={className} />;
  if (c.key === 'review') return <CircleDot className={className} />;
  return <Circle className={className} />;
}

function StatusPicker({ columns, value, onChange }: { columns: TicketColumn[]; value: string; onChange: (k: string) => void }) {
  const selected = columns.find((c) => c.key === value) ?? columns[0];
  if (!selected) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="group w-full inline-flex items-center gap-2 h-8 px-2.5 rounded-lg border border-border/50 hover:border-border bg-card/60 hover:bg-muted/40 text-[12.5px] text-foreground transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
          aria-label={`Status: ${selected.label}`}
        >
          {columnIcon(selected, false)}
          <span className="truncate flex-1 text-left font-medium">{selected.label}</span>
          <ChevronDown className="h-3 w-3 text-muted-foreground/40 group-hover:text-foreground transition-colors" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[200px] z-[10000]">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">
          Move to
        </DropdownMenuLabel>
        {columns.map((c) => {
          const active = c.key === value;
          return (
            <DropdownMenuItem
              key={c.key}
              onClick={() => onChange(c.key)}
              className="gap-2 cursor-pointer"
            >
              {columnIcon(c, false)}
              <span className="flex-1 truncate">{c.label}</span>
              {active && <Check className="h-3 w-3 text-primary" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── Assignee picker ────────────────────────────────────────────────────────

function AssigneePicker({
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
  const alreadyAdded = (t: AssigneeType, id: string) => pending.some((x) => x.type === t && x.id === id);
  return (
    <div className="flex flex-col gap-1.5">
      {pending.length === 0 && (
        <p className="text-[11.5px] text-muted-foreground/40 leading-snug">
          Unassigned — column defaults still fire.
        </p>
      )}
      {pending.map((a) => (
        <div
          key={`${a.type}:${a.id}`}
          className={cn(
            'inline-flex items-center gap-1.5 h-7 pl-2 pr-1 rounded-full text-[11.5px] font-mono w-fit',
            a.type === 'user' ? 'bg-primary/10 text-primary' : 'bg-muted/50 text-foreground/80',
          )}
        >
          {a.type === 'user'
            ? <UserCircle2 className="h-3 w-3" />
            : <Bot className="h-3 w-3 opacity-60" />}
          <span className="truncate max-w-[140px]">@{a.label}</span>
          <button
            onClick={() => onRemove(a)}
            className={cn(
              'h-4 w-4 inline-flex items-center justify-center rounded-full transition-colors',
              a.type === 'user' ? 'text-primary/60 hover:text-primary hover:bg-primary/15' : 'text-muted-foreground/50 hover:text-foreground hover:bg-muted/70',
            )}
            aria-label="Remove"
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </div>
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px] gap-1 text-muted-foreground/60 hover:text-foreground border border-dashed border-border/40 hover:border-border rounded-full w-fit"
          >
            <UserPlus className="h-2.5 w-2.5" />
            Add
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56 z-[10000]">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">
            Assign to
          </DropdownMenuLabel>
          <DropdownMenuItem
            disabled={alreadyAdded('user', userHandle)}
            onClick={() => onAdd({ type: 'user', id: userHandle, label: userHandle })}
            className="gap-2 cursor-pointer"
          >
            <UserCircle2 className="h-3.5 w-3.5 text-primary" />
            <span className="flex-1 truncate">@{userHandle}</span>
            <span className="text-[10px] text-muted-foreground/40">you</span>
          </DropdownMenuItem>
          {agents.length > 0 && <DropdownMenuSeparator />}
          {agents.map((a) => (
            <DropdownMenuItem
              key={a.id}
              disabled={alreadyAdded('agent', a.id)}
              onClick={() => onAdd({ type: 'agent', id: a.id, label: a.slug })}
              className="gap-2 cursor-pointer"
            >
              <Bot className="h-3.5 w-3.5 text-muted-foreground/60" />
              <span className="flex-1 truncate">@{a.slug}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
