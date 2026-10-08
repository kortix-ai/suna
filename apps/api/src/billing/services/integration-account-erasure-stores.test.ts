/**
 * Integration test (real local DB): account erasure empties the stores outside
 * the database before the rows that name them go (KRTX-1734): the parked
 * provider boxes, each project's session files and each Kortix-managed repo.
 * A failure in any of them leaves the account in place, so the run retries.
 *
 * Real: every row, the FK cascade and the deletion routine. Fakes: the provider
 * VM API, the Storage bucket (listing one level, as Supabase Storage does),
 * the git host, Stripe and the auth admin API.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { accounts } from '@kortix/db';

/** The `session-attachments` bucket: `<project_id>/<session_id>/<attachment_id>`. */
const bucket = new Set<string>();
const removedBoxes: string[] = [];
const deletedRepos: string[] = [];
let failBoxRemove = false;
let failRepoDelete = false;

const realSupabase = await import('../../shared/supabase');
mock.module('../../shared/supabase', () => ({
  ...realSupabase,
  getSupabase: () => ({
    auth: { admin: { deleteUser: async () => ({ error: null }) } },
    storage: {
      from: () => ({
        list: async (prefix: string) => ({
          data: [
            ...new Set(
              [...bucket]
                .filter((key) => key.startsWith(`${prefix}/`))
                .map((key) => key.slice(prefix.length + 1).split('/')[0]!),
            ),
          ].map((name) => ({ name })),
          error: null,
        }),
        remove: async (keys: string[]) => {
          for (const key of keys) bucket.delete(key);
          return { error: null };
        },
      }),
    },
  }),
}));
const realStripe = await import('../../shared/stripe');
mock.module('../../shared/stripe', () => ({
  ...realStripe,
  getStripe: () => ({ subscriptions: { cancel: async () => ({}) } }),
}));
const realProviders = await import('../../platform/providers');
mock.module('../../platform/providers', () => ({
  ...realProviders,
  tryGetProvider: () => ({
    stop: async () => undefined,
    remove: async (externalId: string) => {
      if (failBoxRemove) throw new Error('provider unavailable');
      removedBoxes.push(externalId);
    },
  }),
}));
const realGitBackends = await import('../../projects/git-backends');
mock.module('../../projects/git-backends', () => ({
  ...realGitBackends,
  getBackend: () => ({
    deleteRepo: async (ref: { repoName: string | null }) => {
      if (failRepoDelete) throw new Error('git host unavailable');
      deletedRepos.push(String(ref.repoName));
    },
  }),
}));

const { db } = await import('../../shared/db');
const { deleteAccountImmediately } = await import('./account-deletion');

const seeded: string[] = [];

/** A personal account with a managed project, a user-connected project, and boxes in every parked state. */
async function seed() {
  const accountId = crypto.randomUUID();
  const managed = crypto.randomUUID();
  const connected = crypto.randomUUID();
  const box = (status: string) => ({ sandboxId: crypto.randomUUID(), externalId: `ext-${status}-${accountId}`, status });
  const boxes = [box('stopped'), box('archived')];
  await db.insert(accounts).values({ accountId, name: 'erasure-stores' });
  await db.execute(sql`
    INSERT INTO kortix.projects (project_id, account_id, name, repo_url, metadata) VALUES
      (${managed}::uuid, ${accountId}::uuid, 'managed', 'https://git.example.test/managed.git',
       ${JSON.stringify({ git: { managed: true, provider: 'local', name: `repo-${managed}` } })}::jsonb),
      (${connected}::uuid, ${accountId}::uuid, 'connected', 'https://github.com/someone/theirs.git', '{}'::jsonb)`);
  for (const [i, b] of boxes.entries()) {
    const sessionId = `erasure-${b.sandboxId}`;
    await db.execute(sql`
      INSERT INTO kortix.project_sessions (session_id, account_id, project_id, branch_name, status)
      VALUES (${sessionId}, ${accountId}::uuid, ${managed}::uuid, ${`br-${i}-${b.sandboxId}`}, 'stopped')`);
    await db.execute(sql`
      INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status, external_id)
      VALUES (${b.sandboxId}::uuid, ${sessionId}, ${accountId}::uuid, ${managed}::uuid,
              ${b.status}::kortix.session_sandbox_status, ${b.externalId})`);
  }
  bucket.add(`${managed}/s1/a1`).add(`${managed}/s1/a2`).add(`${connected}/s2/a3`);
  seeded.push(accountId);
  return { accountId, managed, connected, boxes };
}

const accountExists = async (accountId: string) =>
  (await db.select({ id: accounts.accountId }).from(accounts).where(eq(accounts.accountId, accountId))).length > 0;

beforeEach(() => {
  removedBoxes.length = 0;
  deletedRepos.length = 0;
  failBoxRemove = false;
  failRepoDelete = false;
});

afterAll(async () => {
  for (const accountId of seeded) {
    await db.execute(sql`DELETE FROM kortix.accounts WHERE account_id = ${accountId}::uuid`).catch(() => undefined);
  }
});

describe('account erasure empties the stores outside the database', () => {
  test('parked boxes, every session file and the managed repo go; the connected repo and other files stay', async () => {
    const { accountId, managed, boxes } = await seed();
    const neighbor = `${crypto.randomUUID()}/s9/a9`;
    bucket.add(neighbor);

    await deleteAccountImmediately(accountId, accountId);

    expect(removedBoxes.sort()).toEqual(boxes.map((b) => b.externalId).sort());
    expect([...bucket]).toEqual([neighbor]);
    expect(deletedRepos).toEqual([`repo-${managed}`]);
    expect(await accountExists(accountId)).toBe(false);
    bucket.delete(neighbor);
  });

  test('a box the provider will not remove keeps the account, its files and its repo; the retry finishes', async () => {
    const { accountId, managed } = await seed();
    failBoxRemove = true;

    await expect(deleteAccountImmediately(accountId, accountId)).rejects.toThrow('could not be removed');
    expect(await accountExists(accountId)).toBe(true);
    expect(bucket.size).toBe(3);
    expect(deletedRepos).toEqual([]);

    failBoxRemove = false;
    await deleteAccountImmediately(accountId, accountId);
    expect(await accountExists(accountId)).toBe(false);
    expect(bucket.size).toBe(0);
    expect(deletedRepos).toEqual([`repo-${managed}`]);
  });

  test('a repo the git host will not delete keeps the account; the retry finishes', async () => {
    const { accountId, managed } = await seed();
    failRepoDelete = true;

    await expect(deleteAccountImmediately(accountId, accountId)).rejects.toThrow('git host unavailable');
    expect(await accountExists(accountId)).toBe(true);

    failRepoDelete = false;
    await deleteAccountImmediately(accountId, accountId);
    expect(await accountExists(accountId)).toBe(false);
    expect(deletedRepos).toEqual([`repo-${managed}`]);
  });
});
