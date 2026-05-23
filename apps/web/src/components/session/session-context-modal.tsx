'use client';

import { useMemo, useState } from 'react';
import { Copy, Check, ChevronDown, ChevronRight, Network } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import type { MessageWithParts } from '@/ui/types';
import { COST_MARKUP, childMapByParent, allDescendantIds } from '@/ui/turns';
import type { ProviderListResponse } from '@/hooks/opencode/use-opencode-sessions';
import type { Session, AssistantMessage, Message, Part } from '@opencode-ai/sdk/v2/client';
import { useSyncStore } from '@/stores/opencode-sync-store';

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
  return (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + ((t.cache?.read ?? 0) + (t.cache?.write ?? 0));
}

function getSessionContextMetrics(messages: Message[], providers: ProviderListResponse | undefined): Metrics {
  // Apply COST_MARKUP (1.2×) so the displayed total matches actual billed credits.
  // Raw msg.cost is provider cost; billing deducts cost × COST_MARKUP.
  const totalCost = messages.reduce((sum, msg) => sum + (msg.role === 'assistant' ? (msg.cost ?? 0) : 0), 0) * COST_MARKUP;

  // Find last assistant with tokens
  let last: AssistantMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
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
  system: 'var(--color-blue-400)',      // blue
  user: 'var(--color-emerald-400)',     // green
  assistant: 'var(--color-violet-400)', // purple
  tool: 'var(--color-amber-400)',       // yellow
  other: 'var(--color-muted-foreground)', // gray
};

const BREAKDOWN_LABELS: Record<BreakdownKey, string> = {
  system: 'System',
  user: 'User',
  assistant: 'Assistant',
  tool: 'Tool',
  other: 'Other',
};

function estimateTokens(chars: number) { return Math.ceil(chars / 4); }

function estimateBreakdown(messages: MessageWithParts[], input: number, systemPrompt?: string): BreakdownSegment[] {
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
          if (part.type === 'text') return { assistant: sum.assistant + (part as any).text.length, tool: sum.tool };
          if (part.type === 'reasoning') return { assistant: sum.assistant + (part as any).text.length, tool: sum.tool };
          if (part.type === 'tool') {
            const state = (part as any).state;
            const inputLen = Object.keys(state?.input ?? {}).length * 16;
            let toolLen = inputLen;
            if (state?.status === 'pending') toolLen += (state.raw?.length ?? 0);
            else if (state?.status === 'completed') toolLen += (state.output?.length ?? 0);
            else if (state?.status === 'error') toolLen += (state.error?.length ?? 0);
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
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
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
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xs font-medium text-foreground">{value}</div>
    </div>
  );
}

// ============================================================================
// Raw message accordion item
// ============================================================================

