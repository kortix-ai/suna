'use client';

import { cn } from '@/lib/utils';
import { getSessionCost, formatCost, type AssistantMessage, type Message, type Part, type Session, type ModelPricingLookup } from '@kortix/sdk';
import { CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react';
import { useState } from 'react';

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

export function SubSessionTreeNode({
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
