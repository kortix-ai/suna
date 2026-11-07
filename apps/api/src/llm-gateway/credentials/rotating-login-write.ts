/**
 * The write-back of a rotated subscription login (ChatGPT `CODEX_AUTH_JSON`,
 * an OpenCode Console login) to `account_secret_resources`.
 *
 * Both providers rotate the refresh token on use, so the refreshed login is
 * the only one that works and must land. Two things can change while the
 * provider call runs, with no lock held:
 *
 *   - The row moves to another account (a project transfer or the workspace
 *     split moves a project-scoped login and re-seals it with the target's
 *     key). A write keyed by the account the request read would match 0 rows
 *     and lose the rotated token. The write matches by `secret_id` alone and
 *     seals for the account that holds the row now.
 *   - The row stops carrying the refresh token this refresh used: its owner
 *     reconnected (a new login), or the split left a reconnect placeholder.
 *     The write then changes nothing, so it never overwrites a newer login.
 *
 * Design: .agents/skills/learnings/work/workspaces/design.md §3.1 row 5.
 */
import { eq } from 'drizzle-orm';
import { accountSecretResources } from '@kortix/db';
import { db } from '../../shared/db';
import { decryptAccountSecret, encryptAccountSecret } from '../../secrets/account-resource';

export interface RotatedLoginWrite {
  secretId: string;
  /** The refresh token the provider call consumed. */
  usedRefresh: string;
  /** The refresh token a stored plaintext carries, or null when it is no login. */
  refreshOf: (plaintext: string) => string | null | undefined;
  /** The refreshed login to store (plaintext). */
  value: string;
}

/**
 * Store a rotated login. Returns the account that holds the row and whether
 * the write landed (`false`: the row is gone, or it no longer carries
 * `usedRefresh`).
 */
export async function writeRotatedAccountLogin(input: RotatedLoginWrite): Promise<{ written: boolean; accountId: string | null }> {
  return db.transaction(async (tx) => {
    // FOR UPDATE: a move that holds the row commits first; READ COMMITTED
    // then returns the moved version (its account, its re-sealed value).
    const [row] = await tx
      .select({ accountId: accountSecretResources.accountId, valueEnc: accountSecretResources.valueEnc })
      .from(accountSecretResources)
      .where(eq(accountSecretResources.secretId, input.secretId))
      .for('update');
    if (!row) return { written: false, accountId: null };
    let stored: string | null;
    try {
      stored = decryptAccountSecret(row.accountId, row.valueEnc);
    } catch {
      stored = null;
    }
    if (stored === null || input.refreshOf(stored) !== input.usedRefresh) {
      return { written: false, accountId: row.accountId };
    }
    await tx
      .update(accountSecretResources)
      .set({ valueEnc: encryptAccountSecret(row.accountId, input.value), updatedAt: new Date(), needsReauthAt: null })
      .where(eq(accountSecretResources.secretId, input.secretId));
    return { written: true, accountId: row.accountId };
  });
}
