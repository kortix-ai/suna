/**
 * Does an auth "parameter name" look like the SECRET itself?
 *
 * The Connection form's Auth block sets how a credential travels — the
 * parameter's NAME (`Authorization`, `X-Api-Key`) and placement — while the
 * key itself is entered through Connect. Nothing said so, and the very first
 * user pasted their PostHog `phx_…` key into "Parameter name", then met the
 * Connect dialog asking for "the value" they thought they had already given
 * (Jay, 2026-09-17). Real parameter names are short dictionary-ish tokens;
 * real keys are long alphanumeric strings, usually with a vendor prefix.
 */
const SECRET_PREFIX = /^(phx_|sk[-_]|pk[-_]|ghp_|gho_|github_pat_|xox[a-z]-|glpat-|ntn_|secret_)/i;

export function parameterNameLooksLikeSecret(name: string): boolean {
  const value = name.trim();
  if (value.length === 0 || /\s/.test(value)) return false;
  if (SECRET_PREFIX.test(value)) return true;
  // Long, digit-carrying single tokens are keys; header/query names are
  // short and rarely carry digits ("Authorization", "X-Api-Key", "api_key").
  return value.length >= 24 && /\d/.test(value);
}
