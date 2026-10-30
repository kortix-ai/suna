'use client';

import { useTranslations } from '../../i18n';

import { Button } from '../../primitives/button';
import {
  Modal,
  ModalBody,
  ModalClose,
  ModalContent,
  ModalHeader,
  ModalTitle,
} from '../../primitives/modal';
import { Close } from '../../icons/close';
import { useModelPricingLookup } from '../../internal/lib/model-pricing';
import { cn } from '../../lib/utils';
import { type ProjectSession, type Session, type SessionLogBlock, type SessionLogMessage, type ToolCallBlock } from '@kortix/sdk';
import { formatUsdAsCredits } from '@kortix/shared';
import {
  useSessionLog,
  useSessionLogOlder,
  useSessionLogThread,
  useSessionMessages,
  type ProviderListResponse,
  type SessionMessagesSource,
} from '@kortix/sdk/react';
import { useEffect, useMemo } from 'react';
import {
  CopyAllButton,
  rawExplorerData,
  SessionContextMessageExplorer,
  type RawV1Row,
} from './session-context-message-explorer';
import { getSessionContextMetrics, sessionStartedAt } from './session-context-metrics';
import type { ServedModelNotice } from '../turn/served-model';
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

/** The length of a text the model saw: the whole text, even when the record keeps a preview (F3). */
const textChars = (b: { text: string; bytes?: number }) => b.bytes ?? b.text.length;

/**
 * What a user sent: its text, and the text of an `@file` or `@agent` mention.
 * A mention converts from the v1 store as a harness block whose `data` is the
 * v1 part (`source.text.value` for a file, `source.value` for an agent).
 */
function userBlockChars(b: SessionLogBlock): number {
  if (b.type === 'text') return textChars(b);
  if (b.type !== 'harness') return 0;
  const source = (b.data as { source?: { text?: { value?: string }; value?: string } } | null)?.source;
  return source?.text?.value?.length ?? source?.value?.length ?? 0;
}

/** A call's share: its arguments (16 chars a key, or the text still streaming in) and what came back. */
function toolCallChars(call: ToolCallBlock): number {
  const input = call.input;
  let chars = typeof input === 'string' ? input.length : Object.keys(input ?? {}).length * 16;
  if (call.status === 'complete') {
    for (const item of call.result?.content ?? []) if (item.type === 'text') chars += item.text.length;
  } else if (call.status === 'error') chars += call.result?.error?.message.length ?? 0;
  return chars;
}

