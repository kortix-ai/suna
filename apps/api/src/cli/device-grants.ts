import { createHash, randomBytes } from 'node:crypto';
import { cliDeviceGrants } from '@kortix/db';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { db, withDbTransaction } from '../shared/db';
import { createAccountToken } from '../repositories/account-tokens';
import { actorForUser, type Actor } from '../iam/actor';
import { ACCOUNT_ACTIONS, assertAuthorized } from '../iam';

export const CLI_GRANT_TTL = 600;
export const CLI_POLL_INTERVAL = 5;
const digest = (secret: string) => createHash('sha256').update(secret).digest('hex');
export const normalizeCliCode = (code: string) => code.trim().toUpperCase().replace(/-/g, '');

export async function startCliGrant() {
  const deviceCode = randomBytes(32).toString('hex');
  const userCode = randomBytes(8).toString('hex').toUpperCase();
  await db.delete(cliDeviceGrants).where(lt(cliDeviceGrants.expiresAt, new Date()));
  await db.insert(cliDeviceGrants).values({
    deviceCodeHash: digest(deviceCode), userCode,
    expiresAt: new Date(Date.now() + CLI_GRANT_TTL * 1000),
  });
  return { device_code: deviceCode, user_code: userCode, expires_in: CLI_GRANT_TTL, interval: CLI_POLL_INTERVAL };
}

/** Only a browser JWT can approve; the route enforces that credential boundary.
 * Recheck the personal-token permission here, independent of the UI. */
export async function decideCliGrant(code: string, actor: Actor, approve: boolean) {
  await assertAuthorized(actor, ACCOUNT_ACTIONS.TOKEN_PERSONAL_CREATE);
  const rows = await db.update(cliDeviceGrants).set({
    status: approve ? 'approved' : 'denied', userId: actor.userId, accountId: actor.accountId,
  }).where(and(
    eq(cliDeviceGrants.userCode, normalizeCliCode(code)),
    eq(cliDeviceGrants.status, 'pending'), gt(cliDeviceGrants.expiresAt, new Date()),
  )).returning({ code: cliDeviceGrants.userCode });
  return rows.length > 0;
}

/** The row lock spans PAT creation and consumption. Concurrent polls on any
 * replica cannot mint twice; a failed mint rolls the consumption back. No
 * plaintext credential is stored in the grant or sent to the approval page. */
export async function pollCliGrant(deviceCode: string) {
  return withDbTransaction(async () => {
    const [grant] = await db.select().from(cliDeviceGrants)
      .where(eq(cliDeviceGrants.deviceCodeHash, digest(deviceCode))).for('update');
    if (!grant || grant.status === 'consumed') return { error: 'invalid_grant' };
    if (grant.expiresAt.getTime() <= Date.now()) return { error: 'expired_token' };
    if (grant.status === 'denied') return { error: 'access_denied' };
    if (grant.lastPolledAt && Date.now() - grant.lastPolledAt.getTime() < CLI_POLL_INTERVAL * 1000) {
      return { error: 'slow_down' };
    }
    await db.update(cliDeviceGrants).set({ lastPolledAt: sql`now()` })
      .where(eq(cliDeviceGrants.deviceCodeHash, grant.deviceCodeHash));
    if (grant.status !== 'approved' || !grant.userId || !grant.accountId) return { error: 'authorization_pending' };
    await assertAuthorized(actorForUser(grant.userId, grant.accountId), ACCOUNT_ACTIONS.TOKEN_PERSONAL_CREATE);
    const token = await createAccountToken({
      accountId: grant.accountId, userId: grant.userId, name: 'CLI · device login',
    });
    await db.update(cliDeviceGrants).set({ status: 'consumed' })
      .where(eq(cliDeviceGrants.deviceCodeHash, grant.deviceCodeHash));
    return { token: token.secretKey };
  });
}
