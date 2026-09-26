/**
 * Which card a turn error renders — pure, so the routing has a test.
 *
 * Ports of apps/web:
 * - `features/session/session-error-banner.tsx` — `TurnErrorDisplay` routing,
 *   `isInsufficientCreditsError`, `isUsageLimitError`, `parseBalance`;
 * - `features/session/turn/compaction-card.tsx` — compaction copy.
 *
 * No React / React Native import.
 */
import { isAbortError, type GatewayErrorDetails } from '@kortix/sdk';

import type { GatewayMetaDetails } from './busy-status';

/** Upstream 402 "Payment Required: Insufficient credits. Balance: $-0.06" and friends. */
export function isInsufficientCreditsError(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes('insufficient credits') ||
    lower.includes('out of credits') ||
    (lower.includes('payment required') && lower.includes('credit')) ||
    (lower.includes('402') && lower.includes('credit'))
  );
}

/** Free tier dry, inactive subscription, exhausted budget — a subscribe CTA, not a top-up. */
export function isUsageLimitError(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes('free usage') ||
    lower.includes('usage exceeded') ||
    lower.includes('usage limit') ||
    lower.includes('subscription required') ||
    lower.includes('subscription_required') ||
    lower.includes('budget exceeded') ||
    lower.includes('budget_exceeded') ||
    lower.includes('subscribe to') ||
    lower.includes('billing inactive')
  );
}

/** `Balance: $-0.06` → `$-0.06`; no amount → null. */
export function parseBalance(text: string): string | null {
  const match = text.match(/balance:\s*\$?(-?\d+(?:\.\d+)?)/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  if (Number.isNaN(value)) return null;
  return `$${value.toFixed(2)}`;
}

/**
 * The structural slice of `@kortix/sdk/react`'s `KortixSendError` this module
 * reads. Mobile does not import `@kortix/sdk/react`; any `KortixSendError`
 * satisfies this shape.
 */
export interface TurnSendErrorLike {
  kind: string;
  message: string;
  billing?: { detail?: { code?: unknown } | null } | null;
  gateway?: Partial<GatewayMetaDetails> | null;
}

export interface TurnErrorInput {
  /** Turn-level error text (`getTurnError`). Ignored when `error` is present. */
  errorText?: string;
  /** Gateway fields for `errorText` (`getTurnErrorDetails`). `error.gateway` wins. */
  errorDetails?: Partial<GatewayErrorDetails> | null;
  /** Typed send failure. */
  error?: TurnSendErrorLike | null;
  /** The turn's structured error IS an abort. Undefined → prose sniff via `isAbortError`. */
  isAbort?: boolean;
}

export type TurnErrorCard =
  | { kind: 'none' }
  | { kind: 'credits'; text: string }
  | { kind: 'usage-limit'; text: string }
  | { kind: 'error'; text: string; gateway: Partial<GatewayMetaDetails> | undefined };

const USAGE_LIMIT_CODES: ReadonlySet<string> = new Set(['subscription_required', 'no_account', 'budget_exceeded']);

/** Web `TurnErrorDisplay`'s branch order, verbatim. */
export function turnErrorCard({ errorText, errorDetails, error, isAbort }: TurnErrorInput): TurnErrorCard {
  const text = error ? error.message : errorText;
  if (!text) return { kind: 'none' };
  const gateway = error?.gateway ?? errorDetails ?? undefined;

  // A connector refusal is owned by the connector notice, which has the remedy.
  if (error?.kind === 'connector') return { kind: 'none' };
  // A stop the user asked for is not a failure to report.
  if (isAbort ?? isAbortError(text)) return { kind: 'none' };

  if (error?.kind === 'billing') {
    const code = error.billing?.detail?.code as string | undefined;
    const usageLimit = (code !== undefined && USAGE_LIMIT_CODES.has(code)) || (!code && isUsageLimitError(text));
    return usageLimit ? { kind: 'usage-limit', text } : { kind: 'credits', text };
  }
  if (isInsufficientCreditsError(text)) return { kind: 'credits', text };
  if (isUsageLimitError(text)) return { kind: 'usage-limit', text };
  return { kind: 'error', text, gateway: gateway ?? undefined };
}

/** The gateway's "what to do", unless it only repeats the title. */
export function turnErrorSuggestion(
  text: string,
  gateway: Partial<GatewayMetaDetails> | undefined,
): string | undefined {
  return gateway?.suggestion && gateway.suggestion !== text ? gateway.suggestion : undefined;
}

// ─── Compaction copy ─────────────────────────────────────────────────────────

export const COMPACTION_LABEL_LOADING = 'Compacting context…';
export const COMPACTION_LABEL_DONE = 'Context automatically compacted';

export function compactionFailedLabel({ error, isAbort }: { error?: string | null; isAbort?: boolean }): string {
  if (isAbort) return 'Compaction stopped';
  return error ? 'Compaction failed' : 'Compaction incomplete';
}
