import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accounts } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

let project: SeededProject;
beforeAll(async () => { project = await seedProject('single-connection-token'); });
afterAll(async () => { await removeSeeded([project]); });

test('project PAT mint and policy enforcement use the transaction connection', async () => {
  await db.update(accounts).set({ patRequireExpiry: true }).where(eq(accounts.accountId, project.account_id));
  // A separate process configures the real product pool before module loading.
  // Its deadline also terminates a regression that queues forever on the pool.
  const child = Bun.spawn(['timeout', '5s', 'bun', '--no-env-file', '--eval', `
    import { createAccountToken, PatPolicyError } from './src/repositories/account-tokens';
    const params = {
      accountId: process.env.PROBE_ACCOUNT_ID,
      projectId: process.env.PROBE_PROJECT_ID,
      userId: crypto.randomUUID(), name: 'single-connection-pat',
    };
    try {
      await createAccountToken(params);
      throw new Error('Missing expiry was accepted');
    } catch (error) {
      if (!(error instanceof PatPolicyError) || error.code !== 'expiry_required') throw error;
    }
    const token = await createAccountToken({ ...params, expiresAt: new Date(Date.now() + 60000) });
    if (token.status !== 'active' || token.projectId !== params.projectId) throw new Error('Invalid mint');
    process.stdout.write('policy enforced; project PAT minted');
    process.exit(0);
  `], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: { ...process.env, DB_POOL_MAX: '1', PROBE_ACCOUNT_ID: project.account_id, PROBE_PROJECT_ID: project.project_id },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(exit, stderr).toBe(0);
  expect(stdout).toEndWith('policy enforced; project PAT minted');
}, 10000);
