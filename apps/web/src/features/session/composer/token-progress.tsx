'use client';

import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

import { Button } from '@/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
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
// Hover opens a HoverCard (not Hint): richer mixed-audience copy — plain
// headline + fill bar + Used/Limit rows. Absolute counts live in the card;
// the ring alone stays the ambient glanceable meter.

interface TokenProgressProps {
  messages: MessageWithParts[] | undefined;
  models?: FlatModel[];
  selectedModel?: { providerID: string; modelID: string } | null;
  onContextClick?: () => void;
}

export function getLastAssistantTokenTotal(messages: MessageWithParts[] | undefined): number {
  if (!messages) return 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info.role !== 'assistant') continue;
    const t = (msg.info as any).tokens;
    if (!t) continue;
    const total =
      (t.input ?? 0) +
      (t.output ?? 0) +
      (t.reasoning ?? 0) +
      (t.cache?.read ?? 0) +
      (t.cache?.write ?? 0);
    if (total > 0) return total;
  }
  return 0;
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

function ContextUsageCard({
  used,
  limit,
  ratio,
  tone,
  interactive,
  onViewDetails,
}: {
  used: number;
  limit: number;
  ratio: number;
  tone: StatusTone;
  interactive: boolean;
  onViewDetails?: () => void;
}) {
  const t = useTranslations('hardcodedUi.featuresSessionComposerTokenProgress');
  const percent = Math.round(ratio * 100);
  const headline = contextUsageHeadlineKind(tone);
  const title = t(HEADLINE_TITLE_KEY[headline]);
  const tipKey = HEADLINE_TIP_KEY[headline];
  const tip = tipKey ? t(tipKey) : null;

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <p
          className={cn(
            'text-sm font-medium text-pretty',
            headline === 'healthy' ? 'text-foreground' : STATUS_TEXT[tone],
          )}
        >
          {title}
        </p>
        <div className="flex items-center gap-2.5">
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/10">
            <div
              aria-hidden
              className={cn(
                'h-full w-full origin-left rounded-full transition-transform duration-200 ease-out',
                STATUS_DOT[tone],
              )}
              style={{ transform: `scaleX(${ratio})` }}
            />
          </div>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {t('percentFull', { percent })}
          </span>
        </div>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t('labelUsed')}</dt>
        <dd className="text-end font-medium tabular-nums">{formatContextCount(used)}</dd>
        <dt className="text-muted-foreground">{t('labelLimit')}</dt>
        <dd className="text-end font-medium tabular-nums text-muted-foreground">
          {formatContextCount(limit)}
        </dd>
      </dl>

      {tip ? <p className="text-xs text-pretty text-muted-foreground">{tip}</p> : null}

      {interactive && onViewDetails ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onViewDetails();
          }}
          className="text-xs font-medium text-foreground underline-offset-2 transition-colors duration-150 ease-out hover:underline"
        >
          {t('viewDetails')}
        </button>
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
  const contextTokens = useMemo(() => getLastAssistantTokenTotal(messages), [messages]);
  const contextLimit = useMemo(
    () => getContextLimit(models, selectedModel),
    [models, selectedModel],
  );
  const ratio = contextTokens > 0 ? Math.min(contextTokens / contextLimit, 1) : 0;

  if (contextTokens === 0 && !onContextClick) return null;

  const tone = contextTone(ratio);
  const color = STATUS_TEXT[tone];
  const ariaLabel = t(HEADLINE_TITLE_KEY[contextUsageHeadlineKind(tone)]);

  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        <span data-slot="token-progress" className="relative inline-flex shrink-0">
          <Button
            variant="transparent"
            size="icon"
            type="button"
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
              value={Math.round(ratio * 100)}
              className="size-[1.3rem]"
              progressClassName={color}
            />
          </Button>
        </span>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="center" sideOffset={8} className="w-56 p-3 shadow-md">
        <ContextUsageCard
          used={contextTokens}
          limit={contextLimit}
          ratio={ratio}
          tone={tone}
          interactive={Boolean(onContextClick)}
          onViewDetails={onContextClick}
        />
      </HoverCardContent>
    </HoverCard>
  );
}
