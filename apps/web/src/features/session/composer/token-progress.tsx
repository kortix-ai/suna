'use client';

import { CaretRightIcon, WarningIcon } from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { Fragment, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Progress } from '@/components/ui/progress';
import { ProgressRing } from '@/components/ui/progress-ring';
import { STATUS_DOT, STATUS_TEXT, type StatusTone } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import type { MessageWithParts } from '@kortix/sdk/react';

import type { FlatModel } from '../model-flatten';

// ============================================================================
// Token Progress Circle
// ============================================================================
//
// Deliberately kept visible in BOTH the simple and advanced composer toolbars
// (see composer-toolbar.tsx) — it's a quiet, non-interactive ring with no
// label text, not a "control" a non-technical user has to understand. The
// brief for the composer simplification explicitly allows ambient surfaces
// like this to stay put: it communicates "the conversation is getting long"
// without asking anyone to know what a token is.
//
// Hover opens a HoverCard (not Hint), laid out as three tiers so it answers
// three different questions in reading order:
//
//   1. VERDICT   — headline + percent. "Am I fine, or do I need to act?"
//   2. METER     — Progress bar + used/left. "How much room is there?"
//   3. COMPOSITION — per-kind token rows + model line. "Where did it go, and
//                    whose window am I even looking at?"
//
// Tiers 1–2 are for everyone; tier 3 is the technical read that used to be
// missing entirely. The ring alone stays the ambient glanceable meter.

interface TokenProgressProps {
  messages: MessageWithParts[] | undefined;
  models?: FlatModel[];
  selectedModel?: { providerID: string; modelID: string } | null;
  onContextClick?: () => void;
}

/**
 * Per-kind token split of the context window, as reported by the model.
 *
 * `cache` folds `cache.read` + `cache.write` into one number on purpose: the
 * distinction is a billing detail, not a "how full is my conversation" detail,
 * and two near-identical rows in a hover card is noise. `total` is the sum of
 * every field and is what the ring and the bar are a fraction of.
 */
export interface ContextBreakdown {
  input: number;
  output: number;
  reasoning: number;
  cache: number;
  total: number;
}

const EMPTY_BREAKDOWN: ContextBreakdown = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: 0,
  total: 0,
};

/**
 * The per-kind split behind the ring, taken from the most recent assistant
 * message that actually reports a non-zero total.
 *
 * Scanning backwards (rather than summing the whole thread) is the correct
 * model: each assistant turn reports the size of the window it just ran
 * against, so the LAST one is the current occupancy. Summing would double-count
 * every earlier turn and race past the limit within a few messages.
 *
 * Trailing assistant messages with no usage yet — a turn that is still
 * streaming, or one that errored before reporting — are skipped rather than
 * treated as zero, so the reading holds steady mid-stream instead of
 * collapsing to 0% and snapping back.
 */
export function getLastAssistantTokenBreakdown(
  messages: MessageWithParts[] | undefined,
): ContextBreakdown {
  if (!messages) return EMPTY_BREAKDOWN;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info.role !== 'assistant') continue;
    const t = (msg.info as any).tokens;
    if (!t) continue;
    const input = t.input ?? 0;
    const output = t.output ?? 0;
    const reasoning = t.reasoning ?? 0;
    const cache = (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
    const total = input + output + reasoning + cache;
    if (total > 0) return { input, output, reasoning, cache, total };
  }
  return EMPTY_BREAKDOWN;
}

export function getLastAssistantTokenTotal(messages: MessageWithParts[] | undefined): number {
  return getLastAssistantTokenBreakdown(messages).total;
}

/**
 * Where the ring turns yellow, and where it turns red.
 *
 * Named, and adjacent, because the only thing that makes this ring useful is
 * that the two numbers are far enough apart to give a warning band worth
 * noticing — 70 → 85 leaves fifteen points of "you are getting long" before
 * "you are about to be truncated". Move them together and the yellow step
 * stops being a warning and becomes a flicker on the way to red.
 */
export const CONTEXT_WARNING_RATIO = 0.7;
export const CONTEXT_DANGER_RATIO = 0.85;

/**
 * Context usage → status tone. Pure, exported, and tested — the component
 * around it needs a DOM and this repo's `bun test` has none, so a threshold
 * comparison left inline in the render could not be asserted at all.
 *
 * Returns a `StatusTone` rather than a class string so the ring draws from the
 * app's existing status family (`STATUS_TEXT`) instead of hardcoding hexes: it
 * inherits both light and dark values, and red stays `text-destructive` — the
 * same red every other "this is a problem" surface uses, not a lookalike.
 *
 * `info` (blue) is the resting tone, not `neutral`. The ring is ambient and
 * unlabelled, so muted grey read as chrome — as decoration rather than a
 * reading. Blue makes it legible as a gauge at a glance, which is the whole
 * reason it earns colour at all.
 */
