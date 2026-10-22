/**
 * Integration test (real local DB): two first sessions in a fresh project
 * both resolve the governed agent's standing identity at once. Each kickoff
 * reads no service account and inserts one; the loser must get the winner's
 * account, never an error. An error there reaches the session-credential
 * guard, which (correctly) refuses to mint a token that would authorize as the
 * launcher, so one of the two sessions failed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { accounts, projects, serviceAccounts } from '@kortix/db';
import { db } from '../shared/db';
import { ensureAgentServiceAccount } from '../repositories/service-accounts';

const ACCOUNT = crypto.randomUUID();
const FRESH_PROJECTS = Array.from({ length: 6 }, () => crypto.randomUUID());

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'agent-sa-race' });
  await db.insert(projects).values(
    FRESH_PROJECTS.map((projectId, index) => ({
      projectId,
      accountId: ACCOUNT,
      name: `fresh-${index}`,
      repoUrl: `https://example.com/fresh-${index}.git`,
    })),
  );
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('agent service account under concurrent first kickoffs', () => {
  test('two concurrent kickoffs in a fresh project share one service account', async () => {
    for (const projectId of FRESH_PROJECTS) {
      const kickoff = () => ensureAgentServiceAccount({ accountId: ACCOUNT, projectId, agentName: 'kortix' });
      const results = await Promise.allSettled([kickoff(), kickoff()]);

      const rejected = results.filter((result) => result.status === 'rejected');
      expect(rejected.map((result) => String((result as PromiseRejectedResult).reason))).toEqual([]);
      const [first, second] = results.map((result) => (result as PromiseFulfilledResult<string>).value);
      expect(first).toBeTruthy();
      expect(second).toBe(first);

      const rows = await db
        .select({ id: serviceAccounts.serviceAccountId })
        .from(serviceAccounts)
        .where(and(eq(serviceAccounts.projectId, projectId), eq(serviceAccounts.agentName, 'kortix')));
      expect(rows.map((row) => row.id)).toEqual([first!]);
    }
  });
});
