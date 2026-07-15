'use client';

import { memo, useMemo, useState, type ReactNode } from 'react';
import { Brain, ChevronRight, Globe, Loader2, Search, Terminal } from 'lucide-react';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { cn } from '@/lib/utils';
import { AcpToolCallCard, acpToolName } from './acp-tool-call-card';
import { BasicTool } from './tool-renderers';
import {
  acpContextGroupSummary,
  type AcpMessageItem,
  type AcpToolItem,
} from './acp-turn-grouping';

/**
 * Lightweight collapsed-by-default disclosure for the transcript's grouped
 * "piles" (reasoning runs, same-tool runs). Deliberately NOT built on Radix
 * `Collapsible`: Radix schedules a mount-time `requestAnimationFrame` setState
 * (its mount-animation guard) that lands as an extra React commit per mounted
 * group. With one grouped pile per turn, that overflowed the transcript's
 * commit budget in the replay perf test (30 turns → 30 extra commits). A plain
 * `useState` toggle that renders the body only while open costs zero extra
 * commits and keeps the identical chevron affordance; the body appears
 * instantly rather than animating its height, which for a collapsed summary
 * pile reads as snappier, not worse.
 */
function GroupDisclosure({
  triggerClassName,
  renderTrigger,
  children,
}: {
  triggerClassName: string;
  renderTrigger: (open: boolean) => ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((value) => !value);
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        className={triggerClassName}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
          }
        }}
      >
        {renderTrigger(open)}
      </div>
      {open ? children : null}
    </div>
  );
}

/**
 * Consecutive `thought` messages folded into one collapsible card — ACP's
 * counterpart to main's `GroupedReasoningCard`. ACP thought chunks carry no
 * start/end timing, so this shows a live pulse while streaming instead of a
 * duration readout.
 */
export const AcpGroupedReasoningCard = memo(function AcpGroupedReasoningCard({
  items,
  isStreaming,
}: {
  items: AcpMessageItem[];
  isStreaming: boolean;
}) {
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
    <GroupDisclosure
      triggerClassName={cn(
        'flex items-center gap-1.5 py-0.5',
        'cursor-pointer text-xs select-none',
        'text-muted-foreground/70',
        'group/reasoning max-w-full transition-colors',
      )}
      renderTrigger={(open) => (
        <>
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
        </>
      )}
    >
      <div className="border-border/30 mt-0.5 mb-1.5 ml-[7px] border-l pl-3">
        <div className="text-muted-foreground/50 [&_.kortix-markdown_div]:!text-muted-foreground/50 [&_.kortix-markdown_li]:!text-muted-foreground/50 [&_.kortix-markdown_strong]:!text-muted-foreground/60 [&_.kortix-markdown_em]:!text-muted-foreground/60 space-y-2 [&_.kortix-markdown]:italic [&_.kortix-markdown_div]:!text-xs [&_.kortix-markdown_div]:!leading-[1.5] [&_.kortix-markdown_li]:!text-xs [&_.kortix-markdown_li]:!leading-[1.5]">
          {nonEmpty.map((item) => (
            <div key={item.id}>
              <UnifiedMarkdown content={item.text} isStreaming={false} />
            </div>
          ))}
        </div>
      </div>
    </GroupDisclosure>
  );
});

/**
 * 2+ consecutive same-bucket tool calls folded into one collapsible pile —
 * ACP's counterpart to main's `SameToolGroup`. `__context__` (read/glob/grep/
 * list) renders compact one-liners; `__shell__` (bash) and everything else
 * render each call's full `AcpToolCallCard` so real output stays visible.
 */
export const AcpSameToolGroup = memo(function AcpSameToolGroup({
  groupKind,
  items,
  sessionId,
}: {
  groupKind: string;
  items: AcpToolItem[];
  sessionId: string;
}) {
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
    <GroupDisclosure
      triggerClassName={cn(
        'flex items-center gap-1.5 py-0.5',
        'cursor-pointer text-xs select-none',
        'text-muted-foreground/70',
        'group/grp max-w-full transition-colors',
      )}
      renderTrigger={(open) => (
        <>
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
        </>
      )}
    >
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
    </GroupDisclosure>
  );
});

/** Unknown ACP `session/update` methods (or anything the projection couldn't
 *  classify) — rendered with the same tool-card chrome as every other tool
 *  instead of a raw `<details><pre>` dump. This is the ONLY renderer for a
 *  `raw` chat item now (the old per-turn "Protocol events (n)" Disclosure is
 *  gone): every raw frame surfaces inline in transcript order as its own
 *  card, mirroring how the grouping pipeline delegates a `raw` render item. */
export const AcpUnknownMethodCard = memo(function AcpUnknownMethodCard({ method, data }: { method: string; data: unknown }) {
  return (
    <BasicTool icon={<Terminal />} trigger={{ title: method }}>
      <pre className="text-muted-foreground overflow-x-auto px-3 py-2 text-xs">
        {JSON.stringify(data, null, 2)}
      </pre>
    </BasicTool>
  );
});
