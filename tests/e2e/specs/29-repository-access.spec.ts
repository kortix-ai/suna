import { expect, test } from '@playwright/test';
import { createApiJsonClient } from '../helpers/http';
import { createManifestProject, type ManifestProject } from '../helpers/manifest-project';
import { createAuthUser, deleteAuthUser, installBrowserSessionDirect, signIn } from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const databaseUrl = process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
const auth = { supabaseUrl: process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321', password: 'RepositoryAccessE2e123!' };
const api = createApiJsonClient(apiBase);

test('29 — repository access toggle saves both policies and replaces the legacy mode selector', async ({ page }) => {
  test.setTimeout(180_000);
  if (!databaseUrl) throw new Error('KE2E_DATABASE_URL is required');
  const email = `repository-access-${Date.now()}@example.test`;
  const owner = await createAuthUser(email, auth);
  let project: ManifestProject | undefined;
  try {
    const session = await signIn(email, auth);
    const accounts = await api<Array<{ account_id: string; personal_account: boolean }>>(session.access_token, 'GET', '/accounts');
    const accountId = accounts.find((a) => a.personal_account)?.account_id ?? accounts[0]?.account_id;
    if (!accountId) throw new Error('owner has no account');
    project = await createManifestProject({ api, accessToken: session.access_token, accountId, userId: owner.id,
      name: 'Repository access browser test', databaseUrl });
    const endpoint = `/projects/${project.id}/agents/kortix/config`;
    // Start with an existing runtime declaration, as a customer would during migration.
    await api(session.access_token, 'PUT', endpoint, { workspace: 'runtime' });
    const route = `/projects/${project.id}/customize/agents/kortix?section=workspace`;
    await installBrowserSessionDirect(page, session, route, auth);
    await selectAccountForUi(page, accountId);
    await page.goto(route);
    await dismissOnboarding(page);
    const welcome = page.getByRole('complementary', { name: /Welcome from Marko/i });
    if (await welcome.isVisible().catch(() => false)) {
      await welcome.getByRole('button', { name: /dismiss|close/i }).click();
    }
    const toggle = page.getByRole('switch', { name: 'Project repository access', exact: true });
    await expect(toggle).not.toBeChecked();
    await expect(page.getByRole('combobox', { name: 'File access' })).toHaveCount(0);
    const writes: Array<{ status: number; body: Record<string, unknown> }> = [];
    page.on('response', (response) => {
      if (response.request().method() === 'PUT' && response.url().endsWith(endpoint)) {
        writes.push({ status: response.status(), body: response.request().postDataJSON() });
      }
    });
    for (const enabled of [true, false]) {
      await toggle.click();
      await page.getByRole('button', { name: /^Save/ }).click();
      await expect.poll(() => writes.at(-1)?.body.repository_access).toBe(enabled);
      expect(writes.at(-1)?.status).toBe(200);
      expect(writes.at(-1)?.body).not.toHaveProperty('workspace');
      const read = await api<{ block: { repository_access: boolean } }>(session.access_token, 'GET', endpoint);
      expect(read.block.repository_access).toBe(enabled);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(toggle).toBeChecked({ checked: enabled });
    }
    await expect(page.getByText('New sessions run without the project repository.', { exact: false })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('repository-access.png'), fullPage: true });
  } finally {
    await project?.dispose();
    await deleteAuthUser(owner.id, auth);
  }
});
