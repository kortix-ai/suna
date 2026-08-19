export const AUTO_TOPUP_DEFAULT_THRESHOLD = 1;
export const AUTO_TOPUP_DEFAULT_AMOUNT = 5;
export const AUTO_TOPUP_MIN_THRESHOLD = 1;
export const AUTO_TOPUP_MIN_AMOUNT = 1;
/**
 * Buffer the topup amount must add above the threshold. Without it, a topup
 * of $5 with threshold $5 would re-trigger on every subsequent debit and
 * charge the user repeatedly. Shared so the client can enforce the identical
 * rule the server enforces in `validateAutoTopupConfig`
 * (apps/api/src/billing/services/auto-topup.ts) instead of maintaining a
 * second copy that could drift.
 */
export const AUTO_TOPUP_MIN_BUFFER = 1;
