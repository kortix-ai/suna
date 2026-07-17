'use client';

import { memo, useMemo, useState, type ReactNode } from 'react';
import { Brain, ChevronRight, CircleHelp, Globe, Loader2, Search, Terminal } from 'lucide-react';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { Collapsible, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { cn } from '@/lib/utils';
import { AcpToolCallCard, acpToolName } from './acp-tool-call-card';
import {
  acpContextGroupSummary,
  type AcpMessageItem,
  type AcpToolItem,
} from './acp-turn-grouping';

/**
 * Collapsed-by-default disclosure for the transcript's grouped "piles"
 * (reasoning runs, same-tool runs) — now built on the design-system's
 * `Collapsible` (Radix), the SAME primitive `BasicTool`'s inline tool-card
 * disclosure (`tool-renderers.tsx`) already uses, so both idioms share one
 * mechanism and one chevron feel.
 *
 * Deliberately still WITHOUT Radix's `CollapsibleContent`: that piece (not
 * `Collapsible`/`CollapsibleTrigger` themselves) is what schedules the
 * mount-time `requestAnimationFrame` setState (its exit-animation Presence
 * guard) that overflowed the transcript's commit budget in the replay perf
 * test when this disclosure was first built (WS3-era). `Collapsible`'s root
 * and `CollapsibleTrigger` are plain context/`Primitive.button` wrappers with
 * no RAF of their own — proven zero-cost already, since `BasicTool` mounts
 * one per rendered tool call in this same perf fixture. So: adopt the
 * design-system primitive for real (shared `data-state`/`aria-expanded`
 * semantics, one chevron rotation feel), keep rendering the body with a
 * plain `{open ? children : null}` conditional instead of the animated
 * `CollapsibleContent` — same zero-extra-commit mechanics as before, proven
 * again by `acp-session-perf.test.tsx`.
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
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          className={triggerClassName}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setOpen((value) => !value);
            }
          }}
        >
          {renderTrigger(open)}
        </div>
      </CollapsibleTrigger>
      {open ? children : null}
    </Collapsible>
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
        'max-w-full transition-colors',
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
          {/* Rest-visible chevron affordance (never `opacity-0` until hover):
              always `text-muted-foreground`, the only animated property is
              its rotation on open — one expand/collapse feel shared with the
              tool-card disclosure (`BasicTool`, `tool-renderers.tsx`). */}
          <ChevronRight
            className={cn(
              'text-muted-foreground/50 size-3 flex-shrink-0 transition-transform',
              open && 'rotate-90',
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
        'max-w-full transition-colors',
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
          {/* Same rest-visible chevron idiom as `AcpGroupedReasoningCard`. */}
          <ChevronRight
            className={cn(
              'text-muted-foreground/50 size-3 flex-shrink-0 transition-transform',
              open && 'rotate-90',
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
 *  classify) — a graceful card, not a raw `JSON.stringify` dump. This is the
 *  ONLY renderer for a `raw` chat item now (the old per-turn "Protocol
 *  events (n)" Disclosure is gone): every raw frame surfaces inline in
 *  transcript order as its own card, mirroring how the grouping pipeline
 *  delegates a `raw` render item.
 *
 *  Friendly content up front (icon tile + "Unrecognized agent event" +
 *  the method name), the wire payload one click away behind an "Advanced"
 *  disclosure — same row/tile/Advanced-disclosure language as
 *  `review-detail-modal.tsx`'s `Panel`/`AdvancedDisclosure`. Unknown frames
 *  never appear in the perf fixture (it only replays known methods), and
 *  `DisclosureContent` renders nothing until opened (`AnimatePresence`
 *  mounts no `motion.div` while closed), so this costs nothing on the hot
 *  path either way. */
export const AcpUnknownMethodCard = memo(function AcpUnknownMethodCard({ method, data }: { method: string; data: unknown }) {
  const [rawOpen, setRawOpen] = useState(false);
  return (
    <div className="bg-popover flex flex-col gap-2 rounded-md border px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-sm">
          <CircleHelp className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Unrecognized agent event</div>
          <div className="text-muted-foreground truncate font-mono text-xs">{method}</div>
        </div>
      </div>
      <Disclosure open={rawOpen} onOpenChange={setRawOpen}>
        <DisclosureTrigger>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground -mx-1 flex w-fit items-center gap-1 rounded px-1 py-0.5 text-xs transition-colors"
          >
            <ChevronRight className={cn('size-3 transition-transform', rawOpen && 'rotate-90')} />
            <span>Advanced</span>
          </button>
        </DisclosureTrigger>
        <DisclosureContent>
          <pre className="text-muted-foreground overflow-x-auto py-1 text-xs">
            {JSON.stringify(data, null, 2)}
          </pre>
        </DisclosureContent>
      </Disclosure>
    </div>
  );
});
