'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from '@/i18n/use-translations';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { useSessionStateStore } from '@kortix/sdk/react';
import { CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react';
import { allDescendantIds, childMapByParent, formatCost, getSessionCost, type AssistantMessage, type Message, type ModelPricingLookup, type Part, type Session } from '@kortix/sdk';

// ============================================================================
// Sub-session aggregate types & helpers
// ============================================================================

interface SubSessionCostInfo {
  id: string;
  title: string;
  cost: number;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  children: SubSessionCostInfo[];
}

/**
 * Compute cost info for a sub-session from its raw messages in the sync store.
 */
export function computeSubSessionCost(
  sessionId: string,
  title: string,
  storeMessages: Record<string, Message[]>,
  storeParts: Record<string, Part[]>,
  childMap: Map<string, string[]>,
  allSessions: Session[],
  pricingLookup: ModelPricingLookup,
): SubSessionCostInfo {
  const msgs = storeMessages[sessionId] ?? [];
  const cost = getSessionCost(
    msgs.map((info) => ({ info, parts: storeParts[info.id] ?? [] })),
    pricingLookup,
  );

  // Sum tokens across all assistant messages (cumulative, not just last)
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const msg of msgs) {
    if (msg.role !== 'assistant') continue;
    const t = (msg as AssistantMessage).tokens;
    if (!t) continue;
    inputTokens += t.input ?? 0;
    outputTokens += t.output ?? 0;
    reasoningTokens += t.reasoning ?? 0;
    cacheReadTokens += t.cache?.read ?? 0;
    cacheWriteTokens += t.cache?.write ?? 0;
  }

  const directChildren = childMap.get(sessionId) ?? [];
  const children = directChildren.map((childId) => {
    const childSession = allSessions.find((s) => s.id === childId);
    return computeSubSessionCost(
      childId,
      childSession?.title ?? childId.slice(0, 12),
      storeMessages,
      storeParts,
      childMap,
      allSessions,
      pricingLookup,
    );
  });

  return {
    id: sessionId,
    title,
    cost,
    messages: msgs.length,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    children,
  };
}

/**
 * Recursively sum all costs from a SubSessionCostInfo tree.
 */
export function sumTreeCosts(node: SubSessionCostInfo): {
  cost: number;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} {
  let cost = node.cost;
  let messages = node.messages;
  let inputTokens = node.inputTokens;
  let outputTokens = node.outputTokens;
  let reasoningTokens = node.reasoningTokens;
  let cacheReadTokens = node.cacheReadTokens;
  let cacheWriteTokens = node.cacheWriteTokens;
  for (const child of node.children) {
    const sub = sumTreeCosts(child);
    cost += sub.cost;
    messages += sub.messages;
    inputTokens += sub.inputTokens;
    outputTokens += sub.outputTokens;
    reasoningTokens += sub.reasoningTokens;
    cacheReadTokens += sub.cacheReadTokens;
    cacheWriteTokens += sub.cacheWriteTokens;
  }
  return {
    cost,
    messages,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

// ============================================================================
// Sub-session tree component
// ============================================================================

function SubSessionTreeNode({
  node,
  depth = 0,
  messagesSuffix,
}: {
  node: SubSessionCostInfo;
  depth?: number;
  messagesSuffix: string;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const hasChildren = node.children.length > 0;

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
        <span className="text-foreground min-w-0 truncate font-medium">{node.title}</span>
        <span className="text-muted-foreground/60 ml-auto shrink-0 text-xs tabular-nums">
          {node.messages} {messagesSuffix}
        </span>
        <span className="text-muted-foreground shrink-0 tabular-nums">{formatCost(node.cost)}</span>
      </button>
      {expanded && hasChildren && (
        <div className="flex flex-col">
          {node.children.map((child) => (
            <SubSessionTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              messagesSuffix={messagesSuffix}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function SubSessionSection({ session, allSessions, pricingLookup, fmt }: {
  session: Session | undefined;
  allSessions: Session[] | undefined;
  pricingLookup: ModelPricingLookup;
  fmt: { number: (value: number | null | undefined) => string };
}) {
  const t = useTranslations('hardcodedUi.componentsSessionSessionContextModal');
  // ---- Sub-session aggregation ----
  const storeMessages = useSessionStateStore((s) => s.messages);
  const storeParts = useSessionStateStore((s) => s.parts);

  const childMap = useMemo(
    () => (allSessions ? childMapByParent(allSessions) : new Map<string, string[]>()),
    [allSessions],
  );

  const descendantIds = useMemo(
    () => (session ? allDescendantIds(childMap, session.id) : []),
    [childMap, session],
  );

  const hasSubSessions = descendantIds.length > 0;

  const subSessionTree = useMemo(() => {
    if (!session || !hasSubSessions || !allSessions) return null;
    return computeSubSessionCost(
      session.id,
      session.title ?? session.id,
      storeMessages,
      storeParts,
      childMap,
      allSessions,
      pricingLookup,
    );
  }, [session, hasSubSessions, allSessions, storeMessages, storeParts, childMap, pricingLookup]);

  const aggregateTotals = useMemo(
    () => (subSessionTree ? sumTreeCosts(subSessionTree) : null),
    [subSessionTree],
  );

  return hasSubSessions && subSessionTree && aggregateTotals ? (
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
        {subSessionTree.children.length > 0 && (
          <div className="border-t px-2 py-2">
            {subSessionTree.children.map((child) => (
              <SubSessionTreeNode
                key={child.id}
                node={child}
                messagesSuffix={t.raw('treeMessages')}
              />
            ))}
          </div>
        )}
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
