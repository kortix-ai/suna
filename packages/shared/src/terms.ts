/**
 * The version of the Kortix Terms of Service and the notice of its changes.
 * apps/web renders the text (`legal/terms-of-service.ts`), and the API emails
 * the notice (`apps/api/src/billing/services/terms-notices.ts`). Procedure:
 * the `compliance` skill.
 *
 * Terms section 16: a material change needs 30 days' notice. Set
 * `TERMS_VERSION` to the day the change merges, `TERMS_EFFECTIVE` 37 days
 * later (the release has 7 days to reach prod), and `TERMS_CHANGES` to one
 * sentence per change. Prod emails the notice once to every paid account. A
 * non-material edit (a typo) keeps the version and `TERMS_CHANGES`.
 */

export const TERMS_VERSION = "2026-10-28";
export const TERMS_EFFECTIVE = "2026-12-04";
export const TERMS_PREVIOUS_VERSION = "2026-07-14";

/** What changes on `TERMS_EFFECTIVE`, one sentence each. */
export const TERMS_CHANGES: readonly string[] = [
  "Section 10 (Marks and publicity): Kortix may name an organization customer and show its logo in customer lists, such as on kortix.com and in sales materials. Quotes, case studies and endorsements still need the customer's written approval. A customer can opt out at any time by writing to legal@kortix.com.",
];

/** The notice Terms section 16 promises. */
export const TERMS_NOTICE_DAYS = 30;
