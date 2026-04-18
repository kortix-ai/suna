'use client';

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
import {
  useCreateTicket,
  useTemplates,
  type TicketColumn,
} from '@/hooks/kortix/use-kortix-tickets';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  columns: TicketColumn[];
  defaultStatus?: string;
}

// Radix SelectItem disallows empty string as value (reserved for "clear selection"),
// so the "no template" entry uses this sentinel. When we submit we map it back to null.
const BLANK_TEMPLATE_ID = '__blank';
const BLANK_TEMPLATE = { id: BLANK_TEMPLATE_ID, name: 'Blank', body_md: '' };

export function NewTicketDialog({ open, onOpenChange, projectId, columns, defaultStatus }: Props) {
  const { data: templates } = useTemplates(projectId);
  const allTemplates = useMemo(() => [BLANK_TEMPLATE, ...(templates ?? [])], [templates]);
  const create = useCreateTicket();

  const [templateId, setTemplateId] = useState<string>(BLANK_TEMPLATE_ID);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [status, setStatus] = useState<string>('');
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setBody('');
    setTemplateId(BLANK_TEMPLATE_ID);
    setStatus(defaultStatus || columns[0]?.key || '');
    setTimeout(() => titleRef.current?.focus(), 40);
    // Fire once when opening — reading defaultStatus/columns at that moment
    // is the desired behaviour. Re-running when columns ref changes would
    // wipe the user's input on every parent re-render (polling).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const applyTemplate = (id: string) => {
    setTemplateId(id);
    const t = allTemplates.find((x) => x.id === id);
    if (t) setBody(t.body_md);
  };

  const submit = () => {
    if (!title.trim()) return;
    create.mutate({
      project_id: projectId,
      title: title.trim(),
      body_md: body,
      status: status || undefined,
      template_id: templateId && templateId !== BLANK_TEMPLATE_ID ? templateId : null,
    }, {
      onSuccess: () => {
        onOpenChange(false);
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0 overflow-hidden">
        <DialogTitle className="sr-only">New ticket</DialogTitle>
        <DialogDescription className="sr-only">Create a new ticket</DialogDescription>

        <div className="px-5 pt-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground/60 font-medium">New ticket</span>
            <div className="ml-auto flex items-center gap-2">
              <Select value={templateId} onValueChange={applyTemplate}>
                <SelectTrigger size="sm" className="h-7 text-[12px] w-[140px]">
                  <SelectValue placeholder="Template" />
                </SelectTrigger>
                <SelectContent>
                  {allTemplates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger size="sm" className="h-7 text-[12px] w-[140px]">
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

          <input
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Ticket title"
            className="w-full text-xl font-semibold tracking-tight bg-transparent border-0 outline-none focus:ring-0 placeholder:text-muted-foreground/40"
          />

          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={`Description, acceptance criteria, notes…\nMarkdown supported. Reference agents with @slug.`}
            rows={10}
            className="mt-3 w-full text-[13px] leading-relaxed bg-transparent border-0 outline-none focus:ring-0 resize-none font-mono placeholder:text-muted-foreground/40"
          />

          <div className="flex items-center gap-2 py-3 border-t border-border/50 mt-2">
            <span className="text-[11px] text-muted-foreground/40 ml-1">⌘↵ to create</span>
            <Button
              size="sm"
              className="ml-auto h-7 px-3 text-[12px]"
              onClick={submit}
              disabled={!title.trim() || create.isPending}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}
            >
              Create ticket
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
