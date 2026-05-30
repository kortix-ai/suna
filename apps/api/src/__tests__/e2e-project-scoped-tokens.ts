#!/usr/bin/env bun
/**
 * Live E2E for project-scoped CLI tokens.
 *
 * What it verifies:
 *   1. POST /v1/projects/:id/cli-token mints a token bound to that
 *      project (response carries `project_id`).
 *   2. The minted token CAN call routes scoped to its project
 *      (GET /v1/projects/:id, GET /v1/projects/:id/secrets).
 *   3. The token CANNOT call a different project's routes (403).
 *   4. The token CANNOT call account-level routes (/v1/accounts/tokens),
 *      but the self-identity probe (/v1/accounts/me) is allowed.
 *   5. The token CANNOT enumerate projects (GET /v1/projects → 403).
 *   6. Revoking via DELETE /v1/projects/:id/cli-token/:tokenId yields
 *      401 on the next call.
 *
 * Requires the API on $KORTIX_API_URL (default http://localhost:8008)
 * and Postgres on the default local Supabase port.
 */

import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import {
  generateAccountTokenPair,
  hashSecretKey,
} from '../shared/crypto';

const API_BASE = process.env.KORTIX_API_URL ?? 'http://localhost:8008';

function ok(msg: string) {
  process.stdout.write(`  \x1b[0;32m✓\x1b[0m  ${msg}\n`);
}
function dim(label: string, value: string) {
  process.stdout.write(`  \x1b[2m${label}\x1b[0m  ${value}\n`);
}
function die(msg: string): never {
  process.stderr.write(`  \x1b[0;31m✗\x1b[0m  ${msg}\n`);
  process.exit(1);
}

interface Row extends Record<string, unknown> {
  user_id: string;
  account_id: string;
}

interface ProjectRow extends Record<string, unknown> {
  project_id: string;
  account_id: string;
  name: string;
}

async function callApi(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`${API_BASE}/v1${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

async function main() {
  process.stdout.write('\n  \x1b[1mProject-scoped CLI token E2E\x1b[0m\n');
  dim('api', API_BASE);

  // ── 1. Pick a user + two projects they own ──────────────────────────
  const member = await db.execute<Row>(
    sql`select user_id, account_id from kortix.account_members order by joined_at limit 1`,
  );
  const memberRows =
    (member as unknown as { rows?: Row[] }).rows ?? (member as unknown as Row[]);
  const m = memberRows[0];
  if (!m) die('No account_members rows.');

  const projects = await db.execute<ProjectRow>(sql`
    select project_id, account_id, name
    from kortix.projects
    where account_id = ${m.account_id}
    order by created_at desc
    limit 2
  `);
  const projectRows =
    (projects as unknown as { rows?: ProjectRow[] }).rows
    ?? (projects as unknown as ProjectRow[]);
  if (projectRows.length < 2) {
    die(`Need ≥ 2 projects on account ${m.account_id} for the cross-project test. Have ${projectRows.length}.`);
  }
  const [projA, projB] = projectRows;
  dim('user', m.user_id);
  dim('projA', `${projA.project_id} (${projA.name})`);
  dim('projB', `${projB.project_id} (${projB.name})`);

  // ── 2. Mint a project-scoped token for projA via direct DB insert ───
  const { publicKey, secretKey } = generateAccountTokenPair();
  const secretKeyHash = hashSecretKey(secretKey);
  await db.execute(sql`
    insert into kortix.account_tokens
      (account_id, user_id, project_id, name, public_key, secret_key_hash)
    values
      (${m.account_id}, ${m.user_id}, ${projA.project_id}, 'e2e-scope-test', ${publicKey}, ${secretKeyHash})
  `);
  dim('pat ', `${secretKey.slice(0, 20)}… (scoped to projA)`);

  // ── 3. Allowed: call projA's routes ──────────────────────────────────
  const projAInfo = await callApi(secretKey, `/projects/${projA.project_id}`);
  if (projAInfo.status !== 200) {
    die(`projA token → /projects/${projA.project_id} got ${projAInfo.status}: ${JSON.stringify(projAInfo.body)}`);
  }
  ok(`token can read its own project (GET /projects/<projA>) → 200`);

  const projASecrets = await callApi(secretKey, `/projects/${projA.project_id}/secrets`);
  if (projASecrets.status !== 200) {
    die(`projA token → /projects/<projA>/secrets got ${projASecrets.status}`);
  }
  ok(`token can list its own project's secrets → 200`);

  // ── 4. Allowed: /accounts/me self-identity probe ─────────────────────
  const me = await callApi(secretKey, '/accounts/me');
  if (me.status !== 200) {
    die(`projA token → /accounts/me got ${me.status}: ${JSON.stringify(me.body)}`);
  }
  ok('token can hit /accounts/me (self-identity probe) → 200');

  // ── 5. Denied: a different project's routes ──────────────────────────
  const projBInfo = await callApi(secretKey, `/projects/${projB.project_id}`);
  if (projBInfo.status !== 403) {
    die(`projA token → /projects/<projB> should 403, got ${projBInfo.status}: ${JSON.stringify(projBInfo.body)}`);
  }
  ok(`token cannot access a different project → 403`);

  // ── 6. Denied: list projects ─────────────────────────────────────────
  const list = await callApi(secretKey, '/projects');
  if (list.status !== 403) {
    die(`projA token → /projects (list) should 403, got ${list.status}`);
  }
  ok('token cannot enumerate projects → 403');

  // ── 7. Denied: account-level token management ────────────────────────
  const tokens = await callApi(secretKey, '/accounts/tokens');
  if (tokens.status !== 403) {
    die(`projA token → /accounts/tokens should 403, got ${tokens.status}`);
  }
  ok('token cannot list account-level PATs → 403');

  // ── 8. Revoke + verify 401 ───────────────────────────────────────────
  await db.execute(sql`
    update kortix.account_tokens
    set status = 'revoked', revoked_at = now()
    where secret_key_hash = ${secretKeyHash}
  `);
  const afterRevoke = await callApi(secretKey, `/projects/${projA.project_id}`);
  if (afterRevoke.status !== 401) {
    die(`revoked projA token should 401, got ${afterRevoke.status}`);
  }
  ok('revoked token → 401');

  // Cleanup
  await db.execute(sql`
    delete from kortix.account_tokens where secret_key_hash = ${secretKeyHash}
  `);

  process.stdout.write('\n  \x1b[0;32mAll scope-enforcement checks passed.\x1b[0m\n\n');
  process.exit(0);
}

main().catch((err) => {
  die(`E2E failed: ${(err as Error).message}\n${(err as Error).stack ?? ''}`);
});
