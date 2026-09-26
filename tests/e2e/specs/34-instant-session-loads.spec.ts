/**
 * What a user already saw renders again without waiting on the backend.
 *
 * A reload used to start every surface from nothing: the project gate showed
 * the Kortix mark, the sidebar showed skeleton rows, and the session showed
 * skeleton rows or the boot screen, each until its read answered. On a slow
 * backend that was the whole wait. Now the device keeps the last answers per
 * user: the query cache (project, session list) and the last saved copy of the
 * conversation. They render in the first frame, and the reads reconcile in
 * place.
 *
 * The first arm opens a session once, then HOLDS every read the page makes on
 * a reload — the project, the session list, the session-open snapshot, the
 * saved copy and `/start` — and reloads. The project shell, the session's row
 * in the sidebar and the conversation must all show while nothing answers.
 *
 * The second arm opens a stopped session that has no computer. It used to be a
 * full-screen "This session is stopped" card over a conversation the user
 * could read; now the conversation shows, under a banner that says the same
 * thing and offers the same Restart.
 */
import { type Page, expect, test } from '@playwright/test';
import { loadEnv } from '../../src/core/env';
import { createDatabaseSession } from '../../src/fixtures/database-project';
import { seedSessionTranscript } from '../../src/fixtures/session-transcript';
import { runDatabaseSql } from '../helpers/database';
import { createApiJsonClient } from '../helpers/http';
import { createManifestProject, fundAccount } from '../helpers/manifest-project';
import { createAuthUser, installBrowserSessionDirect, signIn } from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

// Always recorded: the video of the held-network reload is the PR's demo.
test.use({ video: 'on' });

const api = createApiJsonClient(process.env.E2E_API_URL!);
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL!,
  password: 'InstantSessionLoads123!',
};

const SAVED_REPLY = 'This reply is stored in the database.';
const SAVED_PROMPT = 'Show my saved conversation.';
const BOOT_HEADING = 'Starting your session';

/** The API's path prefix (`/v1`), so a held route never matches the page's own URL. */
const API_PATH = new URL(process.env.E2E_API_URL!).pathname.replace(/\/+$/, '');

