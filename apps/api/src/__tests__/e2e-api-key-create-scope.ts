#!/usr/bin/env bun
/**
 * Live E2E for creating a PROJECT-SCOPED API key THROUGH THE API
 * (POST /v1/accounts/tokens { project_id }). Run against a running API + Postgres.
 *
 *   bun run apps/api/src/__tests__/e2e-api-key-create-scope.ts
 *
 * Steps:
 *   1. Mint an account-wide admin key (direct insert) to authenticate the create.
 *   2. Discover the account's projects via GET /projects.
 *   3. POST /accounts/tokens { name, project_id: A } → expect 201 + project_id === A.
 *   4. The scoped key reads project A (200) but is 403 on project B + on /projects.
 *   5. Clean up both keys.
 */
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { generateAccountTokenPair, hashSecretKey } from '../shared/crypto';

const API_BASE = process.env.KORTIX_API_URL ?? 'http://localhost:8008';

function ok(m: string) { process.stdout.write(`  \x1b[0;32m✓\x1b[0m  ${m}\n`); }
function dim(l: string, v: string) { process.stdout.write(`  \x1b[2m${l}\x1b[0m  ${v}\n`); }
function die(m: string): never { process.stderr.write(`  \x1b[0;31m✗\x1b[0m  ${m}\n`); process.exit(1); }

async function call<T>(token: string, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API_BASE}/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body: body as T };
}

async function main() {
  process.stdout.write('\n  \x1b[1mAPI key create-scope E2E\x1b[0m  (POST /accounts/tokens { project_id })\n');
  dim('api', API_BASE);

  const res = await db.execute<{ user_id: string; account_id: string }>(
    sql`select user_id, account_id from kortix.account_members order by joined_at limit 1`,
  );
  const owner = ((res as unknown as { rows?: Array<{ user_id: string; account_id: string }> }).rows
    ?? (res as unknown as Array<{ user_id: string; account_id: string }>))[0];
  if (!owner) die('No rows in kortix.account_members. Seed a user first.');

  const admin = generateAccountTokenPair();
  await db.execute(sql`
    insert into kortix.account_tokens (account_id, user_id, name, public_key, secret_key_hash)
    values (${owner.account_id}, ${owner.user_id}, 'e2e-create-scope-admin', ${admin.publicKey}, ${hashSecretKey(admin.secretKey)})
  `);
  dim('admin', `${admin.secretKey.slice(0, 18)}…`);

  const projects = await call<Array<Record<string, unknown>>>(admin.secretKey, '/projects');
  if (projects.status !== 200) die(`GET /projects → ${projects.status}`);
  const ids = (projects.body ?? []).map((p) => (p.id ?? p.project_id) as string).filter(Boolean);
  if (ids.length < 1) die('account has no projects to scope to');
  const [projA, projB] = ids;
  dim('projA', projA);
  if (projB) dim('projB', projB);

  // 3. CREATE a project-scoped key via the API — the new capability.
  const created = await call<{ secret_key: string; project_id: string | null }>(
    admin.secretKey, '/accounts/tokens',
    { method: 'POST', body: JSON.stringify({ name: 'e2e-create-scope-key', project_id: projA }) },
  );
  if (created.status !== 201) die(`create → ${created.status} ${JSON.stringify(created.body)}`);
  if (created.body.project_id !== projA) die(`created key not scoped: project_id=${created.body.project_id}`);
  ok('POST /accounts/tokens { project_id } → 201, scoped to projA');
  const scoped = created.body.secret_key;

  // 4. The scope holds.
  const a = await call(scoped, `/projects/${projA}`);
  if (a.status !== 200) die(`scoped key on its own project → ${a.status}`);
  ok('scoped key reads its own project → 200');

  if (projB) {
    const b = await call(scoped, `/projects/${projB}`);
    if (b.status !== 403) die(`scoped key on a different project should 403, got ${b.status}`);
    ok('scoped key on a different project → 403');
  }

  const enumr = await call(scoped, '/projects');
  if (enumr.status !== 403) die(`scoped key enumerating projects should 403, got ${enumr.status}`);
  ok('scoped key cannot enumerate projects → 403');

  // 5. Clean up.
  await db.execute(sql`
    delete from kortix.account_tokens where name in ('e2e-create-scope-admin', 'e2e-create-scope-key')
  `);

  process.stdout.write('\n  \x1b[0;32mAll create-scope checks passed.\x1b[0m\n\n');
  process.exit(0);
}

main().catch((e) => die(String((e as Error)?.stack ?? e)));
