/**
 * One connection row per (account, GitHub owner), against the real table.
 *
 * Reconnecting the GitHub App mints a NEW installation id for the same owner.
 * `upsertAccountGitHubInstallation` conflicted on `(account_id,
 * installation_id)` only, so the reconnect INSERTed beside the retired row
 * instead of replacing it. The list is read oldest-first by nobody now, but the
 * duplicate row itself is the defect: both rows render as
 * `github.com/<owner> · Personal account`, and minting a token for the retired
 * one answers 404 — which reached the user as "This GitHub connection is no
 * longer valid. Reconnect it in Settings → Git." right after reconnecting
 * (prod, 2026-09-25).
 *
 * Also pins `dropAccountGitHubInstallation`, the delete behind the self-heal in
 * `resolveGitHubRepoAuth`: it removes one row of one account and nothing else.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountGithubInstallations } from '@kortix/db';
import { and, eq } from 'drizzle-orm';

import { dropAccountGitHubInstallation, listAccountGitHubInstallations } from '../projects/lib/git';
import { upsertAccountGitHubInstallation } from '../projects/routes/github-installations';
import { db } from '../shared/db';
import { seedAccount } from './helpers/integration-fixtures';

let accountId = '';
let otherAccountId = '';

/** The shape `upsertAccountGitHubInstallation` reads off GitHub's API. */
function installation(login: string, type: 'User' | 'Organization' = 'User') {
  return {
    account: { login, type },
    target_type: type,
    repository_selection: 'all',
    permissions: { contents: 'write' },
    html_url: `https://github.com/settings/installations/${login}`,
  } as Parameters<typeof upsertAccountGitHubInstallation>[2];
}

async function rowsFor(id: string) {
  return await db
    .select()
    .from(accountGithubInstallations)
    .where(eq(accountGithubInstallations.accountId, id));
}

beforeAll(async () => {
  accountId = await seedAccount('github-installation-dedupe');
  otherAccountId = await seedAccount('github-installation-dedupe-other');
});

afterAll(async () => {
  for (const id of [accountId, otherAccountId]) {
    await db.delete(accountGithubInstallations).where(eq(accountGithubInstallations.accountId, id));
  }
});

describe('upsertAccountGitHubInstallation', () => {
  test('a reconnect REPLACES the retired connection for that owner', async () => {
    await upsertAccountGitHubInstallation(accountId, '163461158', installation('octo-person'));
    await upsertAccountGitHubInstallation(accountId, '164878417', installation('octo-person'));

    const rows = await rowsFor(accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.installationId).toBe('164878417');
  });

  test('a second owner is a second connection, not a replacement', async () => {
    await upsertAccountGitHubInstallation(accountId, '900001', installation('acme-org', 'Organization'));

    const logins = (await rowsFor(accountId)).map((row) => row.ownerLogin).sort();
    expect(logins).toEqual(['acme-org', 'octo-person']);
  });

  test('re-linking the SAME installation updates it in place', async () => {
    const before = await rowsFor(accountId);
    await upsertAccountGitHubInstallation(accountId, '164878417', installation('octo-person'));

    const after = await rowsFor(accountId);
    expect(after).toHaveLength(before.length);
    expect(after.find((row) => row.installationId === '164878417')?.ownerType).toBe('User');
  });

  test('another account keeps its own connection to the same owner', async () => {
    await upsertAccountGitHubInstallation(otherAccountId, '163461158', installation('octo-person'));
    await upsertAccountGitHubInstallation(accountId, '164878417', installation('octo-person'));

    expect((await rowsFor(otherAccountId)).map((row) => row.installationId)).toEqual(['163461158']);
    expect((await rowsFor(accountId)).some((row) => row.installationId === '164878417')).toBe(true);
  });
});

describe('listAccountGitHubInstallations', () => {
  test('returns the newest connection first', async () => {
    const rows = await listAccountGitHubInstallations(accountId);
    const created = rows.map((row) => row.createdAt.getTime());
    expect(created).toEqual([...created].sort((a, b) => b - a));
  });
});

describe('the unique index', () => {
  test('a second connection to the same owner cannot be inserted at all', async () => {
    await upsertAccountGitHubInstallation(accountId, '164878417', installation('octo-person'));

    // Straight to the table, bypassing the route helper: this is what proves
    // uniq_account_github_installations_owner exists in the migrated database,
    // not just that the helper deletes first.
    // `.execute()`, not the query builder itself: the builder is thenable but
    // is not a Promise, which `rejects` requires.
    const duplicate = db
      .insert(accountGithubInstallations)
      .values({
        accountId,
        installationId: '900999',
        ownerLogin: 'octo-person',
        ownerType: 'User',
      })
      .execute();

    // Assert the SQLSTATE on the CAUSE: a Drizzle failure's own message is only
    // `Failed query: <sql>` — the constraint and 23505 hang off `cause`
    // (learnings: "A wrapper error hides its cause").
    const failure = await duplicate.then(
      () => null,
      (error: unknown) => error as { cause?: { code?: string; constraint_name?: string } },
    );
    expect(failure).not.toBeNull();
    expect(failure?.cause?.code).toBe('23505');
    expect(failure?.cause?.constraint_name).toBe('uniq_account_github_installations_owner');
  });
});

describe('dropAccountGitHubInstallation', () => {
  test('removes exactly one row, and only from its own account', async () => {
    await upsertAccountGitHubInstallation(accountId, '164878417', installation('octo-person'));
    await upsertAccountGitHubInstallation(otherAccountId, '163461158', installation('octo-person'));

    await dropAccountGitHubInstallation(accountId, '164878417');

    expect(
      await db
        .select()
        .from(accountGithubInstallations)
        .where(
          and(
            eq(accountGithubInstallations.accountId, accountId),
            eq(accountGithubInstallations.installationId, '164878417'),
          ),
        ),
    ).toHaveLength(0);
    expect((await rowsFor(otherAccountId)).map((row) => row.installationId)).toEqual(['163461158']);
  });
});