function RawMessage({ message, parts, formatTime }: {
  message: Message;
  parts: Part[];
  formatTime: (v: number | undefined) => string;
}) {
  return (
    <AccordionItem value={message.id}>
      <AccordionTrigger className="py-2 px-3 text-xs hover:no-underline hover:bg-muted/40 rounded-md">
        <div className="flex items-center justify-between gap-2 w-full pr-2">
          <div className="min-w-0 truncate font-mono">
            <Badge
              variant={message.role === 'user' ? 'info' : 'success'}
              size="sm"
              className="uppercase font-semibold mr-2"
            >
              {message.role}
            </Badge>
            <span className="text-muted-foreground">{message.id}</span>
          </div>
          <div className="shrink-0 text-xs text-muted-foreground/60">
            {formatTime(message.time?.created)}
          </div>
        </div>
      </AccordionTrigger>
      <AccordionContent className="px-3 pb-2">
        <pre className="p-3 rounded-2xl bg-muted/40 overflow-x-auto text-xs font-mono whitespace-pre-wrap break-all select-text max-h-[400px] overflow-y-auto">
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
  childMap: Map<string, string[]>,
  allSessions: Session[],
): SubSessionCostInfo {
  const msgs = storeMessages[sessionId] ?? [];
  const cost = msgs.reduce((sum, msg) => sum + (msg.role === 'assistant' ? (msg.cost ?? 0) : 0), 0) * COST_MARKUP;

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
      childMap,
      allSessions,
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
  return { cost, messages, inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens };
}

// ============================================================================
// Sub-session tree component
// ============================================================================

function SubSessionTreeNode({
  node,
  usd,
  depth = 0,
}: {
  node: SubSessionCostInfo;
  usd: Intl.NumberFormat;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const hasChildren = node.children.length > 0;
  const totals = useMemo(() => sumTreeCosts(node), [node]);

  return (
    <div className={cn('flex flex-col', depth > 0 && 'ml-4 border-l border-border/30 pl-3')}>
      <button
        onClick={() => hasChildren && setExpanded(!expanded)}
        className={cn(
          'flex items-center gap-2 py-1.5 text-xs w-full text-left',
          hasChildren && 'cursor-pointer hover:bg-muted/40 rounded-md px-1.5 -mx-1.5',
          !hasChildren && 'cursor-default',
        )}
      >
        {hasChildren ? (
          expanded ? <ChevronDown className="size-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <div className="size-3 shrink-0" />
        )}
        <span className="truncate font-medium text-foreground min-w-0">{node.title}</span>
        <span className="shrink-0 text-muted-foreground ml-auto tabular-nums">
          {usd.format(node.cost)}
        </span>
        {hasChildren && (
          <span className="shrink-0 text-muted-foreground/50 text-xs tabular-nums">
            (tree: {usd.format(totals.cost)})
          </span>
        )}
        <span className="shrink-0 text-muted-foreground/60 text-xs">
          {node.messages} msgs
        </span>
      </button>
      {expanded && hasChildren && (
        <div className="flex flex-col">
          {node.children.map((child) => (
            <SubSessionTreeNode key={child.id} node={child} usd={usd} depth={depth + 1} />
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
  const [copiedAll, setCopiedAll] = useState(false);

  const rawMessages = useMemo(
    () => (messages ?? []).map((m) => m.info),
    [messages],
  );

  const metrics = useMemo(
    () => getSessionContextMetrics(rawMessages, providers),
    [rawMessages, providers],
  );

  const ctx = metrics.context;
  const fmt = useMemo(() => createFormatter(), []);

  const usd = useMemo(
    () => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }),
    [],
  );

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
  const storeMessages = useSyncStore((s) => s.messages);

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
    return computeSubSessionCost(session.id, session.title ?? session.id, storeMessages, childMap, allSessions);
  }, [session, hasSubSessions, allSessions, storeMessages, childMap]);

  const aggregateTotals = useMemo(() => {
    if (!subSessionTree) return null;
    return sumTreeCosts(subSessionTree);
  }, [subSessionTree]);

  const stats = useMemo(() => [
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
    { label: 'Cache Tokens', value: `${fmt.number(ctx?.cacheRead)} / ${fmt.number(ctx?.cacheWrite)}` },
    { label: 'User Messages', value: counts.user.toLocaleString() },
    { label: 'Assistant Messages', value: counts.assistant.toLocaleString() },
    { label: 'Total Cost', value: usd.format(metrics.totalCost) },
    { label: 'Session Created', value: fmt.time(session?.time?.created) },
    { label: 'Last Activity', value: fmt.time(ctx?.message?.time?.created) },
  ], [session, counts, ctx, fmt, usd, metrics.totalCost]);

  const handleCopyAll = () => {
    navigator.clipboard.writeText(JSON.stringify(messages, null, 2));
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-hidden flex flex-col" aria-describedby={undefined}>
        <DialogHeader className="flex-shrink-0">
          <div className="flex items-center justify-between">
            <DialogTitle className="text-base font-semibold">Context</DialogTitle>
            <Button
              onClick={handleCopyAll}
              variant="outline"
              size="toolbar"
              className="mr-8"
            >
              {copiedAll ? <Check className="size-3" /> : <Copy className="size-3" />}
              {copiedAll ? 'Copied!' : 'Copy All JSON'}
            </Button>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto -mx-6 px-6 pb-4 space-y-8">
          {/* Aggregate totals — shown when sub-sessions exist */}
          {hasSubSessions && aggregateTotals && (
            <div className="flex flex-col gap-3 p-4 rounded-2xl border border-primary/20 bg-primary/5">
              <div className="flex items-center gap-2">
                <Network className="size-4 text-primary" />
                <div className="text-sm font-semibold text-foreground">
                  Aggregate Totals
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    (this session + {descendantIds.length} sub-session{descendantIds.length !== 1 ? 's' : ''})
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat label="Total Cost" value={
                  <span className="text-primary font-semibold">{usd.format(aggregateTotals.cost)}</span>
                } />
                <Stat label="Total Messages" value={aggregateTotals.messages.toLocaleString()} />
                <Stat label="Input Tokens" value={fmt.number(aggregateTotals.inputTokens)} />
                <Stat label="Output Tokens" value={fmt.number(aggregateTotals.outputTokens)} />
                <Stat label="Reasoning Tokens" value={fmt.number(aggregateTotals.reasoningTokens)} />
                <Stat label="Cache Tokens" value={`${fmt.number(aggregateTotals.cacheReadTokens)} / ${fmt.number(aggregateTotals.cacheWriteTokens)}`} />
              </div>
            </div>
          )}

          {/* This session label when sub-sessions exist */}
          {hasSubSessions && (
            <div className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
              This Session Only
            </div>
          )}

          {/* Stats grid — 1:1 from SolidJS */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {stats.map((stat) => (
              <Stat key={stat.label} label={stat.label} value={stat.value} />
            ))}
          </div>

          {/* Context breakdown bar — 1:1 from SolidJS */}
          {breakdown.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="text-xs text-muted-foreground">Context Breakdown</div>
              <div className="h-2 w-full rounded-full bg-muted overflow-hidden flex">
                {breakdown.map((segment) => (
                  <div
                    key={segment.key}
                    className="h-full"
                    style={{ width: `${segment.width}%`, backgroundColor: BREAKDOWN_COLORS[segment.key] }}
                  />
                ))}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {breakdown.map((segment) => (
                  <div key={segment.key} className="flex items-center gap-1 text-xs text-muted-foreground">
                    <div className="size-2 rounded-sm" style={{ backgroundColor: BREAKDOWN_COLORS[segment.key] }} />
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
              <div className="text-xs text-muted-foreground">Sub-Session Breakdown</div>
              <div className="border rounded-2xl p-3 bg-muted/20">
                {subSessionTree.children.map((child) => (
                  <SubSessionTreeNode key={child.id} node={child} usd={usd} />
                ))}
              </div>
            </div>
          )}

          {/* Raw messages — 1:1 from SolidJS */}
          <div className="flex flex-col gap-2">
            <div className="text-xs text-muted-foreground">
              Raw Messages ({counts.all})
            </div>
            <Accordion type="multiple" className="border rounded-2xl overflow-hidden">
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
