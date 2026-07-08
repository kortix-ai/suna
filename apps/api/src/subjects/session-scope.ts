import type { AgentGrant } from '@kortix/db';

/**
 * Subject identity — the security primitives for "Kortix as a backend".
 *
 * A SUBJECT is an opaque external end-user identity the operator asserts through
 * their own credential (see docs/specs/2026-07-08-kortix-as-a-backend-subject-identity.md).
 * A subject-scoped session token (`account_tokens.backend_scoped = true`,
 * `subject_id` set) is the only credential safe to hand to an untrusted browser:
 * it is bound to ONE session and MUST NOT reach any other session, any secret, or
 * any account route.
 *
 * This module is intentionally free of Hono/DB imports so the boundary logic — the
 * part where a mistake is a security hole — is pure and exhaustively unit-testable.
 * The middleware calls `checkSessionScope` and throws on a violation.
 */

/**
 * The locked, interact-only grant stamped onto a subject-scoped session token.
 * It denies every capability an untrusted driver must never have:
 *   - `kortixCli: []`  → no Kortix CLI/API actions (no CR open/merge, no reads of
 *     other sessions, no member/connector management).
 *   - `connectors: []` → cannot invoke any connector directly (the operator's BFF
 *     brokers connector use server-side when it wants to expose it).
 *   - `env: []`        → cannot receive or read ANY project secret.
 *
 * The effective grant is still intersected with the launching principal's role by
 * the IAM engine, so this can only ever NARROW. The agent name is carried through
 * purely so attribution/telemetry keeps working.
 */
export function lockedSubjectGrant(agent: string): AgentGrant {
  return { agent, kortixCli: [], connectors: [], env: [] };
}

/** True when `grant` is the fully-locked interact-only shape (all denies). */
export function isLockedSubjectGrant(grant: AgentGrant | null | undefined): boolean {
  if (!grant) return false;
  const empty = (v: string[] | 'all' | undefined) => Array.isArray(v) && v.length === 0;
  return empty(grant.kortixCli) && empty(grant.connectors) && empty(grant.env);
}

/**
 * Extract the session (sandbox) id a request is targeting, or null if the path is
 * not session-addressed. Covers the two surfaces a subject-scoped token legitimately
 * hits:
 *   - `/v1/projects/<projectId>/sessions/<sessionId>/...`
 *   - `/v1/p/<sandboxId>/...`   (the preview/runtime proxy — sandboxId === sessionId)
 *
 * A path with no session segment returns null; the caller decides whether a
 * non-session-addressed path is allowed for a backend-scoped token (it is not —
 * see `checkSessionScope`).
 */
export function requestedSessionId(path: string): string | null {
  const sessions = path.match(/^\/v1\/projects\/[^/]+\/sessions\/([^/]+)/);
  if (sessions?.[1]) return decodeURIComponent(sessions[1]);
  const proxy = path.match(/^\/v1\/p\/([^/]+)/);
  if (proxy?.[1]) return decodeURIComponent(proxy[1]);
  return null;
}

export interface SessionScopeInput {
  /** Is this a subject-scoped backend token? Non-backend tokens are never gated here. */
  backendScoped: boolean;
  /** The single session this token is bound to. */
  tokenSessionId: string | null | undefined;
  /** The request path (e.g. c.req.path). */
  path: string;
}

export interface SessionScopeVerdict {
  ok: boolean;
  /** Present when `ok` is false — a safe, non-leaky reason for the 403. */
  reason?: string;
}

/**
 * The boundary. Returns `{ ok: true }` for any non-backend token (behavior is
 * unchanged for every existing credential). For a backend-scoped token it allows
 * the request ONLY when the path targets exactly the token's own session; every
 * other surface — a different session, or any non-session-addressed route — is a
 * violation.
 *
 * This deliberately fails closed: a backend token on a path with no session
 * segment (an account route, a project-wide list, a secrets endpoint) is rejected,
 * because a subject-scoped token has no business anywhere but its own session.
 */
export function checkSessionScope(input: SessionScopeInput): SessionScopeVerdict {
  if (!input.backendScoped) return { ok: true };

  // A backend-scoped token with no bound session is malformed — refuse.
  if (!input.tokenSessionId) {
    return { ok: false, reason: 'Subject-scoped token is not bound to a session' };
  }

  const target = requestedSessionId(input.path);
  if (target === null) {
    return { ok: false, reason: 'Subject-scoped token can only access its own session' };
  }
  if (target !== input.tokenSessionId) {
    return { ok: false, reason: 'Subject-scoped token cannot access a different session' };
  }
  return { ok: true };
}
