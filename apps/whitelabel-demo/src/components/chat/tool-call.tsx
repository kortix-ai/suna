'use client';

/**
 * One agent tool call, rendered as a tidy collapsible card: an icon + humanized
 * name + a one-line summary derived from the args, a live status indicator, and
 * (expanded) the input args + output. Generic over every opencode tool — we read
 * the well-known arg keys and fall back gracefully.
 */

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import {
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  FileText,
  FolderSearch,
  Globe,
  ListChecks,
  Loader2,
  Pencil,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

type AnyPart = Record<string, any>;

function meta(tool: string): { icon: LucideIcon; label: string } {
  const t = tool.toLowerCase();
  if (t.includes('bash') || t.includes('shell') || t.includes('exec')) return { icon: SquareTerminal, label: 'Terminal' };
  if (t.includes('webfetch') || t.includes('fetch') || t.includes('http')) return { icon: Globe, label: 'Fetch' };
  if (t.includes('glob') || t.includes('list') || t === 'ls') return { icon: FolderSearch, label: 'Find files' };
  if (t.includes('grep') || t.includes('search')) return { icon: Search, label: 'Search' };
  if (t.includes('edit') || t.includes('patch')) return { icon: Pencil, label: 'Edit' };
  if (t.includes('write') || t.includes('create')) return { icon: FileText, label: 'Write' };
  if (t.includes('read') || t.includes('view') || t.includes('cat')) return { icon: FileText, label: 'Read' };
  if (t.includes('todo')) return { icon: ListChecks, label: 'Plan' };
  if (t.includes('task') || t.includes('agent')) return { icon: Bot, label: 'Subagent' };
  return { icon: Wrench, label: tool.replace(/[._-]/g, ' ') };
}

function summarize(input: AnyPart | undefined): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as AnyPart;
  return (
    i.command ??
    i.filePath ??
    i.path ??
    i.file ??
    i.pattern ??
    i.query ??
    i.url ??
    i.description ??
    i.prompt ??
    ''
  )
    ?.toString()
    .split('\n')[0]
    .slice(0, 140);
}

function StatusDot({ status }: { status: string }) {
  if (status === 'running' || status === 'pending')
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />;
  if (status === 'error') return <CircleAlert className="size-3.5 shrink-0 text-destructive" />;
  return <Check className="size-3.5 shrink-0 text-emerald-500" />;
}

export function ToolCall({ part }: { part: AnyPart }) {
  const tool: string = part.tool ?? 'tool';
  const state: AnyPart = part.state ?? {};
  const status: string = state.status ?? 'completed';
  const { icon: Icon, label } = meta(tool);
  const summary = summarize(state.input);
  const output: string | undefined =
    typeof state.output === 'string' ? state.output : state.error ? String(state.error) : undefined;

  const hasDetail = !!summary || !!output || (state.input && Object.keys(state.input).length > 0);

  return (
    <Collapsible className="rounded-lg border border-border bg-card/50">
      <CollapsibleTrigger
        disabled={!hasDetail}
        className="group flex w-full items-center gap-2 px-2.5 py-2 text-left disabled:cursor-default"
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-xs font-medium text-foreground">{label}</span>
        {summary && (
          <span className="truncate font-mono text-xs text-muted-foreground">{summary}</span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <StatusDot status={status} />
          {hasDetail && (
            <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          )}
        </span>
      </CollapsibleTrigger>
      {hasDetail && (
        <CollapsibleContent>
          <div className="space-y-2 border-t border-border px-2.5 py-2">
            {state.input && Object.keys(state.input).length > 0 && (
              <pre className="max-h-48 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[0.7rem] leading-relaxed text-muted-foreground scrollbar-thin">
                {JSON.stringify(state.input, null, 2)}
              </pre>
            )}
            {output && (
              <pre
                className={cn(
                  'max-h-72 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[0.7rem] leading-relaxed scrollbar-thin',
                  status === 'error' ? 'text-destructive' : 'text-foreground/80',
                )}
              >
                {output.slice(0, 6000)}
              </pre>
            )}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
