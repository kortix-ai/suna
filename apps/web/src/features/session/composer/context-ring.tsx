'use client';

/**
 * The context-window ring — ONE component for every surface that draws it.
 *
 * The underbar meter (`token-progress.tsx`) and the `/` palette's
 * "Show context" row must be the same glyph with the same live reading and the
 * same status tone, or the palette row reads as a lookalike icon instead of
 * the control it opens. Extracted here so neither surface re-derives the
 * ring's look on its own.
 *
 * `getContextReading` is the pure derivation (percent + tone) over the same
 * exported helpers the hover card uses — pure so it has tests that can fail
 * (this repo's `bun test` has no DOM to assert the SVG itself).
 */

import { ProgressRing } from '@/components/ui/progress-ring';
import { STATUS_TEXT, type StatusTone } from '@/components/ui/status';
import type { MessageWithParts } from '@kortix/sdk/react';

import type { FlatModel } from '../model-flatten';
import {
  type ContextBreakdown,
  contextTone,
  getContextLimit,
  getLastAssistantTokenBreakdown,
  getSelectedModelName,
} from './token-progress';

/** A point-in-time reading of the context window: 0–100 plus its status band. */
export interface ContextReading {
  percent: number;
  tone: StatusTone;
}

/**
 * The reading plus everything behind it — the full snapshot the usage card
 * (`token-progress.tsx`'s `ContextUsageCard`) renders. One object, so a
 * surface that shows both the ring AND the card (the `/` palette's
 * "Show context" row) carries one snapshot and the two views cannot disagree.
 */
export interface ContextUsage extends ContextReading {
  breakdown: ContextBreakdown;
  limit: number;
  ratio: number;
  modelName: string | null;
}

export function getContextUsage(
  messages: MessageWithParts[] | undefined,
  models?: FlatModel[],
  selectedModel?: { providerID: string; modelID: string } | null,
): ContextUsage {
  const breakdown = getLastAssistantTokenBreakdown(messages);
  const limit = getContextLimit(models, selectedModel);
  const ratio = breakdown.total > 0 ? Math.min(breakdown.total / limit, 1) : 0;
  return {
    percent: Math.round(ratio * 100),
    tone: contextTone(ratio),
    breakdown,
    limit,
    ratio,
    modelName: getSelectedModelName(models, selectedModel),
  };
}

export function getContextReading(
  messages: MessageWithParts[] | undefined,
  models?: FlatModel[],
  selectedModel?: { providerID: string; modelID: string } | null,
): ContextReading {
  const { percent, tone } = getContextUsage(messages, models, selectedModel);
  return { percent, tone };
}

export function ContextRing({
  percent,
  tone,
  className,
}: ContextReading & { className?: string }) {
  return (
    <ProgressRing value={percent} className={className} progressClassName={STATUS_TEXT[tone]} />
  );
}
