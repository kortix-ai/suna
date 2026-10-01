'use client';

import { CaretRightIcon, WarningIcon } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import { Fragment, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Progress } from '@/components/ui/progress';
import { STATUS_DOT, STATUS_TEXT, type StatusTone } from '@/components/ui/status';

import { cn } from '@/lib/utils';
import type { MessageWithParts } from '@kortix/sdk/react';
import { ContextRing } from './context-ring';
import { formatContextCount, getContextUsage } from './context-usage';
import type { ContextBreakdown } from './context-usage';

export {
  CONTEXT_DANGER_RATIO, CONTEXT_WARNING_RATIO, contextTone, formatContextCount,
  getContextLimit, getLastAssistantTokenBreakdown, getLastAssistantTokenTotal, getSelectedModelName,
} from './context-usage';
export type { ContextBreakdown } from './context-usage';

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

/**
 * Exported for the `/` palette: the "Show context" row's detail pane renders
 * this exact card (`menus/slash-menu.tsx`), so hovering the row shows the same
 * three-tier read as hovering the toolbar ring — one card, two openings, no
 * drift. The palette passes `interactive={false}` because its pane already
 * owns a "Use" button that opens the modal.
 */
export function ContextUsageCard({
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
          <WarningIcon
            weight="fill"
            className={cn('mt-0.5 size-3.5 shrink-0', STATUS_TEXT[tone])}
          />
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
  const { breakdown, limit: contextLimit, ratio, tone, percent, modelName } = useMemo(
    () => getContextUsage(messages, models, selectedModel),
    [messages, models, selectedModel],
  );
  if (breakdown.total === 0 && !onContextClick) return null;

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
            {/* The shared ring (`context-ring.tsx`) — the `/` palette's
                "Show context" row draws the same component, so the two
                surfaces cannot drift apart in fill or tone. */}
            <ContextRing percent={percent} tone={tone} className="size-[1.05rem]" />
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
