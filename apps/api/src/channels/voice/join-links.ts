/**
 * Short, ungessable join links for the voice bridge page.
 *
 * `voice_spawn` used to hand out `${FRONTEND_URL}/voice/<raw LiveKit JWT>` --
 * a ~300-character signed token riding through chat/speech/UI. One got
 * corrupted in transit (a single inserted character), the signature stopped
 * verifying, and the browser reported "could not establish signal connection:
 * invalid token" with no way to recover. This module replaces that with a
 * short opaque id that resolves server-side: `mintJoinLink` hands back a
 * ~40-character token, `resolveJoinLink` turns it back into the call it was
 * minted for so the caller can mint a FRESH LiveKit access token at open time
 * (see `public-join-routes.ts`).
 *
 * DB-backed (`voice_join_links`), not a stateless encrypted envelope like
 * `setup-links/token.ts`: this token grants join access to a LIVE call, and
 * the one property a self-contained token cannot give us is revocation. A
 * call can end (agent hangs up, session ends) while a copy of its link is
 * still sitting in someone's chat history; that link must stop working the
 * moment the call does (`revokeJoinLinksForCall`, called from `endCall`), not
 * merely whenever its TTL happens to lapse.
 *
 * Rows store `token_hash` (sha256 of the raw token), never the raw token --
 * same posture as `project_session_public_shares.token_hash`: a DB dump
 * should not itself be a bag of live capability tokens.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { voiceJoinLinks } from '@kortix/db';
import { db } from '../../shared/db';

const TOKEN_PREFIX = 'vjl_';

/**
 * Matches the LiveKit access token TTL a link ultimately resolves to
 * (`DEFAULT_TOKEN_TTL_SECONDS` in livekit.ts) -- no point a join link
 * outliving the credential it hands out.
 */
const DEFAULT_TTL_SECONDS = 6 * 60 * 60;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface MintJoinLinkInput {
  callId: string;
  workspaceId: string;
  ttlSeconds?: number;
}

export async function mintJoinLink(input: MintJoinLinkInput): Promise<{ token: string; expiresAt: Date }> {
  // 32 random bytes (256 bits) -- crypto.randomBytes-grade entropy, not a
  // sequence and not a uuid v4 of the session (a session/call id is already
  // known to the agent that spawned the call and to anything with API access;
  // this token must not be derivable from either).
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000);

  await db.insert(voiceJoinLinks).values({
    tokenHash: hashToken(token),
    callId: input.callId,
    workspaceId: input.workspaceId,
    expiresAt,
  });

  return { token, expiresAt };
}

export type ResolvedJoinLink =
  | { ok: true; callId: string; workspaceId: string }
  | { ok: false; status: 404 | 410; error: string };

/**
 * Looks the token up by its hash -- the raw token never touches a WHERE
 * clause anywhere but here, and a tampered/garbage/unknown token is
 * indistinguishable from a never-issued one (404), same as
 * `resolveSetupLink`'s stance on not leaking which.
 */
export async function resolveJoinLink(token: string | undefined | null): Promise<ResolvedJoinLink> {
  if (!token || !token.startsWith(TOKEN_PREFIX)) {
    return { ok: false, status: 404, error: 'Invalid or unknown link' };
  }

  const [row] = await db
    .select()
    .from(voiceJoinLinks)
    .where(eq(voiceJoinLinks.tokenHash, hashToken(token)))
    .limit(1);

  if (!row) return { ok: false, status: 404, error: 'Invalid or unknown link' };
  if (row.revokedAt) return { ok: false, status: 410, error: 'This call has ended' };
  if (row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, status: 410, error: 'This link has expired' };
  }

  return { ok: true, callId: row.callId, workspaceId: row.workspaceId };
}

/** Whether a string LOOKS like one of our tokens -- cheap, no DB round trip.
 *  Used by callers that need to route between this scheme and the legacy
 *  raw-JWT link shape without paying for a lookup on every request. */
export function looksLikeJoinLinkToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX);
}

/**
 * Called from `endCall`: a link to a call that has ended must stop working
 * immediately, not linger until its TTL lapses on its own.
 */
export async function revokeJoinLinksForCall(callId: string): Promise<void> {
  await db
    .update(voiceJoinLinks)
    .set({ revokedAt: new Date() })
    .where(and(eq(voiceJoinLinks.callId, callId), isNull(voiceJoinLinks.revokedAt)));
}
