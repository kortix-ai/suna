/**
 * A uuid column is never compared through `::text`.
 *
 * `id::text = ${x}` hides the column from its index: prod seq-scanned
 * `auth.users` (~411k rows, 130-480 ms) on every IAM cache miss until
 * #10327. Compare the column to the parameter instead: `id = ${x}::uuid`,
 * after `isUuid(x)` when `x` is user input (a bad uuid raises 22P02).
 *
 * ALLOWED holds the casts that stay: each one filters a few rows that an
 * index on another column already found, or a table of a handful of rows.
 */
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = new URL('..', import.meta.url).pathname;
const CAST = /\b[a-z_]*id::text\s*=\s*\$\{/g;

const ALLOWED = new Set([
  // `session_id` index first; the grantee filter runs on a session's grants.
  'projects/lib/session-list.ts: principal_id::text = ${',
  // `account_sso_providers` holds one row per SSO account.
  'iam/email-trust.ts: supabase_sso_provider_id::text = ${',
  // User input that may not be a uuid; `project_id` index first.
  'iam/assignments.ts: secret_id::text = ${',
  'iam/assignments.ts: connection_id::text = ${',
  // `projects` PK first, then the account's memberships.
  'iam/membership-read.ts: user_id::text = ${',
]);

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') yield* sourceFiles(path);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      yield path;
    }
  }
}

test('no uuid column is compared through ::text outside the allowlist', () => {
  const found: string[] = [];
  for (const file of sourceFiles(SRC)) {
    for (const match of readFileSync(file, 'utf8').matchAll(CAST)) {
      found.push(`${relative(SRC, file)}: ${match[0].replace(/\s+/g, ' ')}`);
    }
  }
  expect(found.filter((hit) => !ALLOWED.has(hit))).toEqual([]);
});
