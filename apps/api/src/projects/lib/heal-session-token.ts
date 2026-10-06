/**
 * Heal a box's own superseded session token (see `service-key-reconcile.ts`
 * for why the box keeps its create-time `KORTIX_TOKEN`).
 *
 * Its own module so the session start and delivery paths can call it without
 * importing the sandbox proxy that the reconcile depends on.
 */
import { sessionSandboxes } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';

import { db } from '../../shared/db';
import { accountMemberExistsSql } from '../../iam/membership-read';
import { logger } from '../../lib/logger';
import { candidateSecretKeyHashesAsync } from '../../shared/token-hash';

/**
 * A `KORTIX_TOKEN` we are willing to believe. Deliberately strict: this value
 * is about to become the row's identity key, and writing a shell error message
 * into it would lock the session out exactly like the bug being fixed.
 */
export function isPlausibleServiceKey(value: string): boolean {
  if (value.length < 20 || value.length > 40_000) return false;
  if (/\s/.test(value)) return false;
  return value.startsWith('kortix_');
}

/**
 * Tokens revoked before this instant may be healed. It is the ship date of the
 * heal. `account_tokens` records no revoke reason (`status` + `revoked_at`
 * only), so a migration rotation, the 2026-09-18 bulk revoke and a deliberate
 * revoke look the same. Every revoke made from this date on stays final.
 * Residual risk: a deliberate revoke made BEFORE this date of a token that is
 * still its session's box key is undone, if the user is still a live member.
 */
const HEAL_REVOKED_BEFORE = '2026-10-01T00:00:00Z';

/**
 * Make a box's own revoked session token valid again.
 *
 * The box holds the `KORTIX_TOKEN` it was created with (see the header). When a
 * migration rotation or a bulk revoke killed that token, the daemon's first
 * claim gets `401 PAT not found or revoked` forever and the session never
 * boots. Reactivate exactly the token that is this session's recorded box key,
 * in one guarded UPDATE: the token is the session's own, the session is not
 * deleted, the row's `config.serviceKey` is that token, it was revoked before
 * `HEAL_REVOKED_BEFORE`, and its user is a live, unbanned member of the account.
 *
 * NEVER THROWS and never logs the key. Returns the reactivated token id.
 */
export async function healSupersededSessionToken(sessionId: string): Promise<string | null> {
  try {
    const [box] = await db
      .select({ config: sessionSandboxes.config })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sessionId, sessionId))
      .limit(1);
    const key = (box?.config as Record<string, unknown> | null)?.serviceKey;
    if (typeof key !== 'string' || !isPlausibleServiceKey(key)) return null;
    const hashes = sql.join((await candidateSecretKeyHashesAsync(key)).map((h) => sql`${h}`), sql`, `);

    const result = await db.execute(sql`
      update kortix.account_tokens t
         set status = 'active', revoked_at = null
       where t.session_id = ${sessionId}
         and t.secret_key_hash in (${hashes})
         and t.revoked_at < ${HEAL_REVOKED_BEFORE}::timestamptz
         and exists (select 1 from kortix.project_sessions p
                      where p.session_id = t.session_id and p.account_id = t.account_id
                        and p.metadata->>'deletedAt' is null)
         and exists (select 1 from kortix.session_sandboxes s
                      where s.session_id = t.session_id and s.account_id = t.account_id
                        and s.config->>'serviceKey' = ${key})
         and exists (select 1 from auth.users u
                      where u.id = t.user_id and u.deleted_at is null
                        and (u.banned_until is null or u.banned_until <= now()))
         and ${accountMemberExistsSql(sql`t.user_id`, sql`t.account_id`)}
      returning t.token_id, t.account_id, t.user_id`);
    const [healed] = ((result as { rows?: unknown[] }).rows ?? result) as Array<{
      token_id: string;
      account_id: string;
      user_id: string;
    }>;
    if (!healed) return null;
    logger.warn('[service-key] reactivated superseded session token', {
      session_id: sessionId,
      token_id: healed.token_id,
      account_id: healed.account_id,
      user_id: healed.user_id,
    });
    return healed.token_id;
  } catch (error) {
    logger.warn('[service-key] could not heal the session token', {
      session_id: sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
