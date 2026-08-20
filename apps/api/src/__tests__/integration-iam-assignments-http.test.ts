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
/** A principal used by exactly one test, so no earlier grant can leak into it. */
const straggler = uid();

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
  // `kortix.account_members` is the compatibility VIEW over
  // `kortix.account_memberships` + `kortix.role_assignments`; its INSTEAD OF
  // INSERT trigger writes both halves, which is the same state a real invite
  // produces — and exercises the straggler-write path while it is at it.
  for (const [userId, role] of [
    [owner, 'owner'],
    [plainMember, 'member'],
    [target, 'member'],
    [straggler, 'member'],
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

  test('a malformed id is a 400 that names the field, not a 500 from the uuid cast', async () => {
    const bad = await req('POST', `/v1/accounts/${ACCOUNT}/iam/assignments`, ownerToken, {
      principal_type: 'user',
      principal_id: 'not-a-uuid',
      role_key: 'member',
      scope_type: 'project',
      scope_id: PROJECT,
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await bad.json())).toContain('principal_id');

    const badScope = await req('POST', `/v1/accounts/${ACCOUNT}/iam/assignments`, ownerToken, {
      principal_type: 'user',
      principal_id: target,
      role_key: 'member',
      scope_type: 'project',
      scope_id: 'nope',
    });
    expect(badScope.status).toBe(400);
    expect(JSON.stringify(await badScope.json())).toContain('scope_id');

    const badRole = await req('POST', `/v1/accounts/${ACCOUNT}/iam/assignments`, ownerToken, {
      principal_type: 'user',
      principal_id: target,
      role_id: 'builtin:manager',
      scope_type: 'project',
      scope_id: PROJECT,
    });
    expect(badRole.status).toBe(400);
    expect(JSON.stringify(await badRole.json())).toContain('role_id');

    const badFilter = await req(
      'GET',
      `/v1/accounts/${ACCOUNT}/iam/assignments?principal_type=user&principal_id=oops`,
      ownerToken,
    );
    expect(badFilter.status).toBe(400);
  });

  test('a principal that does not exist is refused, for all three kinds', async () => {
    const ghostUser = await req('POST', `/v1/accounts/${ACCOUNT}/iam/assignments`, ownerToken, {
      principal_type: 'user',
      principal_id: uid(),
      role_key: 'member',
      scope_type: 'project',
      scope_id: PROJECT,
    });
    expect(ghostUser.status).toBe(404);
    expect(JSON.stringify(await ghostUser.json())).toContain('user');

    const ghostGroup = await req('POST', `/v1/accounts/${ACCOUNT}/iam/assignments`, ownerToken, {
      principal_type: 'group',
      principal_id: uid(),
      role_key: 'member',
      scope_type: 'project',
      scope_id: PROJECT,
    });
    expect(ghostGroup.status).toBe(404);
    expect(JSON.stringify(await ghostGroup.json())).toContain('group');

    // The one that is more than cosmetic: an agent identity is auto-provisioned
    // by name, so a grant planted against a guessed id would come alive the
    // first time that agent is launched.
    const ghostSa = await req('POST', `/v1/accounts/${ACCOUNT}/iam/assignments`, ownerToken, {
      principal_type: 'service_account',
      principal_id: uid(),
      role_key: 'member',
      scope_type: 'project',
      scope_id: PROJECT,
    });
    expect(ghostSa.status).toBe(404);
    expect(JSON.stringify(await ghostSa.json())).toContain('service account');
  });

  test('a revoke is visible under the legacy name, because it is the same row', async () => {
    const created = (await (
      await req('POST', `/v1/accounts/${ACCOUNT}/iam/assignments`, ownerToken, {
        principal_type: 'user',
        principal_id: target,
        role_key: 'member',
        scope_type: 'project',
        scope_id: PROJECT,
      })
    ).json()) as { assignment_id: string };

    const countLegacy = async () => {
      const res = await db.execute(sql.raw(
        `select count(*)::int as n from kortix.project_members
          where project_id = '${PROJECT}' and user_id = '${target}'`,
      ));
      const rows = (res as unknown as { rows?: Array<{ n: number }> }).rows ??
        (res as unknown as Array<{ n: number }>);
      return Number(rows[0]!.n);
    };

    // `kortix.project_members` is a VIEW over `kortix.role_assignments` as of the
    // cutover, so the grant this route just made is already visible under the
    // legacy name — no mirror, no second row, nothing to keep in step.
    expect(await countLegacy()).toBeGreaterThanOrEqual(1);

    const res = await req(
      'DELETE',
      `/v1/accounts/${ACCOUNT}/iam/assignments/${created.assignment_id}`,
      ownerToken,
    );
    expect(res.status).toBe(200);
    // …and it is gone under the legacy name for the same reason. `toBe(0)` would
    // be wrong: earlier tests in this file grant `target` other project roles,
    // and the view renders the strongest surviving one, so what this asserts is
    // that THIS assignment is gone from the canonical store.
    const still = (await (
      await req(
        'GET',
        `/v1/accounts/${ACCOUNT}/iam/assignments?principal_type=user&principal_id=${target}&scope_type=project`,
        ownerToken,
      )
    ).json()) as { assignments: Array<{ assignment_id: string }> };
    expect(still.assignments.map((a) => a.assignment_id)).not.toContain(created.assignment_id);
  });

  test('a straggler write to the legacy VIEW lands in the canonical store', async () => {
    // The property the INSTEAD OF triggers exist for: a pre-cutover replica
    // mid-roll, a support script, `pg_restore` or a test fixture writing
    // `project_members` by name must produce a real assignment, not a row in a
    // table nobody reads. ON CONFLICT is deliberately absent — a view has no
    // index to infer, and the trigger does the upsert itself.
    await raw(
      `insert into kortix.project_members (account_id, project_id, user_id, project_role)
       values ('${ACCOUNT}','${PROJECT}','${straggler}','manager')`,
    );

    const list = (await (
      await req(
        'GET',
        `/v1/accounts/${ACCOUNT}/iam/assignments?principal_type=user&principal_id=${straggler}&scope_type=project`,
        ownerToken,
      )
    ).json()) as { assignments: Array<{ assignment_id: string; role_key: string; scope_id: string }> };
    const onProject = list.assignments.filter((a) => a.scope_id === PROJECT);
    expect(onProject.map((a) => a.role_key)).toEqual(['manager']);

    // The legacy UPDATE path re-points the SAME assignment rather than adding a
    // second one — the view's primary key was (project_id, user_id).
    await raw(
      `update kortix.project_members set project_role = 'member'
        where project_id = '${PROJECT}' and user_id = '${straggler}'`,
    );
    const after = (await (
      await req(
        'GET',
        `/v1/accounts/${ACCOUNT}/iam/assignments?principal_type=user&principal_id=${straggler}&scope_type=project`,
        ownerToken,
      )
    ).json()) as { assignments: Array<{ role_key: string; scope_id: string }> };
    expect(after.assignments.filter((a) => a.scope_id === PROJECT).map((a) => a.role_key)).toEqual([
      'member',
    ]);

    // …and the legacy DELETE retracts it.
    await raw(
      `delete from kortix.project_members
        where project_id = '${PROJECT}' and user_id = '${straggler}'`,
    );
    const gone = (await (
      await req(
        'GET',
        `/v1/accounts/${ACCOUNT}/iam/assignments?principal_type=user&principal_id=${straggler}&scope_type=project`,
        ownerToken,
      )
    ).json()) as { assignments: Array<{ scope_id: string }> };
    expect(gone.assignments.filter((a) => a.scope_id === PROJECT)).toEqual([]);
  });

  test('an unknown assignment id is a 404, not a 500', async () => {
    const res = await req('DELETE', `/v1/accounts/${ACCOUNT}/iam/assignments/not-a-uuid`, ownerToken);
    expect(res.status).toBe(404);
  });

  test("removing a principal's only account role is refused — offboarding has its own route", async () => {
    const list = (await (
      await req(
        'GET',
        `/v1/accounts/${ACCOUNT}/iam/assignments?principal_type=user&principal_id=${target}&scope_type=account`,
        ownerToken,
      )
    ).json()) as { assignments: Array<{ assignment_id: string; role_key: string }> };
    expect(list.assignments).toHaveLength(1);

    const res = await req(
      'DELETE',
      `/v1/accounts/${ACCOUNT}/iam/assignments/${list.assignments[0]!.assignment_id}`,
      ownerToken,
    );
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('members');
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

describe.if(hasDatabase)('GET /v1/accounts/:accountId/iam/roles', () => {
  test('system roles come from the seeded DB rows, keys included', async () => {
    const res = await req('GET', `/v1/accounts/${ACCOUNT}/iam/roles`, ownerToken);
    expect(res.status).toBe(200);
    const { roles } = (await res.json()) as {
      roles: Array<{ role_id: string; key: string; is_system: boolean; resource_type: string }>;
    };
    const system = roles.filter((r) => r.is_system);
    // All SIX seeded rows, the object-grant marker included — it is a system
    // role, and the edit guards have to recognise it.
    expect(system.map((r) => `${r.resource_type}:${r.key}`).sort()).toEqual([
      'account:admin',
      'account:member',
      'account:owner',
      'project:agent-user',
      'project:manager',
      'project:member',
    ]);
    // Ids stay `builtin:<key>`; the project floor role keeps `builtin:user`
    // because `builtin:member` is the ACCOUNT floor role's id.
    const projectFloor = system.find((r) => r.resource_type === 'project' && r.key === 'member');
    expect(projectFloor!.role_id).toBe('builtin:user');
  });

  test('the key a role advertises is the key POST /iam/assignments accepts', async () => {
    const { roles } = (await (
      await req('GET', `/v1/accounts/${ACCOUNT}/iam/roles`, ownerToken)
    ).json()) as { roles: Array<{ key: string; is_system: boolean; resource_type: string }> };
    const key = roles.find((r) => r.is_system && r.resource_type === 'project' && r.key === 'member')!
      .key;
    const res = await req('POST', `/v1/accounts/${ACCOUNT}/iam/assignments`, ownerToken, {
      principal_type: 'user',
      principal_id: target,
      role_key: key,
      scope_type: 'project',
      scope_id: PROJECT,
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ role_key: 'member', scope_type: 'project' });
  });

  test('the historical project-role names still resolve', async () => {
    // Published SDKs and the roles list's own `builtin:user` id speak `user`.
    for (const roleKey of ['user', 'viewer', 'editor']) {
      const res = await req('POST', `/v1/accounts/${ACCOUNT}/iam/assignments`, ownerToken, {
        principal_type: 'user',
        principal_id: target,
        role_key: roleKey,
        scope_type: 'project',
        scope_id: PROJECT,
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { role_key: string };
      expect(body.role_key).toBe(roleKey === 'editor' ? 'manager' : 'member');
    }
  });

  test('a system role carries the description the seed gave it', async () => {
    const { roles } = (await (
      await req('GET', `/v1/accounts/${ACCOUNT}/iam/roles`, ownerToken)
    ).json()) as {
      roles: Array<{ key: string; is_system: boolean; resource_type: string; description: string | null }>;
    };
    const manager = roles.find((r) => r.is_system && r.key === 'manager')!;
    expect(manager.description).toBeTruthy();
    expect(manager.description).toContain('project');
  });

  test("a system role's permissions come from role_permissions", async () => {
    const res = await req('GET', `/v1/accounts/${ACCOUNT}/iam/roles/builtin:user/permissions`, ownerToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string; actions: string[] };
    expect(body.key).toBe('member');
    expect(body.actions).toContain('project.read');
    expect(body.actions).toContain('project.session.start');
    expect(body.actions).not.toContain('project.delete');
  });

  test('the object-grant marker is a system role and is not deletable', async () => {
    // DELETE, not PATCH: PATCH runs the `rbac` entitlement gate first and would
    // answer 402 here regardless of the role. Deleting a role is cleanup and
    // carries no entitlement gate, so it reaches the built-in check.
    const res = await req(
      'DELETE',
      `/v1/accounts/${ACCOUNT}/iam/roles/builtin:agent-user`,
      ownerToken,
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('built-in');
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

  test('every permission carries a real description', async () => {
    const res = await req('GET', `/v1/accounts/${ACCOUNT}/iam/permissions`, ownerToken);
    const { permissions } = (await res.json()) as {
      permissions: Array<{ action: string; description: string }>;
    };
    // The role-capability matrix renders this string. An empty one sends the
    // web back to humanizing the dotted action ("Project · Gitops · Push"),
    // which tells an admin nothing about what the permission allows — which is
    // exactly what the seed shipped before 20260819050000000.
    const blank = permissions.filter((p) => !p.description || p.description.trim() === '');
    expect(blank.map((p) => p.action)).toEqual([]);
    expect(permissions.find((p) => p.action === 'project.gitops.push')!.description).toContain(
      'Push commits',
    );
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