/** First moment each surface is PAINTED after the reload: hit-testable at its center. */
async function installFirstShown(page: Page, sessionId: string) {
  await page.addInitScript(
    ({ reply, heading, sessionHref }) => {
      const state = { from: performance.now(), marks: {} as Record<string, number> };
      (window as unknown as { __firstShown: typeof state }).__firstShown = state;
      const mark = (key: string) => {
        if (!(key in state.marks)) state.marks[key] = performance.now() - state.from;
      };
      const shown = (el: Element) => {
        if (el.closest('[aria-hidden="true"], [inert]')) return false;
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return false;
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
        const hit = document.elementFromPoint(x, y);
        return !!hit && (hit === el || el.contains(hit));
      };
      const scan = () => {
        for (const el of Array.from(document.querySelectorAll('[data-testid="saved-session-skeleton"]'))) {
          if (shown(el)) mark('skeleton');
        }
        for (const h2 of Array.from(document.querySelectorAll('h2'))) {
          if (h2.textContent?.trim() === heading && shown(h2)) mark('bootScreen');
        }
        for (const link of Array.from(document.querySelectorAll(`a[href$="${sessionHref}"]`))) {
          if (shown(link)) mark('sidebarRow');
        }
        const replies = document.evaluate(
          `//*[text()[contains(., "${reply}")]]`,
          document,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null,
        );
        for (let i = 0; i < replies.snapshotLength; i++) {
          const node = replies.snapshotItem(i);
          if (node instanceof Element && shown(node)) mark('reply');
        }
      };
      // Sampled once per frame, not on every mutation: a placeholder that a
      // layout effect replaces inside the same task is never painted, and a
      // mutation observer would still count it.
      const frame = () => {
        scan();
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    },
    { reply: SAVED_REPLY, heading: BOOT_HEADING, sessionHref: `/sessions/${sessionId}` },
  );
}

async function firstShown(page: Page): Promise<Record<string, number>> {
  return page.evaluate(
    () => (window as unknown as { __firstShown: { marks: Record<string, number> } }).__firstShown.marks,
  );
}

async function setup(page: Page, label: string) {
  const env = loadEnv();
  const email = `instant-${label}-${Date.now()}@example.test`;
  const user = await createAuthUser(email, authOptions);
  const auth = await signIn(email, authOptions);
  const accounts = await api<Array<{ account_id: string; personal_account?: boolean }>>(
    auth.access_token,
    'GET',
    '/accounts',
  );
  const accountId = (accounts.find((a) => a.personal_account) ?? accounts[0]).account_id;
  await fundAccount(env.databaseUrl!, accountId);
  const project = await createManifestProject({
    api,
    accessToken: auth.access_token,
    databaseUrl: env.databaseUrl!,
    accountId,
    userId: user.id,
    name: `Instant loads ${label}`,
  });
  const sessionId = await createDatabaseSession(env, {
    projectId: project.id,
    accountId,
    userId: user.id,
  });
  await seedSessionTranscript(env, { projectId: project.id, accountId, sessionId });
  await runDatabaseSql(
    "UPDATE kortix.project_sessions SET agent_name='kortix' WHERE session_id=$1",
    [sessionId],
    env.databaseUrl ?? undefined,
  );
  await installBrowserSessionDirect(page, auth, `/projects/${project.id}`, authOptions);
  await selectAccountForUi(page, accountId);
  await dismissOnboarding(page);
  return { user, project, sessionId, root: `ses_${sessionId.replaceAll('-', '')}` };
}

test('34 — a reload with every read held shows the project, its session list and the conversation', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const { user, project, sessionId } = await setup(page, 'reload');
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = false;
  const hold = async (route: Parameters<Parameters<Page['route']>[1]>[0]) => {
    if (holding) await held;
    await route.continue().catch(() => {});
  };
  try {
    // The computer never comes up: the conversation can only come from a saved copy.
    await page.route(`**/sessions/${sessionId}/start*`, async (route) => {
      await held;
      await route.continue().catch(() => {});
    });
    // Once `holding`, every read the reload depends on waits for the end of the test.
    for (const path of ['snapshot', 'transcript']) {
      await page.route(`**/sessions/${sessionId}/${path}*`, hold);
    }
    await page.route(
      (url) =>
        url.pathname === `${API_PATH}/projects/${project.id}` ||
        url.pathname === `${API_PATH}/projects/${project.id}/sessions`,
      hold,
    );

    // First open, with nothing held: the device keeps what it was shown.
    await page.goto(`/projects/${project.id}/sessions/${sessionId}`, { waitUntil: 'commit' });
    await expect(page.getByText(SAVED_REPLY, { exact: true })).toBeVisible({ timeout: 120_000 });
    await expect(page.locator(`a[href$="/sessions/${sessionId}"]`).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ userId, projectId, session }) => {
              const keys = Object.keys(localStorage);
              return {
                savedCopy: keys.includes(`kortix.saved-copy:${userId}:${projectId}/${session}`),
                queryCache: keys.includes(`kortix.query-cache:${userId}`),
              };
            },
            { userId: user.id, projectId: project.id, session: sessionId },
          ),
        { timeout: 30_000, message: 'the device keeps the saved copy and the query cache' },
      )
      .toEqual({ savedCopy: true, queryCache: true });

    // Reload with every read held.
    holding = true;
    await installFirstShown(page, sessionId);
    await page.reload({ waitUntil: 'commit' });

    await expect(page.getByText(SAVED_REPLY, { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(SAVED_PROMPT, { exact: true })).toBeVisible();
    await expect(page.locator(`a[href$="/sessions/${sessionId}"]`).first()).toBeVisible();
    const marks = await firstShown(page);
    await testInfo.attach('first shown after reload (every read held)', {
      body: JSON.stringify(marks, null, 2),
      contentType: 'application/json',
    });
    expect(marks.bootScreen, 'the boot screen must not appear').toBeUndefined();
    expect(marks.skeleton, 'no placeholder rows: the kept copy paints at once').toBeUndefined();
    // One story about the computer: the page's own start is waking it, so the
    // composer says so too, never "idle — your next message wakes it".
    await expect(page.getByText("Waking this session's computer.", { exact: false })).toBeVisible();
    await expect(page.getByText('This session is idle', { exact: false })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('reload-held.png') });
  } finally {
    release();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await project?.dispose?.();
  }
});

test('34 — a stopped session with no computer shows its conversation under a banner, not a card', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const { project, sessionId, root } = await setup(page, 'dormant');
  try {
    // A session whose computer was released: `/start` answers stopped, no
    // sandbox row, not retriable — the state that painted a full-screen card.
    await page.route(`**/sessions/${sessionId}/start*`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fulfill({
        status: 200,
        json: {
          stage: 'stopped',
          agent_name: 'kortix',
          retriable: false,
          sandbox: null,
          opencode_session_id: root,
          failure: null,
        },
      });
    });

    await page.goto(`/projects/${project.id}/sessions/${sessionId}`, { waitUntil: 'commit' });

    await expect(page.getByText(SAVED_REPLY, { exact: true })).toBeVisible({ timeout: 120_000 });
    const banner = page.locator('[data-session-notice-banner]');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('This session is stopped');
    await expect(banner.getByRole('button', { name: /restart/i })).toBeVisible();
    // Nothing can be sent until the Restart: no composer promises otherwise.
    await expect(page.getByText('This session is idle', { exact: false })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Message input' })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('stopped-banner.png') });
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await project?.dispose?.();
  }
});
