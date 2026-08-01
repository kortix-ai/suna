'use client';

import { useTranslations } from 'next-intl';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { ProviderListResponse } from '@kortix/sdk/react';
import { useModelPricingLookup } from '@/lib/model-pricing';
import { cn } from '@/lib/utils';
import type { MessageWithParts } from '@/ui/types';
import type { AssistantMessage, Message, Part, Session } from '@kortix/sdk';
import type { ModelPricingLookup } from '@kortix/sdk/turns';
import { allDescendantIds, childMapByParent, formatCost, getSessionCost } from '@kortix/sdk/turns';
import { useSessionStateStore } from '@kortix/sdk/react';
import {
  CheckIcon as Check,
  CaretDownIcon as ChevronDown,
  CaretRightIcon as ChevronRight,
  CopyIcon as Copy,
  NetworkIcon as Network,
} from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

// ============================================================================
// Context metrics — ported 1:1 from SolidJS session-context-metrics.ts
// ============================================================================

interface ContextMetrics {
  message: AssistantMessage;
  providerLabel: string;
  modelLabel: string;
  limit: number | undefined;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  usage: number | null;
}

interface Metrics {
  totalCost: number;
  context: ContextMetrics | undefined;
}

function tokenTotal(msg: AssistantMessage) {
  if (!msg.tokens) return 0;
  const t = msg.tokens;
  return (
    (t.input ?? 0) +
    (t.output ?? 0) +
    (t.reasoning ?? 0) +
    ((t.cache?.read ?? 0) + (t.cache?.write ?? 0))
  );
}

function getSessionContextMetrics(
  messages: MessageWithParts[],
  providers: ProviderListResponse | undefined,
  pricingLookup: ModelPricingLookup,
): Metrics {
  const totalCost = getSessionCost(messages, pricingLookup);
  const rawMessages = messages.map((m) => m.info);

  // Find last assistant with tokens
  let last: AssistantMessage | undefined;
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const msg = rawMessages[i];
    if (msg.role !== 'assistant') continue;
    if (tokenTotal(msg) <= 0) continue;
    last = msg;
    break;
  }
  if (!last) return { totalCost, context: undefined };

  const provider = (providers as any)?.all?.find((p: any) => p.id === last!.providerID);
  const model = provider?.models?.[last.modelID] as any;
  const limit = model?.limit?.context as number | undefined;
  const total = tokenTotal(last);

  return {
    totalCost,
    context: {
      message: last,
      providerLabel: (provider as any)?.name ?? last.providerID,
      modelLabel: model?.name ?? last.modelID,
      limit,
      input: last.tokens?.input ?? 0,
      output: last.tokens?.output ?? 0,
      reasoning: last.tokens?.reasoning ?? 0,
      cacheRead: last.tokens?.cache?.read ?? 0,
      cacheWrite: last.tokens?.cache?.write ?? 0,
      total,
      usage: limit ? Math.round((total / limit) * 100) : null,
    },
  };
}

// ============================================================================
// Context breakdown — ported 1:1 from SolidJS session-context-breakdown.ts
// ============================================================================

type BreakdownKey = 'system' | 'user' | 'assistant' | 'tool' | 'other';

interface BreakdownSegment {
  key: BreakdownKey;
  tokens: number;
  width: number;
  percent: number;
}

const BREAKDOWN_COLORS: Record<BreakdownKey, string> = {
  system: 'var(--color-blue-400)', // blue
  user: 'var(--color-emerald-400)', // green
  assistant: 'var(--color-violet-400)', // purple
  tool: 'var(--color-amber-400)', // yellow
  other: 'var(--color-muted-foreground)', // gray
};

const BREAKDOWN_LABELS: Record<BreakdownKey, string> = {
  system: 'System',
  user: 'User',
  assistant: 'Assistant',
  tool: 'Tool',
  other: 'Other',
};

function estimateTokens(chars: number) {
  return Math.ceil(chars / 4);
}

