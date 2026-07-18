'use client';

import { memo, useMemo } from 'react';
import { Brain, CircleHelp, Globe, Loader2, Search, Terminal } from 'lucide-react';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { cn } from '@/lib/utils';
import { AcpToolCallCard, acpToolName } from './acp-tool-call-card';
import { AcpTranscriptStep } from './acp-transcript-step';
import {
  acpContextGroupSummary,
  type AcpMessageItem,
  type AcpToolItem,
} from './acp-turn-grouping';

/**
 * Consecutive `thought` messages folded into one collapsible step — ACP's
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
    <AcpTranscriptStep
      icon={
        <Brain
          className={cn(
            'text-muted-foreground/50 size-3.5',
            isStreaming && 'animate-pulse-heartbeat',
          )}
        />
      }
      label={preview || 'Thinking'}
      running={isStreaming}
    >
      <div className="text-muted-foreground/50 [&_.kortix-markdown_div]:!text-muted-foreground/50 [&_.kortix-markdown_li]:!text-muted-foreground/50 [&_.kortix-markdown_strong]:!text-muted-foreground/60 [&_.kortix-markdown_em]:!text-muted-foreground/60 space-y-2 [&_.kortix-markdown]:italic [&_.kortix-markdown_div]:!text-xs [&_.kortix-markdown_div]:!leading-[1.5] [&_.kortix-markdown_li]:!text-xs [&_.kortix-markdown_li]:!leading-[1.5]">
        {nonEmpty.map((item) => (
          <div key={item.id}>
            <UnifiedMarkdown content={item.text} isStreaming={false} />
          </div>
        ))}
      </div>
    </AcpTranscriptStep>
  );
});

/**
 * 2+ consecutive same-bucket tool calls folded into one collapsible step —
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

  const Icon = isShell ? Terminal : isContext ? Search : Globe;

  return (
    <AcpTranscriptStep
      icon={
        <Icon
          className={cn(
            'text-muted-foreground/50 size-3.5',
            anyRunning && 'animate-pulse-heartbeat',
          )}
        />
      }
      label={headerLabel}
      running={anyRunning}
    >
      {isContext ? (
        <div className="space-y-0.5">
          {items.map((item) => {
            const running = item.status === 'in_progress' || item.status === 'running';
            return (
              <div
                key={item.id}
                className="text-muted-foreground/60 flex min-w-0 items-center gap-1.5 py-0.5 text-xs"
              >
                <span className="shrink-0">{acpToolName(item)}</span>
                {!running && item.title && (
                  <span className="min-w-0 flex-1 truncate font-mono opacity-70" title={item.title}>
                    {item.title}
                  </span>
                )}
                {running && (
                  <Loader2 className="text-muted-foreground/40 size-2.5 shrink-0 animate-spin" />
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="space-y-0.5">
          {items.map((item) => (
            <div key={item.id}>
              <AcpToolCallCard tool={item} sessionId={sessionId} compact />
            </div>
          ))}
        </div>
      )}
    </AcpTranscriptStep>
  );
});

/** Unknown ACP `session/update` methods (or anything the projection couldn't
 *  classify) — the same quiet transcript step as every other activity row,
 *  never a loud card and never a raw `JSON.stringify` dump. This is the ONLY
 *  renderer for a `raw` chat item: every raw frame surfaces inline in
 *  transcript order.
 *
 *  Friendly content up front (help icon + "Unrecognized agent event" + the
 *  method name on the trigger row), the wire payload one click away behind
 *  the step's own disclosure. Unknown frames never appear in the perf fixture
 *  (it only replays known methods), and the step body mounts nothing until
 *  opened, so this costs nothing on the hot path either way. */
export const AcpUnknownMethodCard = memo(function AcpUnknownMethodCard({
  method,
  data,
}: {
  method: string;
  data: unknown;
}) {
  return (
    <AcpTranscriptStep
      icon={<CircleHelp className="text-muted-foreground/50 size-3.5" />}
      label={
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0">Unrecognized agent event</span>
          <span className="text-muted-foreground/60 min-w-0 truncate font-mono" title={method}>
            {method}
          </span>
        </span>
      }
    >
      <pre className="text-muted-foreground overflow-x-auto text-xs">
        {JSON.stringify(data, null, 2)}
      </pre>
    </AcpTranscriptStep>
  );
});
