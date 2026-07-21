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
 * supabase) and the invocation `source` (SessionInvocationSource).
 *
 * Source-based classes win first (an invocation is a schedule/trigger/system
 * regardless of which token drove it); otherwise a service-account is a
 * `backend`, and everything else is a `user`. Unknown/missing inputs default to
 * the most restrictive real-caller class, `user`.
 */
export function resolveSessionOrigin(input: {
  authType?: string | null;
  source?: string | null;
}): SessionOrigin {
  const source = input.source ?? '';
  if (source === 'trigger:cron') return 'schedule';
  if (source.startsWith('trigger:')) return 'trigger';
  if (source.startsWith('system:')) return 'system';
  if (input.authType === 'service_account') return 'backend';
  return 'user';
}

/**
 * Override fields only a trusted backend (service-account) session may set.
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
