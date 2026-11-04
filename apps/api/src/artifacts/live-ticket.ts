/**
 * The single-use ticket that opens an Artifact's live socket (KRTX-3669).
 *
 * A browser cannot set `Authorization` on a WebSocket, and the JWT must never
 * go into a URL. So `POST …/live/ticket` runs the ordinary REST view check and
 * answers a ticket; the socket opens with `?ticket=`.
 *
 * WHY SEALED, NOT STORED. Dev and prod run 2+ API pods behind one load
 * balancer: the ticket POST and the upgrade land on different pods. A stored
 * ticket would need a table (a migration) or a round trip to the minting pod.
 * The ticket instead carries its claims (the actor, the Artifact, the expiry
 * and a 128-bit random nonce), sealed with AES-256-GCM under a key derived
 * with HKDF-SHA256 from `API_KEY_SECRET` (info `kortix-artifact-live-ticket-v1`).
 * Every pod opens it alone. It is `base64url(iv ‖ ciphertext ‖ tag)`: the URL,
 * and so every proxy and access log, holds no readable id, and a changed byte
 * fails the GCM tag.
 *
 * SINGLE USE. The first pod that accepts a ticket records its SHA-256 digest in
 * this replica-local map and sends the digest on `kortix_artifact_live`; every
 * other pod records it on receipt. A digest leaves the map when the ticket
 * would have expired anyway. The residual window: the same ticket presented to
 * two pods within one NOTIFY delivery (milliseconds). Without the LISTEN the
 * map is per pod. Either way the second socket is the same actor, with the same
 * access re-checks, and the socket carries no content.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { ARTIFACT_LIVE_LIMITS } from '@kortix/shared/artifact-live';
import { config } from '../config';
import type { Actor } from '../iam/actor';
import { isUuid } from '../shared/validate';

/** The credential kinds a ticket may carry. A sandbox token never mints one. */
export const ARTIFACT_LIVE_TICKET_KINDS = ['jwt', 'pat', 'agent_session', 'service_account'] as const;
export type ArtifactLiveTicketKind = (typeof ARTIFACT_LIVE_TICKET_KINDS)[number];

/** Short keys: the ticket rides in a URL. */
export interface ArtifactLiveTicketClaims {
  /** Project id. */
  p: string;
  /** Artifact id. */
  a: string;
  /** The actor's user id (a service account's id for a service account). */
  u: string;
  /** The project's account id. */
  c: string;
  /** How the actor authenticated. */
  k: ArtifactLiveTicketKind;
  /** The acting token id, for `pat` and `agent_session`. */
  t: string | null;
  /** The Kortix session the credential is bound to, or null. */
  s: string | null;
  /** The JWT's `aal` claim, or null. */
  m: string | null;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_TICKET_CHARS = 2_048;
const MAX_USED = 50_000;

let sealing: { secret: string; key: Buffer } | null = null;

/** The ticket key: HKDF-SHA256 over `API_KEY_SECRET`, its own info string. Throws without a secret. */
function ticketKey(): Buffer {
  const secret = config.API_KEY_SECRET;
  if (!secret) throw new Error('API_KEY_SECRET must be configured to seal Artifact live tickets');
  if (sealing?.secret !== secret) {
    const key = hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), Buffer.from('kortix-artifact-live-ticket-v1', 'utf8'), 32);
    sealing = { secret, key: Buffer.from(key) };
  }
  return sealing.key;
}

function seal(payload: Record<string, unknown>): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', ticketKey(), iv, { authTagLength: TAG_BYTES });
  const sealed = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString('base64url');
}

