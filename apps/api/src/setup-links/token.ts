/**
 * Setup-link tokens — the opaque, short-lived handle behind every agent-minted
 * "fill this in" link (a project secret, or a Pipedream Quick Connect).
 *
 * Design (see references/kortix/credentials-and-setup-links.md):
 *   • STATELESS. There is no `setup_requests` table. The token IS the request:
 *     an AEAD envelope encrypted with the PROJECT's key (the same per-project
 *     HKDF key used for project secrets), so a token from one project can't be
 *     decrypted by another, and a tampered token simply fails to decrypt.
 *   • The token carries everything the public intake endpoints need: the kind,
 *     the requested field names (or connector slug), the chosen scope, the
 *     minting user, and an expiry. Modeled on the Codex device-auth flow handle
 *     in projects/routes/r3.ts, which seals its whole state into one encrypted
 *     `flow_id` for the same reasons.
 *   • VALUE-ONLY by construction: the field NAMES are fixed at mint time, so a
 *     leaked token can only SET the named keys in that one project before it
 *     expires — it can never read an existing secret or target another key.
 *
 * Wire format: `ksl_<base64url(projectId "." envelope)>`. projectId rides
 * outside only to pick the decryption key; the envelope is what's authenticated,
 * and `payload.pid` is cross-checked against it on resolve.
 */
import { randomBytes } from 'node:crypto';
import { decryptProjectSecret, encryptProjectSecret } from '../projects/secrets';

const TOKEN_PREFIX = 'ksl_';
// Secret/connector links are relayed out-of-band (Slack, email) to a human who
// may only act days later. A 24h default expired links before humans opened
// them and forced agent loops to re-mint + re-post every run (the duplicate
// "blocked" message stampede). 7 days matches the async human-in-the-loop
// reality; safe because the token is value-only — it can never read a secret.
const DEFAULT_TTL_MINUTES = 7 * 24 * 60;
const MIN_TTL_MINUTES = 1;
const MAX_TTL_MINUTES = 30 * 24 * 60;

export interface SecretFieldSpec {
  name: string;
  label?: string;
  description?: string;
}

export type SecretScope = 'runtime' | 'connector';

interface BasePayload {
  exp: number;
  nonce: string;
  /** projectId sealed inside the envelope; cross-checked against the outer id. */
  pid: string;
  /** The member who minted the link (the session owner). Recorded as created_by. */
  uid: string | null;
}

export type SetupLinkPayload =
  | (BasePayload & { kind: 'secret'; fields: SecretFieldSpec[]; scope: SecretScope; sid: string | null })
  /** `sid` is the session that asked for the connector, so the finalize route
   *  can tell it the credential landed. Tokens minted before it existed decode
   *  without the field — every read must tolerate `undefined`. */
  | (BasePayload & { kind: 'connector'; slug: string; app: string | null; sid: string | null })
  /**
   * A human-in-the-loop APPROVAL for one gated connector call.
   *
   * Unlike the other two kinds, this token is NOT a bearer capability: the
   * endpoints behind it require a signed-in Kortix account that is authorised to
   * approve in the project (manager, or the session's launcher). The token only
   * says WHICH decision is being asked for; it never confers the right to make
   * it. That distinction matters because a leaked approval link would otherwise
   * let an outsider authorise the exact action the gate exists to stop.
   */
  | (BasePayload & { kind: 'approval'; eid: string; sid: string | null });

export function clampTtlMinutes(minutes?: number | null): number {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return DEFAULT_TTL_MINUTES;
  return Math.min(MAX_TTL_MINUTES, Math.max(MIN_TTL_MINUTES, Math.floor(minutes)));
}

type SecretSpec = {
  kind: 'secret';
  fields: SecretFieldSpec[];
  scope?: SecretScope;
  uid?: string | null;
  /** The session that requested this secret, so the intake form can
   *  notify it when the value is submitted. */
  sid?: string | null;
};
type ConnectorSpec = {
  kind: 'connector';
  slug: string;
  app?: string | null;
  uid?: string | null;
  /** The session that requested this connector, so the finalize route can
   *  notify it when the connection is persisted. */
  sid?: string | null;
};
type ApprovalSpec = {
  kind: 'approval';
  /** The `connector_calls.execution_id` awaiting a decision. */
  executionId: string;
  sessionId?: string | null;
  uid?: string | null;
};

/**
 * Approvals keep a 24h window: an approval is a time-sensitive decision about
 * one gated call, not an async credential hand-off, so a week-old approval
 * link answering a stale question helps nobody. The token is not a capability
 * — the decision is still gated on a signed-in, authorised account — and the
 * pending row itself remains the authority: once resolved, a live link can do
 * nothing.
 */
