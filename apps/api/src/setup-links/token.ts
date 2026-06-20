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
const DEFAULT_TTL_MINUTES = 30;
const MIN_TTL_MINUTES = 1;
const MAX_TTL_MINUTES = 24 * 60;

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
  | (BasePayload & { kind: 'secret'; fields: SecretFieldSpec[]; scope: SecretScope })
  | (BasePayload & { kind: 'connector'; slug: string; app: string | null; mode: 'shared' | 'per_user' });

export function clampTtlMinutes(minutes?: number | null): number {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return DEFAULT_TTL_MINUTES;
  return Math.min(MAX_TTL_MINUTES, Math.max(MIN_TTL_MINUTES, Math.floor(minutes)));
}

type SecretSpec = { kind: 'secret'; fields: SecretFieldSpec[]; scope?: SecretScope; uid?: string | null };
type ConnectorSpec = {
  kind: 'connector';
  slug: string;
  app?: string | null;
  mode?: 'shared' | 'per_user';
  uid?: string | null;
};

export function mintSetupLink(
  projectId: string,
  spec: SecretSpec | ConnectorSpec,
  opts?: { expiresInMinutes?: number | null },
): { token: string; expiresAt: number } {
  const exp = Date.now() + clampTtlMinutes(opts?.expiresInMinutes) * 60_000;
  const nonce = randomBytes(9).toString('base64url');
  const base: BasePayload = { exp, nonce, pid: projectId, uid: spec.uid ?? null };

  const payload: SetupLinkPayload =
    spec.kind === 'secret'
      ? { ...base, kind: 'secret', fields: spec.fields, scope: spec.scope ?? 'runtime' }
      : { ...base, kind: 'connector', slug: spec.slug, app: spec.app ?? null, mode: spec.mode ?? 'shared' };

  const envelope = encryptProjectSecret(projectId, JSON.stringify(payload));
  const token = TOKEN_PREFIX + Buffer.from(`${projectId}.${envelope}`, 'utf8').toString('base64url');
  return { token, expiresAt: exp };
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

  if (payload.pid !== projectId) return { ok: false, status: 404, error: 'Invalid or unknown link' };
  if (typeof payload.exp !== 'number' || Date.now() > payload.exp) {
    return { ok: false, status: 410, error: 'This link has expired — ask the agent for a fresh one' };
  }
  return { ok: true, projectId, payload };
}
