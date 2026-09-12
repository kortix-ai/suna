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

const CUSTOMER_STATE_PATTERNS: ReadonlyArray<RegExp> = [
  // Billing: "Out of credits. Top up to continue." / "Your team wallet is out
  // of credits. Top up to keep your agents running."
  /out of credits/i,
  /top up to (continue|keep)/i,
  /insufficient credits/i,
  // Entitlement: 'Model "codex/gpt-5.6-sol" is not available for this account'
  /is not available for this account/i,
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
