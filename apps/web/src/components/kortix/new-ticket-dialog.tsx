'use client';

/**
 * New-ticket flow.
 *
 * Two steps:
 *   1. Template picker — grid of cards (Blank + user's templates). Skipped
 *      entirely when no templates are defined (auto-advance to the form).
 *   2. Form — title, markdown body pre-filled from the picked template,
 *      destination column selector.
 *
 * Keyboard:
 *   ⌘↵ submits from the form.
 *   Esc closes either step.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ArrowLeft, FileText, Sparkles, Bug, Zap, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  useCreateTicket,
  useTemplates,
  type TicketColumn,
  type TicketTemplate,
} from '@/hooks/kortix/use-kortix-tickets';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  columns: TicketColumn[];
  defaultStatus?: string;
}

const BLANK_TEMPLATE_ID = '__blank';

type Step = 'pick' | 'form';

export function NewTicketDialog({ open, onOpenChange, projectId, columns, defaultStatus }: Props) {
  const { data: templatesData } = useTemplates(projectId);
  const templates = useMemo(() => templatesData ?? [], [templatesData]);
  const hasTemplates = templates.length > 0;
  const create = useCreateTicket();

  const [step, setStep] = useState<Step>('pick');
  const [template, setTemplate] = useState<TicketTemplate | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [status, setStatus] = useState<string>('');
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setBody('');
    setTemplate(null);
    setStatus(defaultStatus || columns[0]?.key || '');
    setStep(hasTemplates ? 'pick' : 'form');
    if (!hasTemplates) setTimeout(() => titleRef.current?.focus(), 40);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // When we advance to the form, focus the title.
  useEffect(() => {
    if (step === 'form' && open) setTimeout(() => titleRef.current?.focus(), 40);
  }, [step, open]);

  const goToForm = (t: TicketTemplate | null) => {
    setTemplate(t);
    setBody(t?.body_md ?? '');
    setStep('form');
  };

  const submit = () => {
    if (!title.trim()) return;
    create.mutate({
      project_id: projectId,
      title: title.trim(),
      body_md: body,
      status: status || undefined,
      template_id: template?.id ?? null,
    }, {
      onSuccess: () => onOpenChange(false),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'p-0 overflow-hidden gap-0 border-border/60',
          step === 'pick' ? 'max-w-xl' : 'max-w-3xl',
        )}
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
            titleRef={titleRef}
            showBack={hasTemplates}
            onBack={() => setStep('pick')}
            onTitleChange={setTitle}
            onBodyChange={setBody}
            onStatusChange={setStatus}
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
      <div className="px-5 pt-5 pb-2">
        <h2 className="text-[15px] font-semibold tracking-tight">Start from a template</h2>
        <p className="text-[12px] text-muted-foreground/60 mt-0.5">Pick how you want to describe this work.</p>
      </div>

      <div className="p-5 pt-3 grid grid-cols-2 gap-2.5">
        <TemplateCard
          title="Blank"
          hint="Start from an empty ticket."
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

      <div className="px-5 pb-4 flex items-center">
        <span className="text-[11px] text-muted-foreground/50">Templates live in Settings → Templates.</span>
        <Button variant="ghost" size="sm" className="ml-auto h-7 text-[12px]" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function TemplateCard({ title, hint, icon, onClick }: { title: string; hint: string; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group text-left rounded-xl border border-border/50 bg-card/50 hover:bg-muted/30 hover:border-border p-3.5 transition-all cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
    >
      <div className="flex items-center gap-2 mb-1.5">
        {icon}
        <span className="text-[13px] font-semibold tracking-tight">{title}</span>
      </div>
      <p className="text-[11.5px] text-muted-foreground/70 line-clamp-2 leading-relaxed">{hint}</p>
    </button>
  );
}

function summarise(body: string): string {
  const clean = (body || '').replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Empty template.';
  return clean.length > 120 ? `${clean.slice(0, 117)}…` : clean;
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
  titleRef,
  showBack,
  onBack,
  onTitleChange,
  onBodyChange,
  onStatusChange,
  onSubmit,
  submitting,
}: {
  template: TicketTemplate | null;
  title: string;
  body: string;
  status: string;
  columns: TicketColumn[];
  titleRef: React.RefObject<HTMLInputElement | null>;
  showBack: boolean;
  onBack: () => void;
  onTitleChange: (v: string) => void;
  onBodyChange: (v: string) => void;
  onStatusChange: (v: string) => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  const onBodyKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSubmit();
    }
  };
  const onTitleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-4 pb-3 flex items-center gap-2 border-b border-border/40">
        {showBack && (
          <Button variant="ghost" size="sm" className="h-6 px-1.5 -ml-1.5 text-muted-foreground/60" onClick={onBack}>
            <ArrowLeft className="h-3.5 w-3.5 mr-1" />
            Templates
          </Button>
        )}
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground/60 font-medium">
          {template ? `New ticket · ${template.name}` : 'New ticket'}
        </span>
        <div className="ml-auto">
          <Select value={status} onValueChange={onStatusChange}>
            <SelectTrigger size="sm" className="h-7 text-[12px] min-w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {columns.map((c) => (
                <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="px-5 pt-4">
        <input
          ref={titleRef as React.RefObject<HTMLInputElement>}
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          onKeyDown={onTitleKey}
          placeholder="Ticket title"
          className="w-full text-[22px] font-semibold tracking-tight bg-transparent border-0 outline-none focus:ring-0 placeholder:text-muted-foreground/30 py-1"
        />
      </div>

      <div className="px-5 pb-4 pt-2 flex-1 min-h-0">
        <textarea
          value={body}
          onChange={(e) => onBodyChange(e.target.value)}
          onKeyDown={onBodyKey}
          placeholder={"Description, acceptance criteria, notes…\n\nMarkdown supported. Reference agents with @slug."}
          rows={12}
          className="w-full text-[13px] leading-relaxed bg-background/40 border border-border/40 rounded-lg px-3.5 py-3 outline-none focus-visible:border-border focus-visible:ring-2 focus-visible:ring-primary/20 resize-none font-mono placeholder:text-muted-foreground/30"
        />
      </div>

      <div className="px-5 pb-4 pt-2 border-t border-border/40 flex items-center gap-3">
        <span className="text-[11px] text-muted-foreground/50">
          <kbd className="inline-flex items-center justify-center min-w-[18px] h-4 px-1 rounded border border-border/50 bg-muted/40 text-[10px] font-mono leading-none">⌘</kbd>
          <kbd className="inline-flex items-center justify-center min-w-[18px] h-4 px-1 ml-0.5 rounded border border-border/50 bg-muted/40 text-[10px] font-mono leading-none">↵</kbd>
          <span className="ml-1.5">to create</span>
        </span>
        <Button
          size="sm"
          className="ml-auto h-7.5 px-3.5 text-[12px]"
          onClick={onSubmit}
          disabled={!title.trim() || submitting}
        >
          {submitting ? 'Creating…' : 'Create ticket'}
        </Button>
      </div>
    </div>
  );
}
