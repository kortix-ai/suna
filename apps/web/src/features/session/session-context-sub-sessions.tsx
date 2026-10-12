'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from '@/i18n/use-translations';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { useSessionLogThread, type SessionMessagesSource } from '@kortix/sdk/react';
import { CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react';
import { allDescendantIds, childMapByParent, formatCost, type ModelPricingLookup, type Session, type SessionLogMessage } from '@kortix/sdk';
import { isReply, messageCounts, sessionLogCost } from './session-context-metrics';

// ============================================================================
// Thread metrics
// ============================================================================

export interface ThreadMetrics {
  cost: number;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const NO_METRICS: ThreadMetrics = {
  cost: 0,
  messages: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** The cost, message count and token totals (every reply, not just the last) of one thread. */
export function threadMetrics(messages: SessionLogMessage[], pricingLookup: ModelPricingLookup): ThreadMetrics {
  const m: ThreadMetrics = { ...NO_METRICS, cost: sessionLogCost(messages, pricingLookup), messages: messageCounts(messages).all };
  for (const msg of messages) {
    const u = msg.usage;
    if (!isReply(msg) || !u) continue;
    m.inputTokens += u.input;
    m.outputTokens += u.output;
    m.reasoningTokens += u.reasoning ?? 0;
    m.cacheReadTokens += u.cache_read;
    m.cacheWriteTokens += u.cache_write;
  }
  return m;
}

export function sumMetrics(all: ThreadMetrics[]): ThreadMetrics {
  const sum = { ...NO_METRICS };
  for (const m of all) for (const k of Object.keys(sum) as Array<keyof ThreadMetrics>) sum[k] += m[k];
  return sum;
}

// ============================================================================
// Sub-session tree component
// ============================================================================

/**
 * One sub-agent's row: its thread's metrics, read through `useSessionLogThread`
 * (the sub-agent's runtime session id is its thread id), reported up for the
 * combined totals, and its own children under it.
 */
function SubSessionTreeNode({
  source,
  id,
  depth = 0,
  childMap,
  allSessions,
  pricingLookup,
  messagesSuffix,
  onMetrics,
}: {
  source: SessionMessagesSource;
  id: string;
  depth?: number;
  childMap: Map<string, string[]>;
  allSessions: Session[];
  pricingLookup: ModelPricingLookup;
  messagesSuffix: string;
  onMetrics: (id: string, metrics: ThreadMetrics) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const thread = useSessionLogThread(source, id);
  const metrics = useMemo(() => threadMetrics(thread?.messages ?? [], pricingLookup), [thread, pricingLookup]);
  useEffect(() => onMetrics(id, metrics), [onMetrics, id, metrics]);
  const title = allSessions.find((s) => s.id === id)?.title ?? id.slice(0, 12);
  const children = childMap.get(id) ?? [];
  const hasChildren = children.length > 0;

  return (
    <div className={cn('flex flex-col', depth > 0 && 'border-border/30 ml-4 border-l pl-3')}>
      <button
        onClick={() => hasChildren && setExpanded(!expanded)}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
          hasChildren && 'hover:bg-muted/40 cursor-pointer',
          !hasChildren && 'cursor-default',
        )}
      >
        {hasChildren ? (
          expanded ? (
            <CaretDownIcon className="text-muted-foreground size-3 shrink-0" />
          ) : (
            <CaretRightIcon className="text-muted-foreground size-3 shrink-0" />
          )
        ) : (
          <div className="size-3 shrink-0" />
        )}
        <span className="text-foreground min-w-0 truncate font-medium">{title}</span>
        <span className="text-muted-foreground/60 ml-auto shrink-0 text-xs tabular-nums">
          {metrics.messages} {messagesSuffix}
        </span>
        <span className="text-muted-foreground shrink-0 tabular-nums">{formatCost(metrics.cost)}</span>
      </button>
      {expanded && hasChildren && (
        <div className="flex flex-col">
          {children.map((childId) => (
            <SubSessionTreeNode
              key={childId}
              source={source}
              id={childId}
              depth={depth + 1}
              childMap={childMap}
              allSessions={allSessions}
              pricingLookup={pricingLookup}
              messagesSuffix={messagesSuffix}
              onMetrics={onMetrics}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function SubSessionSection({ source, session, allSessions, pricingLookup, fmt }: {
  /** The session whose log the root thread and each sub-agent's thread read. */
  source: SessionMessagesSource;
  session: Session | undefined;
  allSessions: Session[] | undefined;
  pricingLookup: ModelPricingLookup;
  fmt: { number: (value: number | null | undefined) => string };
}) {
  const t = useTranslations('hardcodedUi.componentsSessionSessionContextModal');
  const childMap = useMemo(
    () => (allSessions ? childMapByParent(allSessions) : new Map<string, string[]>()),
    [allSessions],
  );

  const descendantIds = useMemo(
    () => (session ? allDescendantIds(childMap, session.id) : []),
    [childMap, session],
  );

  const hasSubSessions = descendantIds.length > 0;

  // The root's own metrics here; each sub-agent row reports its thread's as it
  // renders, and the combined totals sum what is reported for the descendants
  // the tree holds now (a collapsed branch is not mounted, so its children
  // report nothing; the sub-agent rows up to the collapse point count).
  const root = useSessionLogThread(source);
  const rootMetrics = useMemo(() => threadMetrics(root?.messages ?? [], pricingLookup), [root, pricingLookup]);
  const [reported, setReported] = useState<Record<string, ThreadMetrics>>({});
  const onMetrics = useCallback((id: string, metrics: ThreadMetrics) => {
    setReported((prev) => (prev[id] === metrics ? prev : { ...prev, [id]: metrics }));
  }, []);
  const aggregateTotals = useMemo(
    () => sumMetrics([rootMetrics, ...descendantIds.flatMap((id) => reported[id] ?? [])]),
    [rootMetrics, descendantIds, reported],
  );

  return hasSubSessions && session && allSessions ? (
    <section className="space-y-3">
      <div className="space-y-1">
        <Label>{t.raw('subAgentsLabel')}</Label>
        <p className="text-muted-foreground text-xs">{t.raw('subAgentsNote')}</p>
      </div>
      <div className="bg-popover rounded-md border">
        <div className="grid grid-cols-2 gap-4 px-4 py-4 lg:grid-cols-4">
          <Stat label={t.raw('combinedCost')} value={formatCost(aggregateTotals.cost)} />
          <Stat
            label={t.raw('combinedMessages')}
            value={aggregateTotals.messages.toLocaleString()}
          />
          <Stat label={t.raw('tokensIn')} value={fmt.number(aggregateTotals.inputTokens)} />
          <Stat label={t.raw('tokensOut')} value={fmt.number(aggregateTotals.outputTokens)} />
        </div>
        <div className="border-t px-2 py-2">
          {(childMap.get(session.id) ?? []).map((childId) => (
            <SubSessionTreeNode
              key={childId}
              source={source}
              id={childId}
              childMap={childMap}
              allSessions={allSessions}
              pricingLookup={pricingLookup}
              messagesSuffix={t.raw('treeMessages')}
              onMetrics={onMetrics}
            />
          ))}
        </div>
      </div>
    </section>
  ) : null;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="text-foreground truncate text-xs font-medium tabular-nums">{value}</div>
    </div>
  );
}
