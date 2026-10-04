/**
 * Real HTTP + Postgres proof: deleting an auth user (what the Supabase Auth
 * admin API does: DELETE FROM auth.users) revokes every credential that acts
 * AS that user — PAT, session-bound token, OAuth access + refresh tokens,
 * YOLO member token — while another user's credentials and account-owned
 * credentials (SCIM, gateway key) keep working.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accountMembers,
  accounts,
  gatewayApiKeys,
  oauthAccessTokens,
  oauthClients,
  oauthRefreshTokens,
  projects,
  scimTokens,
} from '@kortix/db';
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';

import { app } from '../app/index';
import { createAccountToken } from '../services/repositories/account-tokens';
import { createServiceAccount } from '../services/repositories/service-accounts';
import { hashSecretKey } from '../lib/crypto';
import { db } from '../lib/db';
import { deleteFromView, insertIntoView } from './helpers/compat-views';

const GONE = crypto.randomUUID();
const KEPT = crypto.randomUUID();
const TEAM = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const CLIENT = crypto.randomUUID();

const secrets: Record<string, string> = {};
let ip = 0;

function me(token: string) {
  ip += 1;
  return app.request('/v1/accounts/me', {
    headers: { Authorization: `Bearer ${token}`, 'x-forwarded-for': `198.51.100.${ip % 250}` },
  });
}

async function mintOAuthPair(userId: string, tag: string) {
  const access = `kortix_oat_${tag}${crypto.randomUUID().replaceAll('-', '')}`;
  const refresh = `kortix_ort_${tag}${crypto.randomUUID().replaceAll('-', '')}`;
  const [row] = await db
    .insert(oauthAccessTokens)
    .values({
      tokenHash: hashSecretKey(access),
      clientId: CLIENT,
      userId,
      accountId: userId,
      scopes: ['profile'],
      expiresAt: new Date(Date.now() + 3600_000),
    })
    .returning();
  await db.insert(oauthRefreshTokens).values({
    tokenHash: hashSecretKey(refresh),
    accessTokenId: row!.id,
    clientId: CLIENT,
    userId,
    accountId: userId,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return { access, refresh };
}

function refreshGrant(refresh: string) {
  ip += 1;
  return app.request('/v1/oauth/token', {
    method: 'POST',
    headers: { 'x-forwarded-for': `198.51.100.${ip % 250}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT, refresh_token: refresh }),
  });
}

beforeAll(async () => {
  await db.execute(sql`
    insert into auth.users (id, email) values
      (${GONE}::uuid, ${`gone-${GONE}@example.com`}),
      (${KEPT}::uuid, ${`kept-${KEPT}@example.com`})
    on conflict do nothing`);
  for (const id of [GONE, KEPT, TEAM]) {
    await db.insert(accounts).values({ accountId: id, name: `revoke-on-delete-${id}` });
  }
  await insertIntoView(db, accountMembers, [
    { accountId: GONE, userId: GONE, accountRole: 'owner' },
    { accountId: KEPT, userId: KEPT, accountRole: 'owner' },
    { accountId: TEAM, userId: GONE, accountRole: 'owner' },
    // A surviving member. Since 20261003182500000 the auth-user delete
    // reclaims an account whose every live member is gone — a TEAM whose only
    // member is the deleted user would cascade away with its service account,
    // SCIM token and gateway key before this file could prove they are
    // "untouched". The untouched-credential contract needs an account that
    // outlives the delete.
    { accountId: TEAM, userId: KEPT, accountRole: 'member' },
  ]);
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: TEAM,
    name: 'revoke-on-delete',
    repoUrl: 'https://example.invalid/revoke.git',
    metadata: {},
  });
  await db.insert(oauthClients).values({
    clientId: CLIENT,
    clientSecretHash: hashSecretKey('unused'),
    name: 'revoke-on-delete',
    clientType: 'public',
    scopes: ['profile'],
  });

  secrets.gonePat = (await createAccountToken({ accountId: GONE, userId: GONE, name: 'gone', agentGrant: null })).secretKey;
  secrets.keptPat = (await createAccountToken({ accountId: KEPT, userId: KEPT, name: 'kept', agentGrant: null })).secretKey;
  // A second PAT of the deleted user, scoped to the team account.
  secrets.goneTeamPat = (await createAccountToken({ accountId: TEAM, userId: GONE, name: 'gone-team', agentGrant: null })).secretKey;
  Object.assign(secrets, {
    ...Object.fromEntries(Object.entries(await mintOAuthPair(GONE, 'g')).map(([k, v]) => [`gone_${k}`, v])),
    ...Object.fromEntries(Object.entries(await mintOAuthPair(KEPT, 'k')).map(([k, v]) => [`kept_${k}`, v])),
  });
  await db.execute(sql`
    insert into kortix.yolo_member_tokens (user_id, account_id, token_prefix, token_hash)
    values (${GONE}::uuid, ${TEAM}::uuid, 'yolo_gone', 'h-gone'), (${KEPT}::uuid, ${KEPT}::uuid, 'yolo_kept', 'h-kept')`);
  // A service account is a non-auth principal: its tokens carry
  // user_id = service_account_id, which is never in auth.users.
  const sa = await createServiceAccount({ accountId: TEAM, name: `revoke-on-delete-${TEAM}`, createdBy: KEPT });
  secrets.saPat = (await createAccountToken({ accountId: TEAM, userId: sa.serviceAccountId, name: 'sa', agentGrant: null })).secretKey;
  secrets.saSession = (
    await createAccountToken({ accountId: TEAM, userId: sa.serviceAccountId, name: 'sa-session', agentGrant: null, sessionId: `sa-${TEAM}` } as never)
  ).secretKey;
  await db.insert(scimTokens).values({
    accountId: TEAM, name: 'scim', secretHash: `scim-${TEAM}`, publicPrefix: 'kortix_scim_x', createdBy: GONE,
  });
  await db.insert(gatewayApiKeys).values({
    accountId: TEAM, projectId: PROJECT, name: 'gw', keyPrefix: 'gw_x', secretKeyHash: `gw-${TEAM}`, createdBy: GONE,
  });
});

afterAll(async () => {
  await db.delete(oauthClients).where(eq(oauthClients.clientId, CLIENT));
  await db.execute(sql`delete from kortix.yolo_member_tokens where account_id in (${TEAM}::uuid, ${KEPT}::uuid)`);
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await deleteFromView(db, accountMembers, sql`account_id in (${GONE}::uuid, ${KEPT}::uuid, ${TEAM}::uuid)`);
  for (const id of [GONE, KEPT, TEAM]) await db.delete(accounts).where(eq(accounts.accountId, id));
  await db.execute(sql`delete from auth.users where id in (${GONE}::uuid, ${KEPT}::uuid)`);
});

const saLive = () =>
  db.execute(sql`select count(*) n from kortix.account_tokens t join kortix.service_accounts s on s.service_account_id = t.user_id
    where s.account_id = ${TEAM}::uuid and t.status = 'active' and t.revoked_at is null`);

describe('deleting an auth user revokes every credential acting as that user', () => {
  test('before deletion every credential is accepted', async () => {
    for (const key of ['gonePat', 'goneTeamPat', 'keptPat', 'gone_access', 'kept_access']) {
      expect((await me(secrets[key]!)).status).toBe(200);
    }
  });

  test('the migration backfill spares service-account tokens (user_id has no auth row)', async () => {
    const sqlText = readFileSync(
      new URL('../../../../packages/db/migrations/20260929225114414_revoke_credentials_on_auth_user_delete.sql', import.meta.url),
      'utf8',
    );
    await db.execute(sql.raw(sqlText.slice(sqlText.indexOf('-- One-time idempotent backfill'))));
    const res = (await saLive()) as unknown as Array<{ n: string }> | { rows: Array<{ n: string }> };
    expect(Number((Array.isArray(res) ? res : res.rows)[0]!.n)).toBe(2);
    expect((await me(secrets.saPat!)).status).not.toBe(401);
  });

  test('after DELETE FROM auth.users the deleted user is refused everywhere, the other user is not', async () => {
    await db.execute(sql`delete from auth.users where id = ${GONE}::uuid`);

    for (const key of ['gonePat', 'goneTeamPat', 'gone_access']) {
      expect((await me(secrets[key]!)).status).toBe(401);
    }
    const refused = await refreshGrant(secrets.gone_refresh!);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe('invalid_grant');

    // A service-account token survives an unrelated auth-user delete.
    expect((await me(secrets.saPat!)).status).not.toBe(401);

    // Control: the other user's credentials still work, including refresh.
    expect((await me(secrets.keptPat!)).status).toBe(200);
    expect((await me(secrets.kept_access!)).status).toBe(200);
    expect((await refreshGrant(secrets.kept_refresh!)).status).toBe(200);
  });

  test('rows: user credentials revoked, account-owned credentials untouched', async () => {
    const count = async (q: ReturnType<typeof sql>) => {
      const res = (await db.execute(q)) as unknown as Array<{ n: string }> | { rows: Array<{ n: string }> };
      return Number((Array.isArray(res) ? res : res.rows)[0]!.n);
    };
    expect(await count(sql`select count(*) n from kortix.account_tokens where user_id=${GONE}::uuid and (status <> 'revoked' or revoked_at is null)`)).toBe(0);
    expect(await count(sql`select count(*) n from kortix.oauth_access_tokens where user_id=${GONE}::uuid and revoked_at is null`)).toBe(0);
    expect(await count(sql`select count(*) n from kortix.oauth_refresh_tokens where user_id=${GONE}::uuid and revoked_at is null`)).toBe(0);
    expect(await count(sql`select count(*) n from kortix.yolo_member_tokens where user_id=${GONE}::uuid and revoked_at is null`)).toBe(0);
    expect(await count(sql`select count(*) n from kortix.yolo_member_tokens where user_id=${KEPT}::uuid and revoked_at is null`)).toBe(1);
    expect(await count(sql`select count(*) n from kortix.scim_tokens where account_id=${TEAM}::uuid and revoked_at is null`)).toBe(1);
    expect(await count(sql`select count(*) n from kortix.gateway_api_keys where account_id=${TEAM}::uuid and revoked_at is null`)).toBe(1);
  });
});