function estimateBreakdown(
  messages: MessageWithParts[],
  input: number,
  systemPrompt?: string,
): BreakdownSegment[] {
  if (!input) return [];

  const counts = messages.reduce(
    (acc, msg) => {
      if (msg.info.role === 'user') {
        const user = msg.parts.reduce((sum, part) => {
          if (part.type === 'text') return sum + (part as any).text.length;
          if (part.type === 'file') return sum + ((part as any).source?.text?.value?.length ?? 0);
          if (part.type === 'agent') return sum + ((part as any).source?.value?.length ?? 0);
          return sum;
        }, 0);
        return { ...acc, user: acc.user + user };
      }
      if (msg.info.role !== 'assistant') return acc;
      const result = msg.parts.reduce(
        (sum, part) => {
          if (part.type === 'text')
            return { assistant: sum.assistant + (part as any).text.length, tool: sum.tool };
          if (part.type === 'reasoning')
            return { assistant: sum.assistant + (part as any).text.length, tool: sum.tool };
          if (part.type === 'tool') {
            const state = (part as any).state;
            const inputLen = Object.keys(state?.input ?? {}).length * 16;
            let toolLen = inputLen;
            if (state?.status === 'pending') toolLen += state.raw?.length ?? 0;
            else if (state?.status === 'completed') toolLen += state.output?.length ?? 0;
            else if (state?.status === 'error') toolLen += state.error?.length ?? 0;
            return { assistant: sum.assistant, tool: sum.tool + toolLen };
          }
          return sum;
        },
        { assistant: 0, tool: 0 },
      );
      return { ...acc, assistant: acc.assistant + result.assistant, tool: acc.tool + result.tool };
    },
    { system: systemPrompt?.length ?? 0, user: 0, assistant: 0, tool: 0 },
  );

  const tokens = {
    system: estimateTokens(counts.system),
    user: estimateTokens(counts.user),
    assistant: estimateTokens(counts.assistant),
    tool: estimateTokens(counts.tool),
  };
  const estimated = tokens.system + tokens.user + tokens.assistant + tokens.tool;

  const buildSegments = (t: Record<string, number>, inp: number) => {
    return (['system', 'user', 'assistant', 'tool', 'other'] as BreakdownKey[])
      .filter((k) => (t[k] ?? 0) > 0)
      .map((k) => ({
        key: k,
        tokens: t[k] ?? 0,
        width: ((t[k] ?? 0) / inp) * 100,
        percent: Math.round(((t[k] ?? 0) / inp) * 1000) / 10,
      }));
  };

  if (estimated <= input) {
    return buildSegments({ ...tokens, other: input - estimated }, input);
  }
  const scale = input / estimated;
  const scaled = {
    system: Math.floor(tokens.system * scale),
    user: Math.floor(tokens.user * scale),
    assistant: Math.floor(tokens.assistant * scale),
    tool: Math.floor(tokens.tool * scale),
  };
  const total = scaled.system + scaled.user + scaled.assistant + scaled.tool;
  return buildSegments({ ...scaled, other: Math.max(0, input - total) }, input);
}

// ============================================================================
// Formatter — ported 1:1 from SolidJS session-context-format.ts
// ============================================================================

