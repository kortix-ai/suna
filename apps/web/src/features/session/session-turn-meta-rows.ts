import type { UiTranslator } from '@kortix/ui/i18n';
/**
 * Pure derivation of a turn's "when did this finish, how long did it take,
 * what did it cost" meta — no React, no clock read of its own. `now` is
 * always injected so the "N ago" wording is testable and a re-render derives
 * the whole set from one clock read rather than each row racing its own.
 */

import type { TurnCostInfo } from '@/ui';
import { formatDuration, formatTokens } from '@/ui';
import type { SessionLogMessage, SessionLogTurn } from '@kortix/sdk';
import { formatUsdAsCredits } from '@kortix/shared';
import { formatDistanceStrict } from 'date-fns';

import type { TurnServedModel } from './turn/served-model';

export interface SessionTurnSpan {
  startedAt: number | null;
  endedAt: number | null;
}

/** A record time (`created_at` / `completed_at`, ISO) as epoch ms; null when absent. */
const msOf = (iso: string | null | undefined): number | null => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

/** A turn's wall-clock bounds: when the user's prompt landed, and when the
 *  agent last produced something for it. `endedAt` prefers the last reply's
 *  `completed_at` — the point the response was actually done — and falls back
 *  to its `created_at` for a reply that never got one (e.g. it was
 *  interrupted before finishing). */
export function sessionTurnSpan(turn: Pick<SessionLogTurn, 'user' | 'assistant'>): SessionTurnSpan {
  const startedAt = msOf(turn.user.created_at);
  const lastAssistant: SessionLogMessage | undefined = turn.assistant[turn.assistant.length - 1];
  const endedAt = msOf(lastAssistant?.completed_at) ?? msOf(lastAssistant?.created_at);
  return { startedAt, endedAt };
}

export function sessionTurnEndedAt(turn: Pick<SessionLogTurn, 'user' | 'assistant'>): number | null {
  return sessionTurnSpan(turn).endedAt;
}

/** How long the turn took. `null` whenever that isn't knowable, INCLUDING
 *  `endedAt === startedAt`: one timestamp says WHEN a turn ended and says
 *  nothing about how long it took to get there, so a same-instant span is
 *  treated the same as no span at all rather than rendered as "0s". */
export function sessionTurnDurationMs(turn: Pick<SessionLogTurn, 'user' | 'assistant'>): number | null {
  const { startedAt, endedAt } = sessionTurnSpan(turn);
  if (startedAt == null || endedAt == null || endedAt <= startedAt) return null;
  return endedAt - startedAt;
}

export interface SessionTurnMetaRow {
  label: string;
  value: string;
}

/**
 * The turn's meta as labelled rows, in display order. A row is omitted
 * rather than rendered with a fabricated "$0.00" or "0 tokens" whenever the
 * underlying value is absent or zero — the guards below exist so a turn that
 * did nothing billable simply carries fewer rows, not zeroed-out ones.
 */
export function sessionTurnMetaRows(
  {
    endedAt,
    now,
    durationMs,
    cost,
    served,
  }: {
    endedAt: number | null;
    now: number;
    durationMs: number | null;
    cost: TurnCostInfo | null | undefined;
    /** The models that answered the turn, from the gateway's request record. */
    served?: TurnServedModel;
  },
  tI18nComplete: UiTranslator,
): SessionTurnMetaRow[] {
  const rows: SessionTurnMetaRow[] = [];

  if (endedAt != null) {
    rows.push({
      label: tI18nComplete.raw('text7804f7a79a9e'),
      // `Strict` never rounds up to a vague "about 1 minute" — the whole
      // point of this row is a precise *when*, not an approximation.
      value: formatDistanceStrict(endedAt, now, { addSuffix: true }),
    });
  }

  if (durationMs != null) {
    const value = formatDuration(durationMs);
    // formatDuration returns '' for sub-second durations — that's the
    // formatter's own "nothing worth showing" signal, so honor it here too.
    if (value) rows.push({ label: tI18nComplete.raw('text4fc52a3c4c55'), value });
  }

  if (served && served.models.length > 0) {
    rows.push({ label: tI18nComplete.raw('servedModelRow'), value: served.models.join(', ') });
    if (served.fallbackFrom) {
      rows.push({ label: tI18nComplete.raw('servedModelInPlaceOf'), value: served.fallbackFrom });
    }
  }

  // `cost` is the transcript's estimate, priced at the model the turn asked
  // for. When a fallback model answered, that price is for a model that did
  // not run, so the row shows what Kortix billed instead.
  const shownCost = served?.fallbackFrom ? served.billedCost : (cost?.cost ?? 0);
  // A zero renders as "0" — a real-looking number for a turn that spent
  // nothing — so the row is gated on the raw value, not the string. Spend
  // reads in credits (1 credit = $0.01); the label carries the unit.
  if (shownCost > 0) {
    rows.push({ label: tI18nComplete.raw('text0f046f7588f9'), value: formatUsdAsCredits(shownCost) });
  }

  // Deliberately `input + output` only, NOT every token field: `reasoning` /
  // `cacheRead` / `cacheWrite` are real counts, but a cache-read number far
  // bigger than the visible conversation would raise a question this single
  // row can't answer. A turn can be reasoning- or cache-heavy and legitimately
  // carry no Tokens row.
  const tokenTotal = cost ? cost.tokens.input + cost.tokens.output : 0;
  if (cost && tokenTotal > 0) {
    rows.push({ label: tI18nComplete.raw('texta039dfb9628b'), value: formatTokens(tokenTotal) });
  }

  return rows;
}