const APPROVAL_TTL_MINUTES = 24 * 60;

export function mintSetupLink(
  projectId: string,
  spec: SecretSpec | ConnectorSpec | ApprovalSpec,
  opts?: { expiresInMinutes?: number | null },
): { token: string; expiresAt: number } {
  const defaultTtl = spec.kind === 'approval' ? APPROVAL_TTL_MINUTES : undefined;
  const exp = Date.now() + clampTtlMinutes(opts?.expiresInMinutes ?? defaultTtl) * 60_000;
  const nonce = randomBytes(9).toString('base64url');
  const base: BasePayload = { exp, nonce, pid: projectId, uid: spec.uid ?? null };

  const payload: SetupLinkPayload =
    spec.kind === 'secret'
      ? { ...base, kind: 'secret', fields: spec.fields, scope: spec.scope ?? 'runtime', sid: spec.sid ?? null }
      : spec.kind === 'approval'
        ? { ...base, kind: 'approval', eid: spec.executionId, sid: spec.sessionId ?? null }
        : {
            ...base,
            kind: 'connector',
            slug: spec.slug,
            app: spec.app ?? null,
            sid: spec.sid ?? null,
          };

  const envelope = encryptProjectSecret(projectId, JSON.stringify(payload));
  const token =
    TOKEN_PREFIX + Buffer.from(`${projectId}.${envelope}`, 'utf8').toString('base64url');
  return { token, expiresAt: exp };
}

/**
 * The standalone page a human opens to decide one gated call.
 *
 * Single source of truth for the URL shape — the gateway (relaying the link to
 * wherever the human is) and the session-audit read (linking from the in-session
 * notice) must produce identical links. Returns null if minting fails, so a
 * caller can degrade instead of throwing on a display path.
 */
export function approvalPageUrl(
  projectId: string,
  executionId: string,
  sessionId: string | null,
  frontendUrl?: string | null,
): string | null {
  try {
    const { token } = mintSetupLink(projectId, { kind: 'approval', executionId, sessionId });
    const base = (frontendUrl || process.env.FRONTEND_URL || 'http://localhost:3000').replace(
      /\/+$/,
      '',
    );
    return `${base}/approve/${token}`;
  } catch {
    return null;
  }
}

export type ResolvedSetupLink =
  | { ok: true; projectId: string; payload: SetupLinkPayload }
  | { ok: false; status: 404 | 410; error: string };

export function resolveSetupLink(token: string | undefined | null): ResolvedSetupLink {
  if (!token || !token.startsWith(TOKEN_PREFIX)) {
    return { ok: false, status: 404, error: 'Invalid or unknown link' };
  }
  let projectId: string;
  let envelope: string;
  try {
    // Reject non-canonical base64url spellings before decrypting the envelope.
    const encoded = token.slice(TOKEN_PREFIX.length);
    const decodedBytes = Buffer.from(encoded, 'base64url');
    if (decodedBytes.toString('base64url') !== encoded) {
      return { ok: false, status: 404, error: 'Invalid or unknown link' };
    }
    const decoded = decodedBytes.toString('utf8');
    const dot = decoded.indexOf('.');
    if (dot <= 0) return { ok: false, status: 404, error: 'Invalid or unknown link' };
    projectId = decoded.slice(0, dot);
    envelope = decoded.slice(dot + 1);
  } catch {
    return { ok: false, status: 404, error: 'Invalid or unknown link' };
  }

  let payload: SetupLinkPayload;
  try {
    payload = JSON.parse(decryptProjectSecret(projectId, envelope)) as SetupLinkPayload;
  } catch {
    // Wrong project key, tampered ciphertext, or garbage → indistinguishable
    // from "never existed". Don't leak which.
    return { ok: false, status: 404, error: 'Invalid or unknown link' };
  }

  if (payload.pid !== projectId)
    return { ok: false, status: 404, error: 'Invalid or unknown link' };
  // 60-second clock-skew buffer: in a load-balanced deployment the instance
  // that MINTED the token and the instance that RESOLVES it may have slightly
  // different system clocks. Without a buffer, a freshly-minted token can
  // resolve as expired on an instance whose clock is a few seconds ahead.
  if (typeof payload.exp !== 'number' || Date.now() > payload.exp + 60_000) {
    return {
      ok: false,
      status: 410,
      error: 'This link has expired — ask the agent for a fresh one',
    };
  }
  return { ok: true, projectId, payload };
}
