'use client';

import { useMemo, useState } from 'react';
import { Brain, ChevronRight, Globe, Loader2, Search, Terminal } from 'lucide-react';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { AcpToolCallCard, acpToolName } from './acp-tool-call-card';
import { BasicTool } from './tool-renderers';
import {
  acpContextGroupSummary,
  type AcpMessageItem,
  type AcpToolItem,
} from './acp-turn-grouping';

/**
 * Consecutive `thought` messages folded into one collapsible card — ACP's
 * counterpart to main's `GroupedReasoningCard`. ACP thought chunks carry no
 * start/end timing, so this shows a live pulse while streaming instead of a
 * duration readout.
 */
export function AcpGroupedReasoningCard({
  items,
  isStreaming,
}: {
  items: AcpMessageItem[];
  isStreaming: boolean;
}) {
  const [open, setOpen] = useState(false);

  const preview = useMemo(() => {
    for (const item of items) {
      const text = item.text.trim();
      if (!text) continue;
      const boldMatch = text.match(/\*\*(.+?)\*\*/);
      if (boldMatch) return boldMatch[1];
      const firstLine = text.split('\n')[0].replace(/^#+\s*/, '');
      return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
    }
    return '';
  }, [items]);

  const nonEmpty = useMemo(() => items.filter((item) => item.text.trim()), [items]);
  if (nonEmpty.length === 0) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <div
          className={cn(
            'flex items-center gap-1.5 py-0.5',
            'cursor-pointer text-xs select-none',
            'text-muted-foreground/70',
            'group/reasoning max-w-full transition-colors',
          )}
        >
          <Brain
            className={cn(
              'text-muted-foreground/50 size-3.5 flex-shrink-0',
              isStreaming && 'animate-pulse-heartbeat',
            )}
          />
          <span className="min-w-0 flex-1 truncate">{preview || 'Thinking'}</span>
          {isStreaming && (
            <Loader2 className="text-muted-foreground/40 size-3 flex-shrink-0 animate-spin" />
          )}
          <ChevronRight
            className={cn(
              'size-3 flex-shrink-0 transition-transform',
              'text-muted-foreground/30 opacity-0 group-hover/reasoning:opacity-100',
              open && 'rotate-90 opacity-100',
            )}
          />
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-border/30 mt-0.5 mb-1.5 ml-[7px] border-l pl-3">
          <div className="text-muted-foreground/50 [&_.kortix-markdown_div]:!text-muted-foreground/50 [&_.kortix-markdown_li]:!text-muted-foreground/50 [&_.kortix-markdown_strong]:!text-muted-foreground/60 [&_.kortix-markdown_em]:!text-muted-foreground/60 space-y-2 [&_.kortix-markdown]:italic [&_.kortix-markdown_div]:!text-xs [&_.kortix-markdown_div]:!leading-[1.5] [&_.kortix-markdown_li]:!text-xs [&_.kortix-markdown_li]:!leading-[1.5]">
            {nonEmpty.map((item) => (
              <div key={item.id}>
                <UnifiedMarkdown content={item.text} isStreaming={false} />
              </div>
            ))}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * 2+ consecutive same-bucket tool calls folded into one collapsible pile —
 * ACP's counterpart to main's `SameToolGroup`. `__context__` (read/glob/grep/
 * list) renders compact one-liners; `__shell__` (bash) and everything else
 * render each call's full `AcpToolCallCard` so real output stays visible.
 */
export function AcpSameToolGroup({
  groupKind,
  items,
  sessionId,
}: {
  groupKind: string;
  items: AcpToolItem[];
  sessionId: string;
}) {
  const [open, setOpen] = useState(false);

  const anyRunning = useMemo(
    () => items.some((item) => item.status === 'in_progress' || item.status === 'running'),
    [items],
  );

  const isContext = groupKind === '__context__';
  const isShell = groupKind === '__shell__';

  const headerLabel = useMemo(() => {
    if (isContext) {
      const summary = acpContextGroupSummary(items);
      const prefix = anyRunning ? 'Gathering context' : 'Gathered context';
      return summary ? `${prefix} · ${summary}` : prefix;
    }
    if (isShell) {
      return anyRunning ? `Running ${items.length} commands` : `Ran ${items.length} commands`;
    }
    const title = groupKind.charAt(0).toUpperCase() + groupKind.slice(1).replace(/_/g, ' ');
    return `${title} · ${items.length}x`;
  }, [isContext, isShell, groupKind, items, anyRunning]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <div
          className={cn(
            'flex items-center gap-1.5 py-0.5',
            'cursor-pointer text-xs select-none',
            'text-muted-foreground/70',
            'group/grp max-w-full transition-colors',
          )}
        >
          {isShell ? (
            <Terminal className={cn('text-muted-foreground/50 size-3.5 flex-shrink-0', anyRunning && 'animate-pulse-heartbeat')} />
          ) : isContext ? (
            <Search className={cn('text-muted-foreground/50 size-3.5 flex-shrink-0', anyRunning && 'animate-pulse-heartbeat')} />
          ) : (
            <Globe className={cn('text-muted-foreground/50 size-3.5 flex-shrink-0', anyRunning && 'animate-pulse-heartbeat')} />
          )}
          <span className="min-w-0 flex-1 truncate">{headerLabel}</span>
          {anyRunning && <Loader2 className="text-muted-foreground/40 size-3 flex-shrink-0 animate-spin" />}
          <ChevronRight
            className={cn(
              'size-3 flex-shrink-0 transition-transform',
              'text-muted-foreground/30 opacity-0 group-hover/grp:opacity-100',
              open && 'rotate-90 opacity-100',
            )}
          />
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-border/30 mt-0.5 mb-1.5 ml-[7px] space-y-0.5 border-l pl-3">
          {isContext
            ? items.map((item) => {
                const running = item.status === 'in_progress' || item.status === 'running';
                return (
                  <div
                    key={item.id}
                    className="text-muted-foreground/60 flex min-w-0 items-center gap-1.5 py-0.5 text-xs"
                  >
                    <span className="flex-shrink-0">{acpToolName(item)}</span>
                    {!running && item.title && (
                      <span className="min-w-0 flex-1 truncate font-mono opacity-70" title={item.title}>
                        {item.title}
                      </span>
                    )}
                    {running && <Loader2 className="text-muted-foreground/40 size-2.5 flex-shrink-0 animate-spin" />}
                  </div>
                );
              })
            : items.map((item) => (
                <div key={item.id}>
                  <AcpToolCallCard tool={item} sessionId={sessionId} compact />
                </div>
              ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Unknown ACP `session/update` methods (or anything the projection couldn't
 *  classify) — rendered with the same tool-card chrome as every other tool
 *  instead of a raw `<details><pre>` dump. */
export function AcpUnknownMethodCard({ method, data }: { method: string; data: unknown }) {
  return (
    <BasicTool icon={<Terminal />} trigger={{ title: method }}>
      <pre className="text-muted-foreground overflow-x-auto px-3 py-2 text-xs">
        {JSON.stringify(data, null, 2)}
      </pre>
    </BasicTool>
  );
}