export function contextTone(ratio: number): StatusTone {
  if (ratio >= CONTEXT_DANGER_RATIO) return 'destructive';
  if (ratio >= CONTEXT_WARNING_RATIO) return 'warning';
  return 'info';
}

export function getContextLimit(
  models: FlatModel[] | undefined,
  selectedModel: { providerID: string; modelID: string } | null | undefined,
): number {
  if (selectedModel && models) {
    const model = models.find(
      (m) => m.providerID === selectedModel.providerID && m.modelID === selectedModel.modelID,
    );
    if (model?.contextWindow && model.contextWindow > 0) return model.contextWindow;
  }
  return 200000;
}

/**
 * Display name of the model whose window the card is measuring, or `null` when
 * it can't be resolved (no selection, or a selection the catalog doesn't know).
 *
 * Returning `null` rather than the raw `modelID` is deliberate: a bare id like
 * `anthropic/claude-sonnet-4-5-20250929` is worse than no line at all in a card
 * this small, and the card already states the limit on its own.
 */
export function getSelectedModelName(
  models: FlatModel[] | undefined,
  selectedModel: { providerID: string; modelID: string } | null | undefined,
): string | null {
  if (!selectedModel || !models) return null;
  const model = models.find(
    (m) => m.providerID === selectedModel.providerID && m.modelID === selectedModel.modelID,
  );
  const name = model?.modelName?.trim();
  return name ? name : null;
}

/**
 * Compact count for the HoverCard precision rows. Always returns a string
 * (including `0`) — unlike catalog `formatTokenCount`, which treats 0 as empty.
 */
