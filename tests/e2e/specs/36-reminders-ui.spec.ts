import { expect, test } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import { createDatabaseProject, createDatabaseSession, deleteDatabaseProject } from '../../src/fixtures/database-project';
import { seedSessionTranscript } from '../../src/fixtures/session-transcript';
import { createApiJsonClient } from '../helpers/http';
import { createAuthUser, deleteAuthUser, installBrowserSessionDirect, signIn } from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const databaseUrl = process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
const authOptions = { supabaseUrl, password: 'E2eRemindersUi123!' };
const api = createApiJsonClient(apiBase);

interface Reminder {
  id: string;
  state: string;
}

test.describe('36 — Reminders UI', () => {
  test('gates on the flag, lists and manages reminders, and shows them in the session', async ({ page }) => {
    test.skip(!databaseUrl, 'KE2E_DATABASE_URL is required');
    test.setTimeout(240_000);

    const runId = Date.now().toString(36);
    const email = `e2e-reminders-ui-${runId}@example.test`;
    const user = await createAuthUser(email, authOptions);
    const session = await signIn(email, authOptions);
    const env = loadEnv();
    let projectId: string | null = null;
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    try {
      const accounts = await api<Array<{ account_id: string; personal_account?: boolean }>>(
        session.access_token,
        'GET',
        '/accounts',
      );
      const accountId = (accounts.find((a) => a.personal_account) ?? accounts[0])!.account_id;
      const project = await createDatabaseProject(env, { accountId, userId: user.id, name: `Reminders UI ${runId}` });
      projectId = project.id;
      const sessionId = await createDatabaseSession(env, {
        projectId,
        accountId,
        userId: user.id,
        metadata: { custom_name: 'Vendor follow-up' },
      });
      const base = `/projects/${projectId}/sessions/${sessionId}/reminders`;

      // Flag off: the API refuses and the page shows the gate, without asking for reminders.
      await api(session.access_token, 'POST', base, { prompt: 'x', in: '1h' }, 403);
      const listRequests: string[] = [];
      page.on('request', (request) => {
        if (request.method() === 'GET' && request.url().endsWith(`/v1/projects/${projectId}/reminders`)) {
          listRequests.push(request.url());
        }
      });
      await installBrowserSessionDirect(page, session, '/favicon.png', authOptions);
      await selectAccountForUi(page, accountId);
      // The page opens on Calendar; the List is `?view=list`.
      await page.goto(`/projects/${projectId}/reminders?view=list`, { waitUntil: 'domcontentloaded' });
      await dismissOnboarding(page);
      await expect(page.getByRole('heading', { name: 'Reminders', exact: true })).toBeVisible();
      await expect(page.getByText('Turn on Reminders to let agents and people schedule check-ins')).toBeVisible();
      expect(listRequests).toEqual([]);

      // Flag on, two reminders on the session.
      await api(session.access_token, 'PATCH', `/projects/${projectId}/features`, { feature: 'reminders', enabled: true });
      const first = await api<Reminder>(session.access_token, 'POST', base, { prompt: 'Did the vendor reply?', in: '24h', every: '1h' }, 201);
      await api<Reminder>(session.access_token, 'POST', base, { prompt: 'Post the launch checklist', in: '2h' }, 201);

      await page.reload({ waitUntil: 'domcontentloaded' });
      const list = page.getByTestId('reminder-list');
      await expect(list.locator('tr[data-reminder-id]')).toHaveCount(2);
      await expect(list).toContainText('Did the vendor reply?');
      await expect(list).toContainText('Every 1h');
      await expect(list).toContainText('Vendor follow-up');
      const nav = page.getByRole('link', { name: /^Reminders\b/ });
      await expect(nav).toBeVisible();

      // Pause the recurring one: the PATCH carries enabled:false and the row leaves the Active tab.
      const paused = page.waitForResponse(
        (r) => r.url().endsWith(`${base}/${first.id}`) && r.request().method() === 'PATCH',
      );
      await page.locator(`tr[data-reminder-id="${first.id}"]`).getByRole('button', { name: 'Pause' }).click();
      const pausedResponse = await paused;
      expect(pausedResponse.status()).toBe(200);
      expect(pausedResponse.request().postDataJSON()).toEqual({ enabled: false });
      await expect(list.locator('tr[data-reminder-id]')).toHaveCount(1);
      await page.getByRole('tab', { name: /Paused/ }).click();
      await expect(page.locator(`tr[data-reminder-id="${first.id}"]`)).toBeVisible();

      // Remove it through the confirm dialog: one DELETE, and it is gone.
      const removed = page.waitForResponse(
        (r) => r.url().endsWith(`${base}/${first.id}`) && r.request().method() === 'DELETE',
      );
      await page.locator(`tr[data-reminder-id="${first.id}"]`).getByRole('button', { name: 'Remove' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
      expect((await removed).status()).toBe(200);
      await expect(page.locator(`tr[data-reminder-id="${first.id}"]`)).toHaveCount(0);

      // The session: a saved reminder turn renders as a Reminder card, and the header chip counts the active one.
      await seedSessionTranscript(env, {
        projectId,
        accountId,
        sessionId,
        messages: (root) => [
          {
            info: { id: 'msg_000000000000000000000001', sessionID: root, role: 'user', time: { created: Date.now() - 60_000 } },
            parts: [
              {
                id: 'prt_reminder_user',
                sessionID: root,
                messageID: 'msg_000000000000000000000001',
                type: 'text',
                text: '[REMINDER reminder.0123456789ab — one-time scheduled check-in on this session, not a new user message.]\n\nCheck whether the vendor replied.',
              },
            ],
          },
        ],
      });
      await page.route(`**/sessions/${sessionId}/start*`, () => new Promise(() => {}));
      await page.goto(`/projects/${projectId}/sessions/${sessionId}`, { waitUntil: 'domcontentloaded' });
      const card = page.getByTestId('reminder-turn');
      await expect(card).toBeVisible({ timeout: 60_000 });
      await expect(card).toContainText('Reminder');
      await expect(card).toContainText('One-time');
      await expect(card).toContainText('Check whether the vendor replied.');
      await expect(card).not.toContainText('[REMINDER');

      // The live chat's header. A dismissed boot overlay can stay mounted under
      // it (inert, aria-hidden) with its own header and chip.
      const chip = page.getByTestId('session-chat').getByTestId('session-reminders-chip');
      await expect(chip).toBeVisible();
      await expect(chip).toHaveAccessibleName('1 active reminder');
      await chip.click();
      await expect(page.getByText('Post the launch checklist')).toBeVisible();
      await page.getByRole('link', { name: 'Manage reminders' }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/reminders\\?session=${sessionId}`));
      await expect(page.getByTestId('reminder-session-filter')).toContainText('Vendor follow-up');
      await expect(page.getByRole('button', { name: 'Clear session filter' })).toBeVisible();

      expect(pageErrors).toEqual([]);
    } finally {
      if (projectId) await deleteDatabaseProject(env, projectId).catch(() => undefined);
      await deleteAuthUser(user.id, authOptions);
    }
  });
});