function createFormatter(locale = 'en-US') {
  return {
    number(value: number | null | undefined) {
      if (value === undefined || value === null) return '—';
      return value.toLocaleString(locale);
    },
    percent(value: number | null | undefined) {
      if (value === undefined || value === null) return '—';
      return value.toLocaleString(locale) + '%';
    },
    time(value: number | undefined) {
      if (!value) return '—';
      return new Date(value).toLocaleString(locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    },
  };
}

// ============================================================================
// Stat component
// ============================================================================

function Stat({ label, value }: { label: string; value: string | React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="text-foreground text-xs font-medium tabular-nums">{value}</div>
    </div>
  );
}

// ============================================================================
// Raw message accordion item
// ============================================================================

function RawMessage({
  message,
  parts,
  formatTime,
}: {
  message: Message;
  parts: Part[];
  formatTime: (v: number | undefined) => string;
}) {
  return (
    <AccordionItem value={message.id}>
      <AccordionTrigger className="hover:bg-muted/40 rounded-md px-3 py-2 text-xs hover:no-underline">
        <div className="flex w-full items-center justify-between gap-2 pr-2">
          <div className="min-w-0 truncate font-mono">
            <Badge
              variant={message.role === 'user' ? 'info' : 'success'}
              size="sm"
              className="mr-2 font-semibold uppercase"
            >
              {message.role}
            </Badge>
            <span className="text-muted-foreground">{message.id}</span>
          </div>
          <div className="text-muted-foreground/60 shrink-0 text-xs">
            {formatTime(message.time?.created)}
          </div>
        </div>
      </AccordionTrigger>
      <AccordionContent className="px-3 pb-2">
        <pre className="bg-muted/40 max-h-[400px] overflow-x-auto overflow-y-auto rounded-2xl p-3 font-mono text-xs break-all whitespace-pre-wrap select-text">
          {JSON.stringify({ message, parts }, null, 2)}
        </pre>
      </AccordionContent>
    </AccordionItem>
  );
}

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
function computeSubSessionCost(
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
function sumTreeCosts(node: SubSessionCostInfo): {
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

function SubSessionTreeNode({ node, depth = 0 }: { node: SubSessionCostInfo; depth?: number }) {
  const [expanded, setExpanded] = useState(depth < 1);
  const hasChildren = node.children.length > 0;
  const totals = useMemo(() => sumTreeCosts(node), [node]);

  return (
    <div className={cn('flex flex-col', depth > 0 && 'border-border/30 ml-4 border-l pl-3')}>
      <button
        onClick={() => hasChildren && setExpanded(!expanded)}
        className={cn(
          'flex w-full items-center gap-2 py-1.5 text-left text-xs',
          hasChildren && 'hover:bg-muted/40 -mx-1.5 cursor-pointer rounded-md px-1.5',
          !hasChildren && 'cursor-default',
        )}
      >
        {hasChildren ? (
          expanded ? (
            <ChevronDown className="text-muted-foreground size-3 shrink-0" />
          ) : (
            <ChevronRight className="text-muted-foreground size-3 shrink-0" />
          )
        ) : (
          <div className="size-3 shrink-0" />
        )}
        <span className="text-foreground min-w-0 truncate font-medium">{node.title}</span>
        <span className="text-muted-foreground ml-auto shrink-0 tabular-nums">
          {formatCost(node.cost)}
        </span>
        {hasChildren && (
          <span className="text-muted-foreground/50 shrink-0 text-xs tabular-nums">
            (tree: {formatCost(totals.cost)})
          </span>
        )}
        <span className="text-muted-foreground/60 shrink-0 text-xs">{node.messages} msgs</span>
      </button>
      {expanded && hasChildren && (
        <div className="flex flex-col">
          {node.children.map((child) => (
            <SubSessionTreeNode key={child.id} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Main modal component
// ============================================================================

interface SessionContextModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messages: MessageWithParts[] | undefined;
  session: Session | undefined;
  providers: ProviderListResponse | undefined;
  allSessions?: Session[];
}

export function SessionContextModal({
  open,
  onOpenChange,
  messages,
  session,
  providers,
  allSessions,
}: SessionContextModalProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [copiedAll, setCopiedAll] = useState(false);
  const pricingLookup = useModelPricingLookup(providers);

  const rawMessages = useMemo(() => (messages ?? []).map((m) => m.info), [messages]);

  const metrics = useMemo(
    () => getSessionContextMetrics(messages ?? [], providers, pricingLookup),
    [messages, providers, pricingLookup],
  );

  const ctx = metrics.context;
  const fmt = useMemo(() => createFormatter(), []);

  const counts = useMemo(() => {
    const all = rawMessages;
    const user = all.filter((m) => m.role === 'user').length;
    const assistant = all.filter((m) => m.role === 'assistant').length;
    return { all: all.length, user, assistant };
  }, [rawMessages]);

  const breakdown = useMemo(() => {
    if (!ctx?.input || !messages) return [];
    return estimateBreakdown(messages, ctx.input);
  }, [ctx?.input, messages]);

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

  const aggregateTotals = useMemo(() => {
    if (!subSessionTree) return null;
    return sumTreeCosts(subSessionTree);
  }, [subSessionTree]);

  const stats = useMemo(
    () => [
      { label: 'Session', value: session?.title ?? session?.id ?? '—' },
      { label: 'Messages', value: counts.all.toLocaleString() },
      { label: 'Provider', value: ctx?.providerLabel ?? '—' },
      { label: 'Model', value: ctx?.modelLabel ?? '—' },
      { label: 'Context Limit', value: fmt.number(ctx?.limit) },
      { label: 'Total Tokens', value: fmt.number(ctx?.total) },
      { label: 'Usage', value: fmt.percent(ctx?.usage) },
      { label: 'Input Tokens', value: fmt.number(ctx?.input) },
      { label: 'Output Tokens', value: fmt.number(ctx?.output) },
      { label: 'Reasoning Tokens', value: fmt.number(ctx?.reasoning) },
      {
        label: 'Cache Tokens',
        value: `${fmt.number(ctx?.cacheRead)} / ${fmt.number(ctx?.cacheWrite)}`,
      },
      { label: 'User Messages', value: counts.user.toLocaleString() },
      { label: 'Assistant Messages', value: counts.assistant.toLocaleString() },
      { label: 'Total Cost', value: formatCost(metrics.totalCost) },
      { label: 'Session Created', value: fmt.time(session?.time?.created) },
      { label: 'Last Activity', value: fmt.time(ctx?.message?.time?.created) },
    ],
    [session, counts, ctx, fmt, metrics.totalCost],
  );

  const handleCopyAll = () => {
    navigator.clipboard.writeText(JSON.stringify(messages, null, 2));
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] max-w-4xl flex-col overflow-hidden"
        aria-describedby={undefined}
      >
        <DialogHeader className="flex-shrink-0">
          <div className="flex items-center justify-between">
            <DialogTitle className="text-base font-semibold">Context</DialogTitle>
            <Button onClick={handleCopyAll} variant="outline" size="toolbar" className="mr-8">
              {copiedAll ? <Check className="size-3" /> : <Copy className="size-3" />}
              {copiedAll ? 'Copied!' : 'Copy All JSON'}
            </Button>
          </div>
        </DialogHeader>

        <div className="-mx-6 flex-1 space-y-8 overflow-y-auto px-6 pb-4">
          {/* Aggregate totals — shown when sub-sessions exist */}
          {hasSubSessions && aggregateTotals && (
            <div className="border-primary/20 bg-primary/5 flex flex-col gap-3 rounded-2xl border p-4">
              <div className="flex items-center gap-2">
                <Network className="text-primary size-4" />
                <div className="text-foreground text-sm font-semibold">
                  {tHardcodedUi.raw(
                    'componentsSessionSessionContextModal.line558JsxTextAggregateTotals',
                  )}
                  <span className="text-muted-foreground ml-2 text-xs font-normal">
                    {tHardcodedUi.raw(
                      'componentsSessionSessionContextModal.line560JsxTextThisSession',
                    )}
                    {descendantIds.length} sub-session{descendantIds.length !== 1 ? 's' : ''})
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat
                  label={tHardcodedUi.raw(
                    'componentsSessionSessionContextModal.line565JsxAttrLabelTotalCost',
                  )}
                  value={
                    <span className="text-primary font-semibold">
                      {formatCost(aggregateTotals.cost)}
                    </span>
                  }
                />
                <Stat
                  label={tHardcodedUi.raw(
                    'componentsSessionSessionContextModal.line568JsxAttrLabelTotalMessages',
                  )}
                  value={aggregateTotals.messages.toLocaleString()}
                />
                <Stat
                  label={tHardcodedUi.raw(
                    'componentsSessionSessionContextModal.line569JsxAttrLabelInputTokens',
                  )}
                  value={fmt.number(aggregateTotals.inputTokens)}
                />
                <Stat
                  label={tHardcodedUi.raw(
                    'componentsSessionSessionContextModal.line570JsxAttrLabelOutputTokens',
                  )}
                  value={fmt.number(aggregateTotals.outputTokens)}
                />
                <Stat
                  label={tHardcodedUi.raw(
                    'componentsSessionSessionContextModal.line571JsxAttrLabelReasoningTokens',
                  )}
                  value={fmt.number(aggregateTotals.reasoningTokens)}
                />
                <Stat
                  label={tHardcodedUi.raw(
                    'componentsSessionSessionContextModal.line572JsxAttrLabelCacheTokens',
                  )}
                  value={`${fmt.number(aggregateTotals.cacheReadTokens)} / ${fmt.number(aggregateTotals.cacheWriteTokens)}`}
                />
              </div>
            </div>
          )}

          {/* This session label when sub-sessions exist */}
          {hasSubSessions && (
            <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {tHardcodedUi.raw(
                'componentsSessionSessionContextModal.line580JsxTextThisSessionOnly',
              )}
            </div>
          )}

          {/* Stats grid — 1:1 from SolidJS */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {stats.map((stat) => (
              <Stat key={stat.label} label={stat.label} value={stat.value} />
            ))}
          </div>

          {/* Context breakdown bar — 1:1 from SolidJS */}
          {breakdown.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="text-muted-foreground text-xs">
                {tHardcodedUi.raw(
                  'componentsSessionSessionContextModal.line594JsxTextContextBreakdown',
                )}
              </div>
              <div className="bg-muted flex h-2 w-full overflow-hidden rounded-full">
                {breakdown.map((segment) => (
                  <div
                    key={segment.key}
                    className="h-full"
                    style={{
                      width: `${segment.width}%`,
                      backgroundColor: BREAKDOWN_COLORS[segment.key],
                    }}
                  />
                ))}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {breakdown.map((segment) => (
                  <div
                    key={segment.key}
                    className="text-muted-foreground flex items-center gap-1 text-xs"
                  >
                    <div
                      className="size-2 rounded-sm"
                      style={{ backgroundColor: BREAKDOWN_COLORS[segment.key] }}
                    />
                    <div>{BREAKDOWN_LABELS[segment.key]}</div>
                    <div className="text-muted-foreground/60">{segment.percent}%</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Sub-session cost tree */}
          {hasSubSessions && subSessionTree && subSessionTree.children.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="text-muted-foreground text-xs">
                {tHardcodedUi.raw(
                  'componentsSessionSessionContextModal.line619JsxTextSubSessionBreakdown',
                )}
              </div>
              <div className="bg-muted/20 rounded-2xl border p-3">
                {subSessionTree.children.map((child) => (
                  <SubSessionTreeNode key={child.id} node={child} />
                ))}
              </div>
            </div>
          )}

          {/* Raw messages — 1:1 from SolidJS */}
          <div className="flex flex-col gap-2">
            <div className="text-muted-foreground text-xs">
              {tHardcodedUi.raw('componentsSessionSessionContextModal.line631JsxTextRawMessages')}
              {counts.all})
            </div>
            <Accordion type="multiple" className="overflow-hidden rounded-2xl border">
              {(messages ?? []).map((msg) => (
                <RawMessage
                  key={msg.info.id}
                  message={msg.info}
                  parts={msg.parts}
                  formatTime={fmt.time}
                />
              ))}
            </Accordion>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
