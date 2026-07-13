import { expect, test } from '@playwright/test';

import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSession,
  signIn,
} from '../helpers/session-auth';
import { apiJson, apiStatus } from '../helpers/http';

const apiBase = process.env.E2E_API_URL || 'http://localhost:19008/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const password = 'TestPass123!selector';
const authOptions = {
  supabaseUrl,
  password,
  envFiles: ['apps/web/.env', 'apps/api/.env'],
};

test.describe('14 — ACP harness-aware composer selectors', () => {
  test.setTimeout(180_000);

  test('switches all four harnesses and creates Codex with its native model override', async ({
    page,
  }) => {
    const email = `acp-selector-${Date.now()}@example.test`;
    const user = await createAuthUser(email, authOptions);
    const session = await signIn(email, authOptions);
    let projectId: string | null = null;

    try {
      const accounts = await apiJson<Array<{ account_id: string; personal_account?: boolean }>>(
        apiBase,
        session.access_token,
        'GET',
        '/accounts',
      );
      const accountId =
        accounts.find((account) => account.personal_account)?.account_id ?? accounts[0]?.account_id;
      expect(accountId).toBeTruthy();

      const project = await apiJson<{ project_id?: string; id?: string }>(
        apiBase,
        session.access_token,
        'POST',
        '/projects/provision',
        {
          account_id: accountId,
          name: `ACP selector ${Date.now()}`,
          seed_starter: true,
        },
        [200, 201],
      );
      projectId = project.project_id ?? project.id ?? null;
      expect(projectId).toBeTruthy();

      await apiStatus(apiBase, session.access_token, 'POST', '/setup/setup-complete', {});
      await apiStatus(apiBase, session.access_token, 'PATCH', `/projects/${projectId}/onboarding`, {
        completed: true,
      });
      await installBrowserSession(page, session, `/projects/${projectId}`, password);

      const agentSelector = page.getByTestId('agent-selector');
      await expect(agentSelector).toBeVisible({ timeout: 60_000 });
      await expect(agentSelector).toHaveAttribute('data-harness', 'opencode');
      await expect(page.getByTestId('catalog-model-selector')).toBeVisible();
      await expect(page.getByTestId('harness-model-selector')).toHaveCount(0);

      await agentSelector.click();
      for (const label of ['Claude Code', 'Codex', 'OpenCode', 'Pi']) {
        await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
      }

      for (const harness of ['claude', 'pi'] as const) {
        await page.locator(`[data-testid="agent-option"][data-harness="${harness}"]`).click();
        await expect(agentSelector).toHaveAttribute('data-harness', harness);
        await expect(page.getByTestId('harness-model-selector')).toHaveAttribute(
          'data-harness',
          harness,
        );
        await agentSelector.click();
      }

      await page
        .locator('[data-testid="agent-option"][data-harness="opencode"][data-agent="kortix"]')
        .click();
      await expect(agentSelector).toHaveAttribute('data-harness', 'opencode');
      await expect(page.getByTestId('catalog-model-selector')).toBeVisible();
      await agentSelector.click();

      await page.locator('[data-testid="agent-option"][data-harness="codex"]').click();
      await expect(agentSelector).toHaveAttribute('data-harness', 'codex');
      const harnessModel = page.getByTestId('harness-model-selector');
      await harnessModel.click();
      await page.getByTestId('harness-model-custom-input').fill('openai/gpt-5.4');
      await page.getByRole('button', { name: 'Apply', exact: true }).click();
      await expect(harnessModel).toContainText('openai/gpt-5.4');

      const createRequest = page.waitForRequest(
        (request) =>
          request.method() === 'POST' &&
          request.url().endsWith(`/v1/projects/${projectId}/sessions`),
      );
      const composer = page.locator('textarea').last();
      await composer.fill('Verify the ACP selector payload');
      await composer.press('Enter');
      const request = await createRequest;
      expect(request.postDataJSON()).toMatchObject({
        agent_name: 'codex',
        runtime_model: 'openai/gpt-5.4',
      });
    } finally {
      if (projectId) {
        await apiStatus(apiBase, session.access_token, 'DELETE', `/projects/${projectId}`).catch(
          () => 0,
        );
      }
      await deleteAuthUser(user.id, {
        supabaseUrl,
        envFiles: authOptions.envFiles,
      });
    }
  });
});