/** The payload of a ticket this server sealed, or null: malformed, changed, or no key. */
function open(ticket: string | null | undefined): Record<string, unknown> | null {
  if (!ticket || ticket.length > MAX_TICKET_CHARS || !/^[A-Za-z0-9_-]+$/.test(ticket)) return null;
  const bytes = Buffer.from(ticket, 'base64url');
  // Pin the nonce and tag lengths: a short tag would weaken the GCM check.
  if (bytes.length <= IV_BYTES + TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', ticketKey(), bytes.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    const text = Buffer.concat([decipher.update(bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES)), decipher.final()]).toString('utf8');
    const payload = JSON.parse(text) as unknown;
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// replica-local: digests of tickets used here or announced by another replica
// on `kortix_artifact_live`; each one leaves when its ticket would expire.
const used = new Map<string, number>();

export function artifactLiveTicketDigest(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex');
}

/** The claims for the actor that passed the REST view check, or null for a sandbox token. */
export function artifactLiveTicketClaims(
  actor: Actor,
  sessionId: string | null,
  scope: { projectId: string; artifactId: string },
): ArtifactLiveTicketClaims | null {
  const { credential } = actor;
  if (credential.kind === 'sandbox') return null;
  const token = credential.kind === 'pat' || credential.kind === 'agent_session' ? credential.tokenId : null;
  return {
    p: scope.projectId, a: scope.artifactId, u: actor.userId, c: actor.accountId,
    k: credential.kind, t: token, s: sessionId, m: actor.ctx.mfaAal ?? null,
  };
}

export function mintArtifactLiveTicket(claims: ArtifactLiveTicketClaims): { ticket: string; expiresAt: number } {
  const expiresAt = Date.now() + ARTIFACT_LIVE_LIMITS.ticketMs;
  const ticket = seal({ ...claims, n: randomBytes(16).toString('base64url'), exp: expiresAt });
  return { ticket, expiresAt };
}

const nullableUuid = (value: unknown): value is string | null => value === null || isUuid(value);

/**
 * The claims of a valid, unexpired ticket minted for exactly this Artifact, or
 * null. It does not consume the ticket: `consumeArtifactLiveTicket` does.
 */
export function verifyArtifactLiveTicket(
  ticket: string | null | undefined,
  scope: { projectId: string; artifactId: string },
): { claims: ArtifactLiveTicketClaims; expiresAt: number } | null {
  const payload = open(ticket);
  if (!payload) return null;
  const { p, a, u, c, k, t, s, m, n, exp } = payload;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp < Date.now()) return null;
  if (p !== scope.projectId || a !== scope.artifactId || !isUuid(p) || !isUuid(a)) return null;
  if (!isUuid(u) || !isUuid(c) || typeof n !== 'string' || n.length < 16) return null;
  if (!ARTIFACT_LIVE_TICKET_KINDS.includes(k as ArtifactLiveTicketKind)) return null;
  if (!nullableUuid(t) || !nullableUuid(s) || (m !== null && typeof m !== 'string')) return null;
  if ((k === 'pat' || k === 'agent_session') !== (t !== null)) return null;
  return { claims: { p, a, u, c, k: k as ArtifactLiveTicketKind, t, s, m: m as string | null }, expiresAt: exp };
}

function prune(now: number): void {
  if (used.size < 1_000) return;
  for (const [digest, expiresAt] of used) if (expiresAt <= now) used.delete(digest);
  // A flood of distinct tickets: drop the oldest. Each one expires within ticketMs anyway.
  while (used.size > MAX_USED) used.delete(used.keys().next().value!);
}

/** True the first time this replica sees the ticket; false when it was used here or announced as used. */
export function consumeArtifactLiveTicket(ticket: string, expiresAt: number): boolean {
  const now = Date.now();
  prune(now);
  const digest = artifactLiveTicketDigest(ticket);
  const known = used.get(digest);
  if (known !== undefined && known > now) return false;
  used.set(digest, expiresAt);
  return true;
}

/** Another replica used this ticket. */
export function markArtifactLiveTicketUsed(digest: string, expiresAt: number): void {
  if (!/^[0-9a-f]{64}$/.test(digest) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
  prune(Date.now());
  used.set(digest, expiresAt);
}
