'use client';

import { useTranslations } from '@/i18n/use-translations';

import { Button } from '@/components/ui/button';
import {
  Modal,
  ModalBody,
  ModalClose,
  ModalContent,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { Close } from '@/features/icon/icons/close';
import { useModelPricingLookup } from '@/lib/model-pricing';
import { cn } from '@/lib/utils';
import type { MessageWithParts } from '@/ui/types';
import {
  formatCost,
  isAgentPart,
  isFilePart,
  isReasoningPart,
  isTextPart,
  isToolPart,
  type Session,
} from '@kortix/sdk';
import type { ProviderListResponse } from '@kortix/sdk/react';
import { useMemo } from 'react';
import { CopyAllButton, SessionContextMessageExplorer } from './session-context-message-explorer';
import { getSessionContextMetrics } from './session-context-metrics';
import { SubSessionSection } from './session-context-sub-sessions';

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

/** Pure context-breakdown estimation — exported for characterization tests. */
export function estimateBreakdown(
  messages: MessageWithParts[],
  input: number,
  systemPrompt?: string,
): BreakdownSegment[] {
  if (!input) return [];

  const counts = messages.reduce(
    (acc, msg) => {
      if (msg.info.role === 'user') {
        const user = msg.parts.reduce((sum, part) => {
          if (isTextPart(part)) return sum + part.text.length;
          if (isFilePart(part)) return sum + (part.source?.text?.value?.length ?? 0);
          if (isAgentPart(part)) return sum + (part.source?.value?.length ?? 0);
          return sum;
        }, 0);
        return { ...acc, user: acc.user + user };
      }
      if (msg.info.role !== 'assistant') return acc;
      const result = msg.parts.reduce(
        (sum, part) => {
          if (isTextPart(part) || isReasoningPart(part))
            return { assistant: sum.assistant + part.text.length, tool: sum.tool };
          if (isToolPart(part)) {
            const state = part.state;
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
  valueClassName,
}: {
  label: string;
  value: string;
  meta?: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div
        className={cn(
          'text-foreground truncate text-base font-semibold tabular-nums',
          valueClassName,
        )}
      >
        {value}
      </div>
      {meta ? (
        <div className="text-muted-foreground/70 truncate text-xs tabular-nums">{meta}</div>
      ) : null}
    </div>
  );
}

// ============================================================================
// Modal body — mounted only while the modal is open, so the store
// subscriptions and metric computations cost nothing during streaming.
// ============================================================================

function SessionContextModalBody({
  messages,
  session,
  providers,
  allSessions,
}: Omit<SessionContextModalProps, 'open' | 'onOpenChange'>) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('hardcodedUi.componentsSessionSessionContextModal');
  const pricingLookup = useModelPricingLookup(providers);
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

  const usageFraction = ctx?.limit ? Math.min(1, ctx.total / ctx.limit) : null;

  // Bar segments keep the legend colors. Every non-zero category gets at
  // least MIN_SEGMENT so a 0.1% share still renders as a visible chip; the
  // large segments absorb the difference.
  const barSegments = useMemo(() => {
    if (!breakdown.length) return [];
    const trackTotal = (usageFraction ?? 1) * 100;
    const MIN_SEGMENT = Math.min(1.5, trackTotal / breakdown.length);
    const raw = breakdown.map((s) => (s.width / 100) * trackTotal);
    let fixed = 0;
    let flexSum = 0;
    for (const width of raw) {
      if (width < MIN_SEGMENT) fixed += MIN_SEGMENT;
      else flexSum += width;
    }
    const scale = flexSum > 0 ? (trackTotal - fixed) / flexSum : 0;
    return breakdown.map((s, i) => ({
      key: s.key,
      width: raw[i] < MIN_SEGMENT ? MIN_SEGMENT : raw[i] * scale,
    }));
  }, [breakdown, usageFraction]);
  const usageTone =
    ctx?.usage == null
      ? undefined
      : ctx.usage >= 95
        ? 'text-kortix-red'
        : ctx.usage >= 80
          ? 'text-kortix-orange'
          : undefined;

  return (
    <>
      <ModalHeader>
        <div className="flex items-start justify-between gap-3">
          <ModalTitle>{t.raw('title')}</ModalTitle>
          <div className="flex shrink-0 items-center gap-2">
            <CopyAllButton
              messages={messages}
              copyLabel={t.raw('copyJson')}
              copiedLabel={t.raw('copied')}
            />
            <ModalClose asChild>
              <Button variant="ghost" className="size-8 p-0">
                <Close className="text-primary size-4 stroke-1" />
                <span className="sr-only">{tI18nComplete.raw('text7d9eb7acb13e')}</span>
              </Button>
            </ModalClose>
          </div>
        </div>
      </ModalHeader>

      <ModalBody className="space-y-6">
        {/* Overview — three naked stats, typography only, no boxes. Context
            usage lives in the section below instead of duplicating here. */}
        <div className="flex flex-wrap items-start gap-x-12 gap-y-4">
          <OverviewStat
            label={t.raw('statModel')}
            value={ctx?.modelLabel ?? '—'}
            meta={ctx?.providerLabel}
          />
          <OverviewStat label={t.raw('statCost')} value={formatCost(metrics.totalCost)} />
          <OverviewStat label={t.raw('statMessages')} value={counts.all.toLocaleString()} />
        </div>

        {/* Context usage and technical detail, side by side on desktop. The
            bar does one job — how full — as a single fill; the composition is
            readable as rows, where a 0.1% category is a number, not a
            sub-pixel sliver. */}
        <div className="grid gap-x-12 gap-y-8 lg:grid-cols-2">
          <section className="space-y-3">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-foreground text-sm font-medium">
                {t.raw('statContextUsed')}
              </span>
              <span className={cn('text-foreground text-sm font-semibold tabular-nums', usageTone)}>
                {fmt.percent(ctx?.usage)}
              </span>
            </div>
            {(usageFraction != null || barSegments.length > 0) && (
              <>
                <div className="bg-muted flex h-2 w-full overflow-hidden rounded-full">
                  {barSegments.length > 0 ? (
                    barSegments.map((segment) => (
                      <div
                        key={segment.key}
                        className={cn('h-full', BREAKDOWN_SEGMENT_CLASS[segment.key])}
                        style={{ width: `${segment.width}%` }}
                      />
                    ))
                  ) : (
                    <div
                      className="bg-foreground h-full"
                      style={{
                        width: `${(usageFraction ?? 0) > 0 ? Math.max((usageFraction ?? 0) * 100, 1.5) : 0}%`,
                      }}
                    />
                  )}
                </div>
                {usageFraction != null && (
                  <div className="text-muted-foreground text-right text-xs tabular-nums">
                    {fmt.number(ctx?.total)} / {fmt.number(ctx?.limit)}
                  </div>
                )}
              </>
            )}
            {breakdown.length > 0 && (
              <ul className="space-y-2 pt-1">
                {breakdown.map((segment) => (
                  <li key={segment.key} className="flex items-center gap-2 text-xs">
                    <span
                      className={cn(
                        'size-2 shrink-0 rounded-[2px]',
                        BREAKDOWN_SEGMENT_CLASS[segment.key],
                      )}
                    />
                    <span className="text-foreground">
                      {t.raw(BREAKDOWN_LABEL_KEY[segment.key])}
                    </span>
                    <span className="text-muted-foreground ml-auto tabular-nums">
                      {fmt.number(segment.tokens)} · {segment.percent}%
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-3">
            <span className="text-foreground text-sm font-medium">{t.raw('detailsLabel')}</span>
            <dl className="divide-border/60 divide-y">
              {[
                { label: t.raw('detailInput'), value: fmt.number(ctx?.input) },
                { label: t.raw('detailOutput'), value: fmt.number(ctx?.output) },
                { label: t.raw('detailReasoning'), value: fmt.number(ctx?.reasoning) },
                {
                  label: t.raw('detailCache'),
                  value: `${fmt.number(ctx?.cacheRead)} / ${fmt.number(ctx?.cacheWrite)}`,
                },
                { label: t.raw('detailUserMessages'), value: counts.user.toLocaleString() },
                {
                  label: t.raw('detailAssistantMessages'),
                  value: counts.assistant.toLocaleString(),
                },
                { label: t.raw('detailStarted'), value: fmt.time(session?.time?.created) },
                { label: t.raw('detailLastReply'), value: fmt.time(ctx?.message?.time?.created) },
              ].map((row) => (
                <div
                  key={row.label}
                  className="flex items-baseline justify-between gap-4 py-1.5 first:pt-0 last:pb-0"
                >
                  <dt className="text-muted-foreground text-xs">{row.label}</dt>
                  <dd className="text-foreground text-xs font-medium tabular-nums">{row.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>

        <SubSessionSection
          session={session}
          allSessions={allSessions}
          pricingLookup={pricingLookup}
          fmt={fmt}
        />

        <SessionContextMessageExplorer
          messages={messages}
          formatTime={fmt.time}
          count={counts.all}
        />
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
