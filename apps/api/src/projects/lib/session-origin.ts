// Session ORIGIN — the policy class of a session, orthogonal to its surface
// (SessionInvocationSource, which says ui/slack/cron/...). Origin answers "who
// started this and what may they override": a human member (`user`), an event
// or schedule (`trigger`/`schedule`), a wrapper's server-to-server backend
// (`backend`, a service-account vouching for its own end-user), or an internal
// system flow (`system`).
//
// Origin is DERIVED from the caller's token kind + invocation source — it is
// NEVER read from the request body, so a caller can't claim `backend` to unlock
// backend-only overrides. See resolveSessionOrigin.

export type SessionOrigin = 'user' | 'trigger' | 'schedule' | 'backend' | 'system';

/**
 * Fields a session-start caller may attempt to override on the create body.
 * Most already ship (connectors/model/agent/runtime_context); `secrets` and
 * `skills` are placeholders for later phases so the gate is ready for them.
 */
export type SessionOverrideField =
  | 'connectors'
  | 'secrets'
  | 'model'
  | 'agent'
  | 'skills'
  | 'runtime_context'
  | 'origin_ref';

/**
 * Derive the session origin from the authenticated caller's token kind
 * (`authType`, set by the auth middleware: service_account | pat | apiKey |
 * supabase), its `apiKeyType` (user | sandbox, only meaningful when
 * authType==='apiKey'), whether the token is agent-scoped, and the invocation
 * `source` (SessionInvocationSource).
 *
 * Resolution order:
 *  1. Source-based classes win first — an invocation is a schedule/trigger/
 *     system regardless of which token drove it.
 *  2. An IN-SESSION token — one operating from inside a running session, i.e.
 *     bound to a session or carrying an agent grant (`inSession`) — is always
 *     `user`. This is the SECURITY-CRITICAL exclusion: the executor PAT
 *     injected into every sandbox (KORTIX_CLI_TOKEN, minted with
 *     sessionId=sandboxId; its agent grant is NULL for a v1/default agent or an
 *     ungoverned project) must never resolve `backend`, so a prompt-injectable
 *     in-sandbox agent can't vouch for a phantom end-user via origin_ref.
 *     Keyed on session-binding, NOT on the agent grant alone — a null grant is
 *     the common case and would fail open.
 *  3. The programmatic customer credentials are `backend`: a service-account
 *     bearer (`service_account`), the personal/account API token the app
 *     labels "API key" (`pat`), and a dedicated account API key
 *     (`apiKey` + apiKeyType `user`). All resolve to backend so they may set
 *     backend-only overrides (origin_ref, and later secrets).
 *  4. Everything else — a human web/SAML session (`supabase`) and, critically,
 *     the INTERNAL sandbox key (`apiKey` + apiKeyType `sandbox`, injected as
 *     KORTIX_TOKEN) — is `user`. The sandbox exclusion uses the POSITIVE
 *     apiKeyType==='user' test on purpose: a missing/unknown apiKeyType must
 *     never be promoted to backend.
 */
export function resolveSessionOrigin(input: {
  authType?: string | null;
  apiKeyType?: string | null;
  /** The token operates from inside a running session (session-bound OR
   *  agent-scoped). Such a token is never a customer backend — see the
   *  executor-PAT exclusion above. */
  inSession?: boolean | null;
  source?: string | null;
}): SessionOrigin {
  // `source` ultimately comes from session metadata (arbitrary JSON) — coerce
  // defensively so a non-string value can't make `startsWith` throw and break
  // session creation.
  const source = typeof input.source === 'string' ? input.source : '';
  if (source === 'trigger:cron') return 'schedule';
  if (source.startsWith('trigger:')) return 'trigger';
  if (source.startsWith('system:')) return 'system';
  if (input.inSession) return 'user';
  if (input.authType === 'service_account') return 'backend';
  if (input.authType === 'pat') return 'backend';
  // Forward-looking: no session-create surface authenticates a `kortix_` 'user'
  // API key today (supabaseAuth only admits sandbox-type kortix tokens, on four
  // non-create paths); this branch goes live when a combinedAuth-mounted backend
  // create route (or a 'user' key issuance path) lands. Harmless until then.
  if (input.authType === 'apiKey' && input.apiKeyType === 'user') return 'backend';
  return 'user';
}

/**
 * Override fields only a trusted backend-origin session may set (a service
 * account, or the account API key / PAT — see resolveSessionOrigin).
 * Everything else stays as open as today — a project member can already pass
 * connectors/model/agent/runtime_context, so gating those would be a
 * regression. The two backend-only fields are genuinely new/sensitive:
 *  - `origin_ref`: vouching for a wrapper's end-user (attribution + per-user
 *    profile resolution) — only a backend may assert who its user is.
 *  - `secrets`: injecting a secret bundle by reference (a later phase).
 */
const BACKEND_ONLY_FIELDS: ReadonlySet<SessionOverrideField> = new Set(['origin_ref', 'secrets']);

/**
 * Whether a session of the given origin may set the given override field.
 * v1 policy: backend may set anything; every other origin may set anything
 * EXCEPT the backend-only fields above (kept back-compatible on purpose). The
 * origin parameter keeps the door open for tightening specific fields per
 * origin later without changing callers.
 */
export function canOverride(origin: SessionOrigin, field: SessionOverrideField): boolean {
  if (origin === 'backend') return true;
  return !BACKEND_ONLY_FIELDS.has(field);
}