/** Pure context-breakdown estimation — exported for characterization tests. */
export function estimateBreakdown(
  messages: SessionLogMessage[],
  input: number,
  systemPrompt?: string,
): BreakdownSegment[] {
  if (!input) return [];

  const counts = messages.reduce(
    (acc, msg) => {
      if (msg.role === 'user') {
        const user = msg.blocks.reduce((sum, b) => sum + userBlockChars(b), 0);
        // A compaction's summary is a reply the model reads back.
        const summary = msg.blocks.reduce((sum, b) => sum + (b.type === 'compaction' ? (b.summary?.length ?? 0) : 0), 0);
        return { ...acc, user: acc.user + user, assistant: acc.assistant + summary };
      }
      if (msg.role !== 'assistant') return acc;
      const result = msg.blocks.reduce(
        (sum, b) => {
          if (b.type === 'text' || b.type === 'reasoning') return { assistant: sum.assistant + textChars(b), tool: sum.tool };
          if (b.type === 'tool_call') return { assistant: sum.assistant, tool: sum.tool + toolCallChars(b) };
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
        <div className="text-muted-foreground truncate text-xs tabular-nums">{meta}</div>
      ) : null}
    </div>
  );
}

// ============================================================================
// Modal body — mounted only while the modal is open, so the store
// subscriptions and metric computations cost nothing during streaming.
// ============================================================================

const NO_MESSAGES: SessionLogMessage[] = [];

function SessionContextModalBody({
  detachedRows,
  source,
  session,
  sessionRow,
  providers,
  allSessions,
  servedModel,
  billedCost,
}: Omit<SessionContextModalProps, 'open' | 'onOpenChange'>) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('hardcodedUi.componentsSessionSessionContextModal');
  const tCredits = useTranslations('settings.credits');
  const pricingLookup = useModelPricingLookup(providers);
  // The numbers read the session log's root thread: the `fromV1` view of the
  // v1 rows while v2 is off, the API's record on v2. The raw explorer and Copy
  // JSON read the active source: the records on v2, else the v1 rows.
  const thread = useSessionLogThread(source);
  const log = thread?.messages ?? NO_MESSAGES;
  // The counts are of the whole thread: an open modal reads every older page of the log
  // (the chat holds only the newest window). A failed page stops the walk.
  const { hasOlder, isLoadingOlder, loadOlder } = useSessionLogOlder(source);
  useEffect(() => {
    if (hasOlder && !isLoadingOlder) void loadOlder();
  }, [hasOlder, isLoadingOlder, loadOlder]);
  const logSource = useSessionLog(source)?.source;
  // Only the v1 explorer reads the v1 rows: on v2 (or with detached rows) a
  // null runtime id reads none, so a streamed v1 row re-renders nothing here.
  const readsV1Rows = logSource === 'v1' && !detachedRows;
  const v1Rows = useSessionMessages(
    readsV1Rows ? source : { ...source, runtimeSessionId: null, opencodeSessionId: null },
  );
  const raw = useMemo(
    () => rawExplorerData(logSource, thread?.messages, detachedRows ?? v1Rows),
    [logSource, thread, detachedRows, v1Rows],
  );
  const metrics = useMemo(
    () => getSessionContextMetrics(thread, providers, pricingLookup),
    [thread, providers, pricingLookup],
  );

  const ctx = metrics.context;
  const fmt = useMemo(() => createFormatter(), []);

  const counts = metrics.messages;

  const breakdown = useMemo(() => (ctx?.input ? estimateBreakdown(log, ctx.input) : []), [ctx, log]);

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
              value={raw.copy}
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
          {/* The transcript names the model each turn asked for and prices it
              at that model. When a fallback model answered, the gateway's
              record names the model that ran and what Kortix billed. */}
          <OverviewStat
            label={t.raw('statModel')}
            value={servedModel?.served ?? ctx?.modelLabel ?? '—'}
            meta={
              servedModel
                ? `${tI18nComplete.raw('servedModelInPlaceOf')} ${servedModel.fallbackFrom}`
                : ctx?.providerLabel
            }
          />
          <OverviewStat
            label={t.raw('statCost')}
            value={tCredits('creditCount', {
              count: (billedCost ?? metrics.totalCost) * 100,
              formatted: formatUsdAsCredits(billedCost ?? metrics.totalCost),
            })}
          />
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
                        'size-2 shrink-0 rounded-sm',
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
                { label: t.raw('detailStarted'), value: fmt.time(sessionStartedAt(session, sessionRow)) },
                { label: t.raw('detailLastReply'), value: fmt.time(ctx ? Date.parse(ctx.message.created_at) : undefined) },
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
          source={source}
          session={session}
          allSessions={allSessions}
          pricingLookup={pricingLookup}
          fmt={fmt}
        />

        <SessionContextMessageExplorer
          rows={raw.rows}
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
  /**
   * The v1 rows of a chat with no `useSession` source (`useSessionSync`). The
   * raw explorer and Copy JSON read them instead of `useSessionMessages(source)`
   * while the session log is not v2.
   */
  detachedRows?: readonly RawV1Row[];
  /** The session whose log the metrics read (`useSessionLogThread`). */
  source: SessionMessagesSource;
  session: Session | undefined;
  /** The session's row: when it started (`sessionStartedAt`). */
  sessionRow?: ProjectSession | null;
  providers: ProviderListResponse | undefined;
  allSessions?: Session[];
  /** The model that answered the newest request, when a fallback model did. */
  servedModel?: ServedModelNotice | null;
  /** What Kortix billed the session, when a fallback model answered a turn. */
  billedCost?: number | null;
}

export function SessionContextModal({
  open,
  onOpenChange,
  detachedRows,
  source,
  session,
  sessionRow,
  providers,
  allSessions,
  servedModel,
  billedCost,
}: SessionContextModalProps) {
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="max-h-[85vh] lg:max-w-3xl" showCloseButton={false}>
        <SessionContextModalBody
          detachedRows={detachedRows}
          source={source}
          session={session}
          sessionRow={sessionRow}
          providers={providers}
          allSessions={allSessions}
          servedModel={servedModel}
          billedCost={billedCost}
        />
      </ModalContent>
    </Modal>
  );
}
