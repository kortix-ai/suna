/**
 * Whose fault is a dead-lettered command?
 *
 * A dead letter means this command's work was abandoned, and that is worth an
 * `error` when the PLATFORM dropped it — a runtime that never came up, a
 * delivery nothing confirmed. The severity was raised to `error` for exactly
 * that reason: the failure used to hide in a `console.warn` while a user's
 * session sat "queued — agent picking up" for ever.
 *
 * Most dead letters are not that. PROD, three days to 2026-09-10: 3,238 dead
 * letters, and 3,113 of them (96%) were a cron trigger firing into an account
 * that is out of credits — one account alone produced 2,131, roughly one every
 * two minutes. Nothing is broken there. The account cannot pay, the product
 * already says so where its owner can see it, and the command is correctly
 * refused on the first attempt without a retry.
 *
 * Paging on that teaches everyone to ignore the channel, which is how a real
 * abandoned delivery goes unnoticed. So the severity follows the CAUSE: a
 * terminal customer-state refusal is a `warn` that still carries every
 * structured field, and anything else stays an `error`.
 *
 * Deliberately matched on the message the caller already produced rather than
 * on a new error class: these strings are the user-facing copy of the gates
 * that produced them (billing, model entitlement, workspace mode), they are
 * asserted in the tests below, and an unrecognised message stays an error —
 * the safe direction.
 */

import { CONNECTOR_REFUSAL_CODES, PromptDeliveryRefused } from './prompt-delivery-refusal';
import type { PromptFailureCode } from './types';

// Billing: "Out of credits. Top up to continue." / "Your team wallet is out
// of credits. Top up to keep your agents running."
const BILLING_PATTERNS: ReadonlyArray<RegExp> = [
  /out of credits/i,
  /top up to (continue|keep)/i,
  /insufficient credits/i,
];

// Entitlement: 'Model "codex/gpt-5.6-sol" is not available for this account'
const ENTITLEMENT_PATTERNS: ReadonlyArray<RegExp> = [/is not available for this account/i];

const CUSTOMER_STATE_PATTERNS: ReadonlyArray<RegExp> = [
  ...BILLING_PATTERNS,
  ...ENTITLEMENT_PATTERNS,
  // Manifest/config the owner controls:
  // 'workspace mode "read" requires restricted workspace artifacts'
  /workspace mode ".*" requires/i,
];

export type DeadLetterCause = 'customer_state' | 'platform';

export function deadLetterCause(error: string | null | undefined): DeadLetterCause {
  const text = (error ?? '').trim();
  if (!text) return 'platform';
  return CUSTOMER_STATE_PATTERNS.some((pattern) => pattern.test(text))
    ? 'customer_state'
    : 'platform';
}

/**
 * The failure code a thrown delivery error names, for the drain's own give-up.
 *
 * Runs where the prompt fails, with the error object still in hand, and the
 * result is persisted on the row. The code comes from the refusal's HTTP status
 * and code first; the message patterns above only name billing and
 * entitlement, the two causes the gates state in their copy alone.
 *
 * A 402 is the billing gate (`BillingGateError`), whatever it says: out of
 * credits, no subscription, or no credit account. Any other refusal is
 * `refused`. An error that is not a refusal and matches no pattern is
 * `unknown`.
 */
export function promptFailureCodeForError(error: unknown): PromptFailureCode {
  const refusal = error instanceof PromptDeliveryRefused ? error : null;
  if (refusal?.code && CONNECTOR_REFUSAL_CODES.has(refusal.code)) return 'connector_required';
  if ((error as { status?: unknown } | null)?.status === 402) return 'out_of_credits';
  const message = (error instanceof Error ? error.message : typeof error === 'string' ? error : '').trim();
  if (BILLING_PATTERNS.some((pattern) => pattern.test(message))) return 'out_of_credits';
  if (ENTITLEMENT_PATTERNS.some((pattern) => pattern.test(message))) return 'model_unavailable';
  return refusal ? 'refused' : 'unknown';
}
