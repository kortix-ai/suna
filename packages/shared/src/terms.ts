/**
 * The version of the Kortix Terms of Service. apps/web renders the text
 * (`legal/terms-of-service.ts`). Procedure: the `compliance` skill.
 *
 * Terms section 16: a material change needs 30 days' notice. Set
 * `TERMS_VERSION` to the day the change merges and `TERMS_EFFECTIVE` 37 days
 * later (the release has 7 days to reach prod). A non-material edit (a typo)
 * keeps the version.
 */

export const TERMS_VERSION = "2026-10-28";
export const TERMS_EFFECTIVE = "2026-12-04";
export const TERMS_PREVIOUS_VERSION = "2026-07-14";
