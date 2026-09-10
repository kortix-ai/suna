import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import { createDatabaseProject, deleteDatabaseProject } from '../../src/fixtures/database-project';
import { createApiJsonClient } from '../helpers/http';
import { createAuthUser, deleteAuthUser, installBrowserSessionDirect, signIn } from '../helpers/session-auth';
import { dismissOnboarding } from '../helpers/ui';

type ReloadWindow = Window & {
  __recordProjectReload: (kind: string, detail: unknown) => Promise<void>;
  __abortProjectRead: () => void;
};

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321',
  password: 'E2eProjectReload123!',
};
const api = createApiJsonClient(apiBase);

// route.abort produces Chromium's TypeError; a real AbortSignal produces
// AbortError, which the SDK deliberately does not retry. Exercise both paths.
for (const cancellation of ['route', 'signal', 'exhaustion'] as const) {
  test(`27 — healthy project reload recovery: ${cancellation}`, async ({ page }, testInfo) => {
    const env = loadEnv();
    const email = `e2e-project-reload-${randomUUID()}@example.test`;
    const user = await createAuthUser(email, authOptions);
    let projectId: string | undefined;
    const events: { ms: number; kind: string; detail: unknown }[] = [];
    const started = Date.now();
    const record = (kind: string, detail: unknown) => {
      events.push({ ms: Date.now() - started, kind, detail });
    };
    try {
      const session = await signIn(email, authOptions);
      const accounts = await api<{ account_id: string }[]>(session.access_token, 'GET', '/accounts');
      const project = await createDatabaseProject(env, {
        accountId: accounts[0].account_id, userId: user.id, name: `Reload Recovery ${Date.now()}`,
      });
      projectId = project.id;
      const projectPath = `/v1/projects/${project.id}`;
      await installBrowserSessionDirect(page, session, `/projects/${project.id}/sessions`, authOptions);
      await dismissOnboarding(page);
      await expect(page.getByRole('heading', { name: 'Sessions', exact: true })).toBeVisible();

      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Page.enable');
      cdp.on('Page.frameRequestedNavigation', (event) => record('navigation-requested', event));

      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) record('navigation', frame.url());
      });
      page.on('requestfailed', (request) => record('requestfailed', {
        url: request.url(), error: request.failure()?.errorText,
      }));
      page.on('response', (response) => {
        if (response.request().method() === 'GET' && new URL(response.url()).pathname === projectPath) {
          record('project-response', response.status());
        }
      });
      await page.exposeFunction('__recordProjectReload', record);
      await page.addInitScript(({ projectPath, cancellation }) => {
        const record = (kind: string, detail: unknown) => {
          void (window as ReloadWindow).__recordProjectReload(kind, detail);
        };
        record('document-start', { url: location.href, timeOrigin: performance.timeOrigin });
        for (const method of ['pushState', 'replaceState'] as const) {
          const original = history[method].bind(history);
          history[method] = (...args) => {
            record(method, { url: args[2], stack: new Error().stack });
            return original(...args);
          };
        }
        addEventListener('beforeunload', () => record('beforeunload', location.href));
        addEventListener('popstate', () => record('popstate', location.href));
        let unavailablePainted = false;
        new MutationObserver(() => {
          if (!unavailablePainted && document.querySelector('h1')?.textContent === "This project didn't load.") {
            unavailablePainted = true;
            record('unavailable-painted', location.href);
          }
        }).observe(document, { childList: true, subtree: true });
        const originalFetch = window.fetch.bind(window);
        let remaining = cancellation === 'exhaustion' ? 4 : 1;
        window.fetch = async (...args) => {
          try {
            if (cancellation !== 'route' && remaining > 0 && new URL(String(args[0]), location.href).pathname === projectPath) {
              remaining -= 1;
              const controller = new AbortController();
              (window as ReloadWindow).__abortProjectRead = () => controller.abort();
              const signal = args[1]?.signal;
              args[1] = { ...args[1], signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal };
            }
            return await originalFetch(...args);
          } catch (error) {
            record('fetch-rejection', {
              url: String(args[0]), name: (error as Error).name, message: (error as Error).message,
            });
            throw error;
          }
        };
      }, { projectPath, cancellation });
      let aborted = 0;
      const abortLimit = cancellation === 'exhaustion' ? 4 : 1;
      await page.route((url) => url.pathname === projectPath, async (route) => {
        if (route.request().method() === 'GET' && aborted < abortLimit) {
          aborted += 1;
          record('injected-abort', route.request().url());
          if (cancellation === 'route') {
            await route.abort('aborted');
          } else {
            // Abort only after Playwright observes the real outgoing GET.
            await page.evaluate(() => (window as ReloadWindow).__abortProjectRead());
            await route.continue();
          }
        } else {
          await route.continue();
        }
      });
      record('reload-start', page.url());
      await page.reload({ waitUntil: 'domcontentloaded' });
      if (cancellation === 'exhaustion') {
        await expect(page.getByText("This project didn't load.", { exact: true })).toBeVisible();
        expect(aborted).toBe(4);
        await page.getByRole('button', { name: 'Try again', exact: true }).click();
      }
      await expect(page.getByRole('heading', { name: 'Sessions', exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("This project didn't load.", { exact: true })).toHaveCount(0);
      expect(aborted).toBe(abortLimit);
      expect(events.some((event) => event.kind === 'project-response' && event.detail === 200)).toBe(true);
      const rejections = events.filter((event) => event.kind === 'fetch-rejection');
      expect(rejections.some((event) => (event.detail as { name: string }).name ===
        (cancellation === 'route' ? 'TypeError' : 'AbortError'))).toBe(true);
      if (cancellation !== 'exhaustion') {
        expect(events.filter((event) => event.kind === 'unavailable-painted')).toEqual([]);
      }
      await testInfo.attach('recovered-project', {
        body: await page.screenshot({ path: testInfo.outputPath('recovered-project.png') }),
        contentType: 'image/png',
      });
    } finally {
      record('final-dom', await page.locator('body').innerText().catch(() => 'page closed'));
      const evidencePath = testInfo.outputPath('reload-events.json');
      await writeFile(evidencePath, JSON.stringify(events, null, 2));
      await testInfo.attach('reload-events', { path: evidencePath, contentType: 'application/json' });
      try {
        if (projectId) await deleteDatabaseProject(env, projectId);
      } finally {
        await deleteAuthUser(user.id, authOptions);
      }
    }
  });
}
