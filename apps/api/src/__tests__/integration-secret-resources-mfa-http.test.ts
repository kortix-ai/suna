/**
 * Creating a pooled provider key in an account that requires MFA.
 *
 * A key a member creates only for themself skips the route's own `authorize`
 * call, so `memberMayReadProject` is the route's whole project check, and it
 * must use the request's own MFA level. #8618 made that helper treat MFA as
 * satisfied by default (a check about a member, not a request), and this call
 * site did not pass the request's level: an aal1 browser session could create
 * a key without its second factor (security review on #8619, 2026-10-01).
 *
 * The auth middleware is replaced by a stub that sets what it sets for a
 * Supabase browser session, so the MFA level is the variable under test.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { accountMembers, accounts, projectMembers } from '@kortix/db';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const { accountsRouter } = await import('../accounts/core/app');
const { registerSecretResourceRoutes } = await import('../accounts/secret-resources');
registerSecretResourceRoutes();

const MEMBER = crypto.randomUUID();
let project: SeededProject;
let mfaAal: string | undefined;

const app = new Hono();
app.use('*', async (c, next) => {
  c.set('userId' as never, MEMBER as never);
  c.set('authType' as never, 'supabase' as never);
  if (mfaAal) c.set('mfaAal' as never, mfaAal as never);
  await next();
});
app.route('/v1/accounts', accountsRouter);

beforeAll(async () => {
  project = await seedProject('secret-resources-mfa', { metadata: { experimental: { pooled_provider_secrets: true } } });
  // Required before anything authorizes in this account, so no cached actor misses it.
  await db.update(accounts).set({ mfaRequired: true }).where(eq(accounts.accountId, project.account_id));
  await insertIntoView(db, accountMembers, [
    { userId: MEMBER, accountId: project.account_id, accountRole: 'member', isSuperAdmin: false },
  ]);
  await insertIntoView(db, projectMembers, [
    { accountId: project.account_id, projectId: project.project_id, userId: MEMBER, projectRole: 'member' },
  ]);
});

afterAll(async () => {
  await removeSeeded([project]);
});

/** A key only for the caller: the path that skips the route's own `authorize`. */
const createOwnKey = () =>
  app.request(`/v1/accounts/${project.account_id}/secret-resources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project_id: project.project_id,
      access_mode: 'members',
      label: 'synthetic member key',
      provider_id: 'anthropic',
      name: 'ANTHROPIC_API_KEY',
      value: 'synthetic-test-value',
      consumer: 'llm_gateway',
      strategy: 'broker',
    }),
  });

describe('POST /v1/accounts/:accountId/secret-resources in an account that requires MFA', () => {
  test('a member`s session without its second factor cannot create a key for a project', async () => {
    mfaAal = 'aal1';
    expect((await createOwnKey()).status).toBe(403);
    mfaAal = undefined;
    expect((await createOwnKey()).status).toBe(403);
  });

  test('after the step-up (aal2) the same request creates the key', async () => {
    mfaAal = 'aal2';
    expect((await createOwnKey()).status).toBe(201);
  });

  // Narrowing a key to its creator alone also skips the route's `authorize`.
  test('changing a key`s access needs the second factor too', async () => {
    mfaAal = 'aal2';
    const created = (await (await createOwnKey()).json()) as { secret_id: string };
    const setAccess = () =>
      app.request(`/v1/accounts/${project.account_id}/secret-resources/${created.secret_id}/access`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'members', user_ids: [MEMBER] }),
      });
    mfaAal = 'aal1';
    expect((await setAccess()).status).toBe(403);
    mfaAal = 'aal2';
    expect((await setAccess()).status).toBe(200);
  });
});
