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
import { Disclosure, DisclosureTrigger } from '@/components/ui/disclosure';
import { Label } from '@/components/ui/label';
import {
  Modal,
  ModalBody,
  ModalClose,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { Close } from '@/features/icon/icons/close';
import { ProviderLogo } from '@/features/providers/provider-branding';
import type { ProviderListResponse } from '@kortix/sdk/react';
import { useModelPricingLookup } from '@/lib/model-pricing';
import { cn } from '@/lib/utils';
import type { MessageWithParts } from '@/ui/types';
import type { AssistantMessage, Message, Part, Session } from '@kortix/sdk';
import type { ModelPricingLookup } from '@kortix/sdk/turns';
import { allDescendantIds, childMapByParent, formatCost, getSessionCost } from '@kortix/sdk/turns';
import { useSessionStateStore } from '@kortix/sdk/react';
import {
  CaretDownIcon,
  CaretRightIcon,
  CheckIcon,
  CopyIcon,
} from '@phosphor-icons/react';
import { AnimatePresence, m } from 'motion/react';
import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ============================================================================
// Context metrics
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
// Context breakdown estimation
// ============================================================================

type BreakdownKey = 'system' | 'user' | 'assistant' | 'tool' | 'other';

interface BreakdownSegment {
  key: BreakdownKey;
  tokens: number;
  width: number;
  percent: number;
}

const BREAKDOWN_ORDER: BreakdownKey[] = ['system', 'user', 'assistant', 'tool', 'other'];

const BREAKDOWN_SEGMENT_CLASS: Record<BreakdownKey, string> = {
  system: 'bg-kortix-blue',
  user: 'bg-kortix-green',
  assistant: 'bg-kortix-purple',
  tool: 'bg-kortix-orange',
  other: 'bg-muted-foreground/40',
};

const BREAKDOWN_LABEL_KEY: Record<BreakdownKey, string> = {
  system: 'legendSystem',
  user: 'legendUser',
  assistant: 'legendAssistant',
  tool: 'legendTool',
  other: 'legendOther',
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
    return BREAKDOWN_ORDER.filter((k) => (t[k] ?? 0) > 0).map((k) => ({
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
// Formatter
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

type Formatter = ReturnType<typeof createFormatter>;

// ============================================================================
// Stat primitives
// ============================================================================

function OverviewStat({
  label,
  value,
  meta,
}: {
  label: string;
  value: string;
  meta?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="text-foreground truncate text-base font-semibold tabular-nums">{value}</div>
      {meta ? (
        <div className="text-muted-foreground/70 truncate text-xs tabular-nums">{meta}</div>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="text-foreground truncate text-xs font-medium tabular-nums">{value}</div>
    </div>
  );
}

// ============================================================================
// Copy-all button (header action)
// ============================================================================

function CopyAllButton({
  messages,
  copyLabel,
  copiedLabel,
}: {
  messages: MessageWithParts[] | undefined;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = useCallback(() => {
    // Stringify on click only — never during render.
    navigator.clipboard.writeText(JSON.stringify(messages ?? [], null, 2));
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  }, [messages]);

  return (
    <Button
      onClick={handleCopy}
      variant="outline"
      size="sm"
      className="h-8 gap-1.5 transition-colors active:scale-[0.97]"
    >
      <span className="relative inline-flex size-3.5 shrink-0 items-center justify-center">
        <AnimatePresence initial={false} mode="popLayout">
          <m.span
            key={copied ? 'check' : 'copy'}
            initial={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
            animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
            exit={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
            transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
            className="absolute inset-0 inline-flex items-center justify-center"
          >
            {copied ? (
              <CheckIcon className="text-kortix-green size-3.5" />
            ) : (
              <CopyIcon className="size-3.5" />
            )}
          </m.span>
        </AnimatePresence>
      </span>
      {copied ? copiedLabel : copyLabel}
    </Button>
  );
}

// ============================================================================
// Raw message accordion item
// ============================================================================

/** Stringifies only while its accordion item is open — Radix unmounts closed content. */
function RawMessageJson({ message, parts }: { message: Message; parts: Part[] }) {
  const json = useMemo(() => JSON.stringify({ message, parts }, null, 2), [message, parts]);
  return (
    <pre className="bg-muted/40 max-h-[400px] overflow-x-auto overflow-y-auto rounded-md p-3 font-mono text-xs break-all whitespace-pre-wrap select-text">
      {json}
    </pre>
  );
}

const RawMessage = memo(function RawMessage({
  message,
  parts,
  formatTime,
}: {
  message: Message;
  parts: Part[];
  formatTime: Formatter['time'];
}) {
  return (
    <AccordionItem
      value={message.id}
      className="border-b-0 [contain-intrinsic-size:auto_37px] [content-visibility:auto]"
    >
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
          <div className="text-muted-foreground/60 shrink-0 text-xs tabular-nums">
            {formatTime(message.time?.created)}
          </div>
        </div>
      </AccordionTrigger>
      <AccordionContent className="px-3 pb-2">
        <RawMessageJson message={message} parts={parts} />
      </AccordionContent>
    </AccordionItem>
  );
});

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
        <span className="text-muted-foreground shrink-0 tabular-nums">
          {formatCost(node.cost)}
        </span>
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

// ============================================================================
// Modal body — mounted only while the modal is open, so the store
// subscriptions and metric computations cost nothing during streaming.
// ============================================================================

const RAW_PAGE_SIZE = 30;

function SessionContextModalBody({
  messages,
  session,
  providers,
  allSessions,
}: Omit<SessionContextModalProps, 'open' | 'onOpenChange'>) {
  const t = useTranslations('hardcodedUi.componentsSessionSessionContextModal');
  const pricingLookup = useModelPricingLookup(providers);
  const [rawVisibleCount, setRawVisibleCount] = useState(RAW_PAGE_SIZE);
  const [rawOpen, setRawOpen] = useState(false);
  // Sticky: once true, the row list stays mounted so reopening is instant.
  const [rawMounted, setRawMounted] = useState(false);
  const handleRawOpenChange = useCallback((open: boolean) => {
    setRawOpen(open);
    // Mount the heavy row list in a non-urgent render so the trigger's own
    // state flip paints first and the click never feels stuck.
    if (open) startTransition(() => setRawMounted(true));
  }, []);

  const metrics = useMemo(
    () => getSessionContextMetrics(messages ?? [], providers, pricingLookup),
    [messages, providers, pricingLookup],
  );

  const ctx = metrics.context;
  const fmt = useMemo(() => createFormatter(), []);

  const counts = useMemo(() => {
    const all = (messages ?? []).map((m) => m.info);
    const user = all.filter((m) => m.role === 'user').length;
    const assistant = all.filter((m) => m.role === 'assistant').length;
    return { all: all.length, user, assistant };
  }, [messages]);

  const breakdown = useMemo(() => {
    if (!ctx?.input || !messages) return [];
    return estimateBreakdown(messages, ctx.input);
  }, [ctx, messages]);

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

  const rawMessages = messages ?? [];
  const visibleRawMessages = rawMessages.slice(0, rawVisibleCount);
  const remainingRawMessages = rawMessages.length - visibleRawMessages.length;

  return (
    <>
      <ModalHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-0.5">
            <ModalTitle>{t.raw('title')}</ModalTitle>
            <ModalDescription>{t.raw('description')}</ModalDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <CopyAllButton
              messages={messages}
              copyLabel={t.raw('copyJson')}
              copiedLabel={t.raw('copied')}
            />
            <ModalClose asChild>
              <Button variant="ghost" className="size-8 p-0">
                <Close className="text-primary size-4 stroke-1" />
                <span className="sr-only">Close</span>
              </Button>
            </ModalClose>
          </div>
        </div>
      </ModalHeader>

      <ModalBody className="space-y-6">
        {/* Overview + technical detail — one flat panel. Hairline dividers come
            from a 1px grid gap over a border-colored background, which stays
            correct wherever the grid wraps (divide-x/y would not). */}
        <div className="bg-popover overflow-hidden rounded-md border">
          <div className="bg-border grid grid-cols-2 gap-px lg:grid-cols-4">
            <div className="bg-popover flex min-w-0 items-center gap-3 px-4 py-3">
              {ctx?.message ? (
                <ProviderLogo
                  providerID={ctx.message.providerID}
                  name={ctx.providerLabel}
                  size="small"
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <OverviewStat
                  label={t.raw('statModel')}
                  value={ctx?.modelLabel ?? '—'}
                  meta={ctx?.providerLabel}
                />
              </div>
            </div>
            <div className="bg-popover px-4 py-3">
              <OverviewStat label={t.raw('statCost')} value={formatCost(metrics.totalCost)} />
            </div>
            <div className="bg-popover px-4 py-3">
              <OverviewStat label={t.raw('statMessages')} value={counts.all.toLocaleString()} />
            </div>
            <div className="bg-popover px-4 py-3">
              <OverviewStat
                label={t.raw('statContextUsed')}
                value={fmt.percent(ctx?.usage)}
                meta={
                  ctx?.limit ? `${fmt.number(ctx.total)} / ${fmt.number(ctx.limit)}` : undefined
                }
              />
            </div>
          </div>
          <div className="bg-border border-border grid grid-cols-2 gap-px border-t lg:grid-cols-3">
            <div className="bg-popover px-4 py-3">
              <Stat label={t.raw('detailContextLimit')} value={fmt.number(ctx?.limit)} />
            </div>
            <div className="bg-popover px-4 py-3">
              <Stat label={t.raw('detailInput')} value={fmt.number(ctx?.input)} />
            </div>
            <div className="bg-popover px-4 py-3">
              <Stat label={t.raw('detailOutput')} value={fmt.number(ctx?.output)} />
            </div>
            <div className="bg-popover px-4 py-3">
              <Stat label={t.raw('detailReasoning')} value={fmt.number(ctx?.reasoning)} />
            </div>
            <div className="bg-popover px-4 py-3">
              <Stat
                label={t.raw('detailCache')}
                value={`${fmt.number(ctx?.cacheRead)} / ${fmt.number(ctx?.cacheWrite)}`}
              />
            </div>
            <div className="bg-popover px-4 py-3">
              <Stat label={t.raw('detailUserMessages')} value={counts.user.toLocaleString()} />
            </div>
            <div className="bg-popover px-4 py-3">
              <Stat
                label={t.raw('detailAssistantMessages')}
                value={counts.assistant.toLocaleString()}
              />
            </div>
            <div className="bg-popover px-4 py-3">
              <Stat label={t.raw('detailStarted')} value={fmt.time(session?.time?.created)} />
            </div>
            <div className="bg-popover px-4 py-3 max-lg:col-span-2">
              <Stat label={t.raw('detailLastReply')} value={fmt.time(ctx?.message?.time?.created)} />
            </div>
          </div>
        </div>

        {/* Context composition — segmented bar + plain-language legend */}
        {breakdown.length > 0 && (
          <section>
            <div className="bg-popover space-y-3 rounded-md border px-4 py-4">
              <div className="bg-muted flex h-2.5 w-full gap-px overflow-hidden rounded-full">
                {breakdown.map((segment) => (
                  <div
                    key={segment.key}
                    className={cn('h-full', BREAKDOWN_SEGMENT_CLASS[segment.key])}
                    style={{ width: `${segment.width}%` }}
                  />
                ))}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {breakdown.map((segment) => (
                  <div key={segment.key} className="flex items-center gap-1.5 text-xs">
                    <span
                      className={cn(
                        'size-2 shrink-0 rounded-[2px]',
                        BREAKDOWN_SEGMENT_CLASS[segment.key],
                      )}
                    />
                    <span className="text-foreground">
                      {t.raw(BREAKDOWN_LABEL_KEY[segment.key])}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {fmt.number(segment.tokens)} · {segment.percent}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Sub-agents — combined totals + per-session tree */}
        {hasSubSessions && subSessionTree && aggregateTotals && (
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
        )}

        {/* Raw message data — collapsed by default, paginated. The content is a
            plain hidden div rather than an animated DisclosureContent: animating
            height over 30 fresh accordion rows is what caused the open lag, and
            keeping the rows mounted after the first open makes reopening a pure
            display flip. */}
        <Disclosure
          variant="outline"
          className="overflow-hidden"
          open={rawOpen}
          onOpenChange={handleRawOpenChange}
        >
          <DisclosureTrigger variant="outline">
            <Button
              variant="popover"
              className="flex w-full items-center justify-between rounded-none px-4"
            >
              <span className="flex items-center gap-2">
                <span className="text-sm font-medium">{t.raw('rawLabel')}</span>
                <Badge variant="muted" size="sm" className="tabular-nums">
                  {counts.all}
                </Badge>
              </span>
              <CaretDownIcon className="text-muted-foreground size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
            </Button>
          </DisclosureTrigger>
          <div hidden={!rawOpen} className="border-border border-t">
            {rawMounted ? (
              <>
                <p className="text-muted-foreground px-4 pt-3 text-xs">
                  {t.raw('rawDescription')}
                </p>
                <Accordion type="multiple" className="px-2 py-2">
                  {visibleRawMessages.map((msg) => (
                    <RawMessage
                      key={msg.info.id}
                      message={msg.info}
                      parts={msg.parts}
                      formatTime={fmt.time}
                    />
                  ))}
                </Accordion>
                {remainingRawMessages > 0 && (
                  <div className="px-4 pb-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => setRawVisibleCount((count) => count + RAW_PAGE_SIZE)}
                    >
                      {t.raw('showMore')}
                      <span className="text-muted-foreground tabular-nums">
                        ({remainingRawMessages})
                      </span>
                    </Button>
                  </div>
                )}
              </>
            ) : null}
          </div>
        </Disclosure>
      </ModalBody>
    </>
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
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="max-h-[85vh] lg:max-w-3xl" showCloseButton={false}>
        <SessionContextModalBody
          messages={messages}
          session={session}
          providers={providers}
          allSessions={allSessions}
        />
      </ModalContent>
    </Modal>
  );
}
