import { expect, test } from '@playwright/test';

import { createApiJsonClient } from '../helpers/http';
import { createManifestProject, type ManifestProject } from '../helpers/manifest-project';
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from '../helpers/session-auth';
import { dismissOnboarding, dismissWelcomeCard, selectAccountForUi } from '../helpers/ui';

/**
 * Apps are a per-agent resource — the editor's Access rail has an Apps page
 * beside Skills, Connectors and Secrets, and it writes `agents.<name>.apps`
 * through the same agent-config PUT as every other grant.
 *
 * Three things only a browser can prove, so they live here rather than in a
 * REST flow: the page is gated on the project's `apps` feature flag, a pick
 * puts the App's SLUG (never its id) on the wire, and `All` sends the `all`
 * literal instead of an expanded list that would freeze the grant at today's
 * App roster.
 */
const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const databaseUrl = process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
const auth = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321',
  password: 'AgentAppsGrantE2e123!',
};
const api = createApiJsonClient(apiBase);

test('31 — the agent editor grants Apps by slug, gated on the Apps feature flag', async ({
  page,
}) => {
  test.setTimeout(180_000);
  test.skip(!databaseUrl, 'KE2E_DATABASE_URL is required');
  const runId = Date.now().toString(36);
  const email = `agent-apps-grant-${runId}@example.test`;
  const owner = await createAuthUser(email, auth);
  let project: ManifestProject | undefined;
  let appId = '';
  try {
    const session = await signIn(email, auth);
    const token = session.access_token;
    const accounts = await api<Array<{ account_id: string; personal_account: boolean }>>(
      token,
      'GET',
      '/accounts',
    );
    const accountId = accounts.find((a) => a.personal_account)?.account_id ?? accounts[0]?.account_id;
    if (!accountId) throw new Error('owner has no account');
    project = await createManifestProject({
      api,
      accessToken: token,
      accountId,
      userId: owner.id,
      name: 'Agent Apps grant browser test',
      databaseUrl: databaseUrl as string,
    });
    const configEndpoint = `/projects/${project.id}/agents/kortix/config`;
    const route = `/projects/${project.id}/customize/agents/kortix?section=apps`;

    await installBrowserSessionDirect(page, session, route, auth);
    await selectAccountForUi(page, accountId);

    // 1. Flag off: the rail has no Apps topic and `?section=apps` falls back.
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await dismissOnboarding(page);
    await dismissWelcomeCard(page);
    await expect(page.getByRole('link', { name: 'Kortix permissions' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Apps', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('agent-apps-grant')).toHaveCount(0);

    // 2. Flag on, with one restricted App to grant.
    await api(token, 'PATCH', `/projects/${project.id}/features`, {
      feature: 'apps',
      enabled: true,
    });
    const app = await api<{ app_id: string; slug: string }>(
      token,
      'POST',
      `/projects/${project.id}/apps`,
      { slug: `reports-dashboard-${runId}`, name: 'Reports dashboard' },
      201,
    );
    appId = app.app_id;
    await api(token, 'PATCH', `/projects/${project.id}/apps/${appId}/access`, {
      mode: 'restricted',
      member_ids: [owner.id],
    });

    const writes: Array<{ status: number; body: Record<string, unknown> }> = [];
    page.on('response', (response) => {
      if (response.request().method() === 'PUT' && response.url().endsWith(configEndpoint)) {
        writes.push({ status: response.status(), body: response.request().postDataJSON() });
      }
    });

    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await dismissWelcomeCard(page);
    const section = page.getByTestId('agent-apps-grant');
    await expect(section).toBeVisible();
    // The row is the App's SLUG — the value the grant stores — plus its name.
    await expect(section.getByText(app.slug, { exact: true })).toBeVisible();
    await expect(section.getByText('Reports dashboard', { exact: true })).toBeVisible();
    await expect(section.getByText('Grant decides', { exact: true })).toBeVisible();
    await expect(
      section.getByText('The agent also needs project.app.read in its Kortix permissions.'),
    ).toBeVisible();

    // 3. Pick the App. The PUT carries the slug, and the read-back agrees.
    await section.getByRole('tab', { name: 'Pick' }).click();
    await section.getByRole('checkbox', { name: `Grant ${app.slug}` }).click();
    await dismissWelcomeCard(page);
    await page.getByRole('button', { name: /^Save/ }).click();
    await expect.poll(() => writes.at(-1)?.body.apps).toEqual([app.slug]);
    expect(writes.at(-1)?.status).toBe(200);
    const picked = await api<{ block: { apps: string[] | 'all' } }>(token, 'GET', configEndpoint);
    expect(picked.block.apps).toEqual([app.slug]);

    // 4. All sends the literal, so an App added later is covered too.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await dismissWelcomeCard(page);
    await expect(section.getByRole('checkbox', { name: `Grant ${app.slug}` })).toBeChecked();
    await section.getByRole('tab', { name: 'All' }).click();
    await page.getByRole('button', { name: /^Save/ }).click();
    await expect.poll(() => writes.at(-1)?.body.apps).toBe('all');
    const all = await api<{ block: { apps: string[] | 'all' } }>(token, 'GET', configEndpoint);
    expect(all.block.apps).toBe('all');

    await page.screenshot({ path: test.info().outputPath('agent-apps-grant.png'), fullPage: true });
  } finally {
    if (project && appId) {
      const session = await signIn(email, auth).catch(() => null);
      if (session) {
        await api(
          session.access_token,
          'DELETE',
          `/projects/${project.id}/apps/${appId}`,
          undefined,
          [200, 204, 404],
        ).catch(() => undefined);
      }
    }
    await project?.dispose();
    await deleteAuthUser(owner.id, auth);
  }
});
