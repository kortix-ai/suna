/**
 * Two callers ensuring the same agent's service account at once must both get
 * the one row. The loser's insert hits the unique index; drizzle wraps that
 * PostgresError in a DrizzleQueryError whose own `code` is undefined, so the
 * 23505 check must read the SQLSTATE through the cause chain. Before the fix
 * the loser threw, and a manual trigger fire answered 500 "Trigger agent
 * service account is unavailable" (release gate CLI-TRG, v0.13.50 staging).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { ensureAgentServiceAccount } from '../repositories/service-accounts';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const seeded: SeededProject[] = [];

afterAll(async () => {
  await removeSeeded(seeded);
});

describe('ensureAgentServiceAccount under a concurrent create', () => {
  test('every concurrent caller resolves to the same service account', async () => {
    const project = await seedProject('ensure-sa-race');
    seeded.push(project);
    const args = { accountId: project.account_id, projectId: project.project_id, agentName: 'racer' };

    const ids = await Promise.all(Array.from({ length: 8 }, () => ensureAgentServiceAccount(args)));

    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBeTruthy();
  });
});
