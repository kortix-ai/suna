#!/usr/bin/env bun
/**
 * Live E2E for the CLI account-token auth flow. Run against a running API
 * (default http://localhost:8008) + the matching Postgres.
 *
 * Steps:
 *   1. Find an existing user/account in the DB.
 *   2. Mint a kortix_pat_... token and insert it into account_tokens.
 *   3. Hit GET /v1/accounts/me + GET /v1/projects with that token.
 *   4. Revoke the token; confirm /me now returns 401.
 *   5. Clean up the test row.
 *
 * Usage:
 *   bun run apps/api/src/__tests__/e2e-account-tokens.ts
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

interface RawRow extends Record<string, unknown> {
  user_id: string;
  account_id: string;
}

async function pickUserAndAccount(): Promise<RawRow> {
  const result = await db.execute<RawRow>(
    sql`select user_id, account_id from kortix.account_members order by joined_at limit 1`,
  );
  const rows = (result as unknown as { rows?: RawRow[] }).rows
    ?? (result as unknown as RawRow[]);
  const row = rows[0];
  if (!row) die('No rows in kortix.account_members. Seed a user first.');
  return row;
}

async function callApi<T>(token: string, path: string): Promise<{ status: number; body: T | null }> {
  const url = `${API_BASE}/v1${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
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
  return { status: res.status, body: body as T };
}

async function main() {
  process.stdout.write('\n  \x1b[1mKortix CLI E2E\x1b[0m  (account tokens → /accounts/me → /projects)\n');
  dim('api', API_BASE);

  const { user_id, account_id } = await pickUserAndAccount();
  dim('user', user_id);
  dim('acct', account_id);

  // Mint + insert
  const { publicKey, secretKey } = generateAccountTokenPair();
  const secretKeyHash = hashSecretKey(secretKey);
  await db.execute(sql`
    insert into kortix.account_tokens
      (account_id, user_id, name, public_key, secret_key_hash)
    values
      (${account_id}, ${user_id}, 'e2e-cli-test', ${publicKey}, ${secretKeyHash})
  `);
  dim('pat', `${secretKey.slice(0, 18)}…`);

  // /accounts/me
  const me = await callApi<{ user_id: string; email: string; accounts: unknown[] }>(secretKey, '/accounts/me');
  if (me.status !== 200) die(`/accounts/me → ${me.status} ${JSON.stringify(me.body)}`);
  if (me.body?.user_id !== user_id) die(`/me user_id mismatch: got ${me.body?.user_id}`);
  ok(`GET /v1/accounts/me → 200 (user_id matches, ${me.body.accounts.length} accounts)`);

  // /projects
  const projects = await callApi<unknown[]>(secretKey, '/projects');
  if (projects.status !== 200) die(`/projects → ${projects.status} ${JSON.stringify(projects.body)}`);
  ok(`GET /v1/projects → 200 (${(projects.body ?? []).length} project(s))`);

  // /accounts/tokens (list — should include the one we just minted)
  const tokens = await callApi<Array<{ name: string }>>(secretKey, '/accounts/tokens');
  if (tokens.status !== 200) die(`/accounts/tokens → ${tokens.status} ${JSON.stringify(tokens.body)}`);
  const found = (tokens.body ?? []).some((t) => t.name === 'e2e-cli-test');
  if (!found) die('e2e token not in /accounts/tokens list');
  ok(`GET /v1/accounts/tokens → 200 (e2e-cli-test present)`);

  // Revoke + verify 401
  await db.execute(sql`
    update kortix.account_tokens
    set status = 'revoked', revoked_at = now()
    where secret_key_hash = ${secretKeyHash}
  `);
  const afterRevoke = await callApi<unknown>(secretKey, '/accounts/me');
  if (afterRevoke.status !== 401) die(`revoked PAT should 401, got ${afterRevoke.status}`);
  ok('Revoked PAT → 401 as expected');

  // Cleanup
  await db.execute(sql`
    delete from kortix.account_tokens where secret_key_hash = ${secretKeyHash}
  `);

  process.stdout.write('\n  \x1b[0;32mAll E2E checks passed.\x1b[0m\n\n');
  process.exit(0);
}

main().catch((err) => {
  die(`E2E failed: ${(err as Error).message}\n${(err as Error).stack ?? ''}`);
});
