import { expect, test } from '@playwright/test';
import { authHeaders, createApiResultClient } from '../helpers/http';
import {
  type AuthSession,
  type AuthUser,
  createAuthUser,
  deleteAuthUser,
  installBrowserSession,
  signIn,
} from '../helpers/session-auth';

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const password = 'E2eConnectorOauth123!';
const api = createApiResultClient(apiBase);
const authOptions = { supabaseUrl, password };

test.describe('13 — Custom connector OAuth2', () => {
  test.setTimeout(180_000);

  let user: AuthUser;
  let session: AuthSession;
  let projectId: string;

  test.beforeAll(async () => {
    const email = `e2e-connector-oauth-${Date.now()}@kortix.test`;
    user = await createAuthUser(email, authOptions);
    session = await signIn(email, authOptions);

    const response = await fetch(`${apiBase}/projects/provision`, {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({
        name: `e2e-connector-oauth-${Date.now()}`,
      }),
    });
    const body = (await response.json()) as { project_id?: string; error?: string };
    expect(response.status, JSON.stringify(body)).toBe(201);
    expect(body.project_id).toBeTruthy();
    if (!body.project_id)
      throw new Error(`Project provision returned no project_id: ${JSON.stringify(body)}`);
    projectId = body.project_id;
  });

  test.afterAll(async () => {
    if (projectId && session) {
      await api(session.access_token, 'DELETE', `/projects/${projectId}`).catch(() => {});
    }
    if (user?.id) await deleteAuthUser(user.id, authOptions);
  });

  test('shows every OAuth2 client-credentials strategy during connector creation', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await installBrowserSession(
      page,
      session,
      `/projects/${projectId}/customize/connectors`,
      password,
    );
    await expect(page.getByRole('dialog', { name: /Customize/i })).toBeVisible();
    await page.getByRole('tab', { name: /^Custom$/ }).click();

    const authSelect = page.getByRole('combobox', { name: /^Auth$/ });
    await authSelect.click();
    await expect(page.getByRole('option', { name: 'OAuth 2.0 client credentials' })).toBeVisible();
    await page.getByRole('option', { name: 'OAuth 2.0 client credentials' }).click();

    await expect(page.getByLabel('Token URL')).toBeVisible();
    await expect(page.getByLabel('Client ID')).toBeVisible();
    await expect(page.getByLabel('Client secret')).toBeVisible();
    await expect(page.getByRole('button', { name: /Add connector/i })).toBeDisabled();

    const methodSelect = page.getByRole('combobox', { name: 'Token authentication' });
    await methodSelect.click();
    await expect(page.getByRole('option', { name: 'Client secret in body' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Client secret with Basic' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Certificate assertion' })).toBeVisible();
    await page.getByRole('option', { name: 'Certificate assertion' }).click();

    await expect(page.getByLabel('Private key PEM')).toBeVisible();
    await expect(page.getByLabel('Certificate SHA-256 thumbprint')).toBeVisible();
    await expect(page.getByLabel('Client secret')).toHaveCount(0);
    expect(pageErrors, `client errors: ${pageErrors.join(' | ')}`).toEqual([]);
  });
});