export function formatContextCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens < 1000) return `${Math.round(tokens)}`;
  if (tokens < 1_000_000) {
    const k = tokens / 1000;
    if (k >= 100) return `${Math.round(k)}k`;
    return `${k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  const m = tokens / 1_000_000;
  if (Number.isInteger(m)) return `${m}m`;
  return `${m.toFixed(1).replace(/\.0$/, '')}m`;
}

type UsageHeadlineKind = 'healthy' | 'warning' | 'danger';

/** Maps ring tone → HoverCard headline band (plain language, not "tokens"). */
export function contextUsageHeadlineKind(tone: StatusTone): UsageHeadlineKind {
  switch (tone) {
    case 'destructive':
      return 'danger';
    case 'warning':
      return 'warning';
    case 'info':
    case 'success':
    case 'neutral':
      return 'healthy';
    default: {
      const _exhaustive: never = tone;
      return _exhaustive;
    }
  }
}

const HEADLINE_TITLE_KEY = {
  healthy: 'titleHealthy',
  warning: 'titleWarning',
  danger: 'titleDanger',
} as const;

const HEADLINE_TIP_KEY = {
  healthy: null,
  warning: 'tipWarning',
  danger: 'tipDanger',
} as const;

/**
 * Breakdown rows, in a fixed order chosen by size rather than by the order the
 * API happens to emit them: input dominates, cache is next, output and
 * reasoning are the tail. A fixed order matters more than a sorted one here —
 * rows must not reshuffle under the cursor as tokens stream in.
 */
const BREAKDOWN_ROWS = [
  { key: 'input', labelKey: 'labelInput' },
  { key: 'cache', labelKey: 'labelCached' },
  { key: 'output', labelKey: 'labelOutput' },
  { key: 'reasoning', labelKey: 'labelReasoning' },
] as const satisfies ReadonlyArray<{ key: keyof ContextBreakdown; labelKey: string }>;

function ContextUsageCard({
  breakdown,
  limit,
  ratio,
  tone,
  modelName,
  interactive,
  onViewDetails,
}: {
  breakdown: ContextBreakdown;
  limit: number;
  ratio: number;
  tone: StatusTone;
  modelName: string | null;
  interactive: boolean;
  onViewDetails?: () => void;
}) {
  const t = useTranslations('hardcodedUi.featuresSessionComposerTokenProgress');
  const percent = Math.round(ratio * 100);
  const headline = contextUsageHeadlineKind(tone);
  const title = t(HEADLINE_TITLE_KEY[headline]);
  const tipKey = HEADLINE_TIP_KEY[headline];
  const tip = tipKey ? t(tipKey) : null;
  const remaining = Math.max(limit - breakdown.total, 0);
  const rows = BREAKDOWN_ROWS.filter((row) => breakdown[row.key] > 0);

  // The bar draws in from 0 on open instead of appearing pre-filled. The card
  // mounts only when the HoverCard opens, so this is an entrance, not a
  // page-load animation — and `Progress` already owns the 300ms transform
  // transition, so one state flip on the next frame is the whole implementation.
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="space-y-3">
      {/* Tier 1+2 — verdict and meter, read as one block */}
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <p
            className={cn(
              'text-sm font-medium text-pretty',
              headline === 'healthy' ? 'text-foreground' : STATUS_TEXT[tone],
            )}
          >
            {title}
          </p>
          {/* Stays muted while healthy: the bar already carries the tone, and a
              coloured number at 12% would cry wolf. */}
          <span
            className={cn(
              'shrink-0 text-xs font-medium tabular-nums',
              headline === 'healthy' ? 'text-muted-foreground' : STATUS_TEXT[tone],
            )}
          >
            {t('percentFull', { percent })}
          </span>
        </div>

        <Progress
          value={drawn ? percent : 0}
          aria-label={t('meterLabel')}
          className="bg-foreground/10 h-1.5"
          indicatorClassName={cn(STATUS_DOT[tone], 'motion-reduce:transition-none')}
        />

        <div className="flex items-baseline justify-between gap-3 text-xs">
          <span className="text-muted-foreground tabular-nums">
            {t('usedCount', { used: formatContextCount(breakdown.total) })}
          </span>
          <span className="text-foreground font-medium tabular-nums">
            {t('remainingCount', { remaining: formatContextCount(remaining) })}
          </span>
        </div>
      </div>

      {/* Tier 3 — composition. Only kinds the model actually reported. */}
      {rows.length > 0 ? (
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 border-t pt-3 text-xs">
          {rows.map((row) => (
            <Fragment key={row.key}>
              <dt className="text-muted-foreground truncate">{t(row.labelKey)}</dt>
              <dd className="text-foreground text-end font-medium tabular-nums">
                {formatContextCount(breakdown[row.key])}
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : null}

      <p className="text-muted-foreground flex items-baseline justify-between gap-3 border-t pt-3 text-xs">
        <span className="truncate">{modelName ?? t('modelUnknown')}</span>
        <span className="shrink-0 tabular-nums">
          {t('windowMeta', { limit: formatContextCount(limit) })}
        </span>
      </p>

      {tip ? (
        <p className="text-muted-foreground flex gap-1.5 text-xs text-pretty">
          <WarningIcon weight="fill" className={cn('mt-0.5 size-3.5 shrink-0', STATUS_TEXT[tone])} />
          <span>{tip}</span>
        </p>
      ) : null}

      {interactive && onViewDetails ? (
        <Button
          type="button"
          variant="accent"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onViewDetails();
          }}
          className="w-full justify-between rounded-sm px-2.5 text-xs active:scale-[0.97]"
        >
          {t('viewDetails')}
          <CaretRightIcon className="text-muted-foreground size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

export function TokenProgress({
  messages,
  models,
  selectedModel,
  onContextClick,
}: TokenProgressProps) {
  const t = useTranslations('hardcodedUi.featuresSessionComposerTokenProgress');
  const breakdown = useMemo(() => getLastAssistantTokenBreakdown(messages), [messages]);
  const contextLimit = useMemo(
    () => getContextLimit(models, selectedModel),
    [models, selectedModel],
  );
  const modelName = useMemo(
    () => getSelectedModelName(models, selectedModel),
    [models, selectedModel],
  );
  const contextTokens = breakdown.total;
  const ratio = contextTokens > 0 ? Math.min(contextTokens / contextLimit, 1) : 0;

  if (contextTokens === 0 && !onContextClick) return null;

  const tone = contextTone(ratio);
  const color = STATUS_TEXT[tone];
  const percent = Math.round(ratio * 100);
  // Screen readers get the reading, not just the band — "Getting full" alone
  // omits the one number a sighted user gets from the arc.
  const ariaLabel = `${t(HEADLINE_TITLE_KEY[contextUsageHeadlineKind(tone)])} — ${t('percentFull', { percent })}`;

  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        <span data-slot="token-progress" className="relative inline-flex shrink-0">
          <Button
            variant="transparent"
            size="icon"
            type="button"
            // `hit-area-1`: the ring is a 28px control and, on a phone, the
            // ONLY way into the context modal — the hover card that carries
            // the same detail never opens on touch. The glyph keeps its size;
            // the pressable box reaches 40px.
            className="hit-area-1"
            aria-label={ariaLabel}
            onPointerDown={(e) => {
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              onContextClick?.();
            }}
          >
            <ProgressRing
              value={percent}
              className="size-[1.05rem]"
              progressClassName={color}
            />
          </Button>
        </span>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="center" sideOffset={8} className="w-72 p-3.5 shadow-md">
        <ContextUsageCard
          breakdown={breakdown}
          limit={contextLimit}
          ratio={ratio}
          tone={tone}
          modelName={modelName}
          interactive={Boolean(onContextClick)}
          onViewDetails={onContextClick}
        />
      </HoverCardContent>
    </HoverCard>
  );
}
