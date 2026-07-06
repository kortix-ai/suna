'use client';

/**
 * One agent tool call, rendered as a tidy collapsible card: an icon + humanized
 * name + a one-line summary derived from the args, a live status indicator, and
 * (expanded) the input args + output.
 *
 * Takes a normalized `ToolView` from `@kortix/sdk/turns` (`classifyPart`'s tool
 * variant) instead of the raw wire tool part — status is already mapped to
 * 'pending'|'running'|'done'|'error', and the icon comes from `toolInfo`'s
 * `category` (a real registry keyed on tool name) instead of string-sniffing
 * the tool name (`t.includes('bash')` etc.).
 */

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { type ToolCategory, type ToolView, toolInfo } from '@kortix/sdk/turns';
import {
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  FileText,
  FolderSearch,
  Globe,
  Loader2,
  type LucideIcon,
  Pencil,
  Search,
  SquareTerminal,
  Wrench,
} from 'lucide-react';

const CATEGORY_ICON: Record<ToolCategory, LucideIcon> = {
  shell: SquareTerminal,
  files: FileText,
  edit: Pencil,
  search: FolderSearch,
  web: Globe,
  task: Bot,
  other: Wrench,
};

function summarize(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const i = input as Record<string, unknown>;
  const value =
    i.command ??
    i.filePath ??
    i.path ??
    i.file ??
    i.pattern ??
    i.query ??
    i.url ??
    i.description ??
    i.prompt ??
    '';
  return String(value ?? '')
    .split('\n')[0]
    .slice(0, 140);
}

function StatusDot({ status }: { status: ToolView['status'] }) {
  if (status === 'running' || status === 'pending')
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />;
  if (status === 'error') return <CircleAlert className="size-3.5 shrink-0 text-destructive" />;
  return <Check className="size-3.5 shrink-0 text-emerald-500" />;
}

export function ToolCall({ tool }: { tool: ToolView }) {
  const { category } = toolInfo(tool.name);
  const Icon = CATEGORY_ICON[category] ?? Wrench;
  const summary = summarize(tool.input);
  const output = tool.output ?? tool.error;

  const hasDetail = !!summary || !!output || (tool.input && Object.keys(tool.input).length > 0);

  return (
    <Collapsible className="rounded-lg border border-border bg-card/50">
      <CollapsibleTrigger
        disabled={!hasDetail}
        className="group flex w-full items-center gap-2 px-2.5 py-2 text-left disabled:cursor-default"
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-xs font-medium text-foreground">{tool.title}</span>
        {summary && (
          <span className="truncate font-mono text-xs text-muted-foreground">{summary}</span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <StatusDot status={tool.status} />
          {hasDetail && (
            <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          )}
        </span>
      </CollapsibleTrigger>
      {hasDetail && (
        <CollapsibleContent>
          <div className="space-y-2 border-t border-border px-2.5 py-2">
            {tool.input && Object.keys(tool.input).length > 0 && (
              <pre className="max-h-48 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[0.7rem] leading-relaxed text-muted-foreground scrollbar-thin">
                {JSON.stringify(tool.input, null, 2)}
              </pre>
            )}
            {output && (
              <pre
                className={cn(
                  'max-h-72 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[0.7rem] leading-relaxed scrollbar-thin',
                  tool.status === 'error' ? 'text-destructive' : 'text-foreground/80',
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
