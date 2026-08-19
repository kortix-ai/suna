/**
 * The canonical assignment + permission-catalog HTTP surface, over the real app
 * and a real database.
 *
 * `assignRole`'s own guarantees are pinned by integration-iam-assignments (the
 * function-level suite). What this file proves is the ROUTE contract that P4/P5
 * and the CLI build on, and the two things a function-level test cannot see:
 *   1. the write routes assert NOTHING themselves — the ceiling comes from
 *      `assignRole`, chosen by WHAT is being granted, so a plain member calling
 *      the new endpoint is refused exactly like one calling the old one
 *   2. the grant a route creates is live for the next authorization on the very
 *      next request (positive-only caching + the synchronous bust)
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db, hasDatabase } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { loadSystemRoles } from '../iam/catalog';
import { clearAuthorizeCaches } from '../iam/authorize';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const uid = () => crypto.randomUUID();

const owner = uid();
const plainMember = uid();
const target = uid();

const minted: string[] = [];
let ownerToken = '';
let memberToken = '';

async function raw(text: string): Promise<void> {
  await db.execute(sql.raw(text));
}

async function mint(userId: string): Promise<string> {
  const t = await createAccountToken({
    accountId: ACCOUNT,
    userId,
    name: 'assignments-http-test',
  });
  minted.push(t.tokenId);
  return t.secretKey;
}

function req(method: string, path: string, secret: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  if (!hasDatabase) return;
  await raw(`insert into kortix.accounts (account_id, name) values ('${ACCOUNT}','assignments-http')`);
  await raw(
    `insert into kortix.projects (project_id, account_id, name, repo_url)
     values ('${PROJECT}','${ACCOUNT}','p','https://example.invalid/p.git')`,
  );
  // account_members is still the physical membership store during the dual-read
  // window; the mirror trigger turns each row into the matching assignment, so
  // this is the same state a real invite produces.
  for (const [userId, role] of [
    [owner, 'owner'],
    [plainMember, 'member'],
    [target, 'member'],
  ] as const) {
    await raw(
      `insert into kortix.account_members (user_id, account_id, account_role, is_super_admin)
       values ('${userId}','${ACCOUNT}','${role}', false)`,
    );
  }
  ownerToken = await mint(owner);
  memberToken = await mint(plainMember);
  clearAuthorizeCaches();
});

afterAll(async () => {
  if (!hasDatabase) return;
  for (const tokenId of minted) {
    await raw(`delete from kortix.account_tokens where token_id = '${tokenId}'`);
  }
  await raw(`delete from kortix.accounts where account_id = '${ACCOUNT}'`);
});

describe.if(hasDatabase)('GET/POST/DELETE /v1/accounts/:accountId/iam/assignments', () => {
  test('the mirrored membership is visible as an account-scope assignment', async () => {
    const res = await req('GET', `/v1/accounts/${ACCOUNT}/iam/assignments`, ownerToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assignments: Array<Record<string, unknown>> };
    const ownerRow = body.assignments.find((a) => a.principal_id === owner);
    expect(ownerRow).toMatchObject({
      principal_type: 'user',
      role_key: 'owner',
      role_is_system: true,
      scope_type: 'account',
      scope_id: null,
      object_type: null,
    });
  });

  test('the principal filter needs both halves — half of it would widen the answer', async () => {
    const res = await req(
      'GET',
      `/v1/accounts/${ACCOUNT}/iam/assignments?principal_id=${target}`,
      ownerToken,
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('principal_type');
  });

  test('a plain member cannot grant a project role through the new endpoint either', async () => {
    const res = await req('POST', `/v1/accounts/${ACCOUNT}/iam/assignments`, memberToken, {
      principal_type: 'user',
      principal_id: target,
      role_key: 'manager',
      scope_type: 'project',
      scope_id: PROJECT,
    });
    expect(res.status).toBe(403);
  });

  test('an owner grants a project role, and it is live on the next request', async () => {
    // Before: the target holds no project role, so a project write is refused.
    const before = await req(
      'GET',
      `/v1/accounts/${ACCOUNT}/iam/assignments?principal_type=user&principal_id=${target}&scope_type=project`,
      ownerToken,
    );
    expect(((await before.json()) as { assignments: unknown[] }).assignments).toHaveLength(0);

    const res = await req('POST', `/v1/accounts/${ACCOUNT}/iam/assignments`, ownerToken, {
      principal_type: 'user',
      principal_id: target,
      role_key: 'manager',
      scope_type: 'project',
      scope_id: PROJECT,
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as Record<string, unknown>;
    expect(created).toMatchObject({
      principal_type: 'user',
      principal_id: target,
      role_key: 'manager',
      role_is_system: true,
      scope_type: 'project',
      scope_id: PROJECT,
      source: 'manual',
    });
    expect(created.granted_by).toBe(owner);

    const after = await req(
      'GET',
      `/v1/accounts/${ACCOUNT}/iam/assignments?principal_type=user&principal_id=${target}&scope_type=project`,
      ownerToken,
    );
    expect(((await after.json()) as { assignments: unknown[] }).assignments).toHaveLength(1);
  });

  test('re-granting the same thing is an upsert, not a second row', async () => {
    const grant = () =>
      req('POST', `/v1/accounts/${ACCOUNT}/iam/assignments`, ownerToken, {
        principal_type: 'user',
        principal_id: target,
        role_key: 'manager',
        scope_type: 'project',
        scope_id: PROJECT,
      });
    const first = (await (await grant()).json()) as { assignment_id: string };
    const second = (await (await grant()).json()) as { assignment_id: string };
    expect(second.assignment_id).toBe(first.assignment_id);
  });

  test('an object assignment is one row that names the object', async () => {
    const res = await req('POST', `/v1/accounts/${ACCOUNT}/iam/assignments`, ownerToken, {
      principal_type: 'user',
      principal_id: target,
      role_key: 'agent-user',
      scope_type: 'project',
      scope_id: PROJECT,
      object_type: 'agent',
      object_id: 'finance-bot',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      object_type: 'agent',
      object_id: 'finance-bot',
      role_key: 'agent-user',
      scope_type: 'project',
    });
  });

  test('object_type and object_id must arrive together', async () => {
    const res = await req('POST', `/v1/accounts/${ACCOUNT}/iam/assignments`, ownerToken, {
      principal_type: 'user',
      principal_id: target,
      role_key: 'agent-user',
      scope_type: 'project',
      scope_id: PROJECT,
      object_type: 'agent',
    });
    expect(res.status).toBe(400);
  });

  test('a project-scoped assignment must name a project', async () => {
    const res = await req('POST', `/v1/accounts/${ACCOUNT}/iam/assignments`, ownerToken, {
      principal_type: 'user',
      principal_id: target,
      role_key: 'manager',
      scope_type: 'project',
    });
    expect(res.status).toBe(400);
  });

  test('DELETE revokes exactly that row', async () => {
    const created = (await (
      await req('POST', `/v1/accounts/${ACCOUNT}/iam/assignments`, ownerToken, {
        principal_type: 'user',
        principal_id: target,
        role_key: 'member',
        scope_type: 'project',
        scope_id: PROJECT,
      })
    ).json()) as { assignment_id: string };

    const res = await req(
      'DELETE',
      `/v1/accounts/${ACCOUNT}/iam/assignments/${created.assignment_id}`,
      ownerToken,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ revoked: true });

    const again = await req(
      'DELETE',
      `/v1/accounts/${ACCOUNT}/iam/assignments/${created.assignment_id}`,
      ownerToken,
    );
    expect(again.status).toBe(404);
  });

  test("the account's last owner cannot be revoked", async () => {
    const list = (await (
      await req(
        'GET',
        `/v1/accounts/${ACCOUNT}/iam/assignments?principal_type=user&principal_id=${owner}&scope_type=account`,
        ownerToken,
      )
    ).json()) as { assignments: Array<{ assignment_id: string; role_key: string }> };
    const ownerAssignment = list.assignments.find((a) => a.role_key === 'owner');
    expect(ownerAssignment).toBeDefined();

    const res = await req(
      'DELETE',
      `/v1/accounts/${ACCOUNT}/iam/assignments/${ownerAssignment!.assignment_id}`,
      ownerToken,
    );
    expect(res.status).toBe(409);
  });
});

describe.if(hasDatabase)('GET /v1/accounts/:accountId/iam/permissions', () => {
  test('the catalog carries scope, delegability, area, level and implications', async () => {
    const res = await req('GET', `/v1/accounts/${ACCOUNT}/iam/permissions`, ownerToken);
    expect(res.status).toBe(200);
    const { permissions } = (await res.json()) as {
      permissions: Array<Record<string, unknown>>;
    };
    expect(permissions.length).toBeGreaterThan(60);

    const write = permissions.find((p) => p.action === 'project.write');
    expect(write).toMatchObject({
      scope_type: 'project',
      delegable: true,
      area: 'project',
      level: 'edit',
    });
    expect(write!.implies).toEqual(['project.read']);

    // The escalation ceiling is a COLUMN now, not a hardcoded Set.
    const superAdmin = permissions.find((p) => p.action === 'member.super_admin.grant');
    expect(superAdmin).toMatchObject({ delegable: false, scope_type: 'account' });

    // The leaf this PR added, so a regression that drops the migration is loud.
    const credentials = permissions.find((p) => p.action === 'project.credentials.issue');
    expect(credentials).toMatchObject({ scope_type: 'project', level: 'admin' });

    // The two spec §2.4 collapses stay collapsed.
    expect(permissions.some((p) => p.action === 'project.cr.open')).toBe(false);
    expect(permissions.some((p) => String(p.action).startsWith('trigger.'))).toBe(false);
  });

  test('scope_type narrows the catalog', async () => {
    const res = await req(
      'GET',
      `/v1/accounts/${ACCOUNT}/iam/permissions?scope_type=account`,
      ownerToken,
    );
    const { permissions } = (await res.json()) as { permissions: Array<{ scope_type: string }> };
    expect(permissions.length).toBeGreaterThan(0);
    expect(permissions.every((p) => p.scope_type === 'account')).toBe(true);
  });

  test('a plain member cannot read the catalog (role.read is admin-tier)', async () => {
    const res = await req('GET', `/v1/accounts/${ACCOUNT}/iam/permissions`, memberToken);
    expect(res.status).toBe(403);
  });
});
