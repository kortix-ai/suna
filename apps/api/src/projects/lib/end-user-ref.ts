/**
 * `end_user_ref` — the wrapper's opaque handle for the END-USER a backend
 * session acts for.
 *
 * Formerly `origin_ref`, which read as "a reference to the origin" (i.e. WHICH
 * APP) when it actually means "a reference within the origin" (i.e. WHICH OF
 * YOUR USERS). The old name invited callers to put a request id, a tenant, or an
 * app name there — all of which produce a usage breakdown that looks correct and
 * bills nobody in particular.
 *
 * `origin_ref` stays accepted forever as a deprecated alias: it is a published
 * wire field, and breaking it would break live wrappers for a naming fix.
 */
export interface EndUserRefInput {
  end_user_ref?: unknown;
  origin_ref?: unknown;
}

export type EndUserRefResolution =
  | { ok: true; value: string | null; suppliedUnder: 'end_user_ref' | 'origin_ref' | null }
  | { ok: false; code: 'END_USER_REF_CONFLICT'; message: string };

/**
 * Resolve the end-user handle from either spelling.
 *
 * Both may be sent (a client mid-migration), but only if they AGREE — silently
 * preferring one would misattribute every usage row for that session, and the
 * caller would have no way to tell which won.
 *
 * `suppliedUnder` reports whether the caller supplied ANYTHING, which is what
 * the origin gate keys on: a whitespace-only value must still trip the 403
 * rather than being normalised to null and slipping past it.
 */
export function resolveEndUserRef(body: EndUserRefInput): EndUserRefResolution {
  const modern = typeof body.end_user_ref === 'string' ? body.end_user_ref : null;
  const legacy = typeof body.origin_ref === 'string' ? body.origin_ref : null;

  if (modern !== null && legacy !== null && modern.trim() !== legacy.trim()) {
    return {
      ok: false,
      code: 'END_USER_REF_CONFLICT',
      message:
        'end_user_ref and its deprecated alias origin_ref were both supplied with different values — send only end_user_ref',
    };
  }

  const raw = modern ?? legacy;
  const suppliedUnder = modern !== null ? 'end_user_ref' : legacy !== null ? 'origin_ref' : null;
  if (raw === null) return { ok: true, value: null, suppliedUnder: null };
  // Supplied-but-blank still counts as supplied for the origin gate; the VALUE
  // normalises to null so a whitespace handle never reaches the ledger.
  const trimmed = raw.trim();
  return {
    ok: true,
    value: trimmed.length > 0 ? trimmed : null,
    suppliedUnder: raw.length > 0 ? suppliedUnder : null,
  };
}
