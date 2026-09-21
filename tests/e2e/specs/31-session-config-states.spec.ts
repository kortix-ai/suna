import { expect, test, type Page } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import { createDatabaseSession } from '../../src/fixtures/database-project';
import { seedSessionTranscript } from '../../src/fixtures/session-transcript';
import { createApiJsonClient } from '../helpers/http';
import { createManifestProject, fundAccount } from '../helpers/manifest-project';
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from '../helpers/session-auth';
import { dismissOnboarding, dismissWelcomeCard, selectAccountForUi } from '../helpers/ui';

/**
 * docs/specs/config-releases.md, section "Web": the session header shows one of
 * four config states, derived from `GET /sessions/{id}/config`.
 *
 * The journey route-mocks that response, because a real fallback needs a live
 * sandbox with a broken config release, and the local profile has no sandbox.
 * The derivation itself has unit tests in
 * `apps/web/src/hooks/projects/use-session-config-freshness.test.ts`. This
 * journey proves the browser renders each state from the wire response.
 */

const api = createApiJsonClient(process.env.E2E_API_URL!);
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL!,
  password: 'SessionConfigStates123!',
};

const RUNNING = '0123456789abcdef'.repeat(4);
const DESIRED = 'fedcba9876543210'.repeat(4);
const FALLBACK_REASON = 'replacement OpenCode did not list the default agent within 90 s';

const UPDATE_LABEL = 'Agent config update available';
const SESSION_FILES_LABEL = "Running this session's config";
const FALLBACK_LABEL = 'Config failed to load';

type ConfigBody = Record<string, unknown>;

function configBody(over: ConfigBody): ConfigBody {
  return {
    base_ref: 'main',
    running_etag: 'aaaaaaaaaaaaaaaa',
    latest_etag: 'aaaaaaaaaaaaaaaa',
    commit_sha: 'c'.repeat(40),
    stale: false,
    sandbox_reachable: true,
    ...over,
  };
}

function release(over: ConfigBody): ConfigBody {
  return {
    mode: 'follow-base',
    source: 'release',
    running_release_id: RUNNING,
    desired_release_id: RUNNING,
    proven: true,
    fallback_reason: null,
    failed_release_id: null,
    ...over,
  };
}

const STATES: Array<{
  name: string;
  body: ConfigBody;
  visible: string | null;
}> = [
  {
    name: 'current: nothing renders',
    body: configBody({ stale: false, release: release({}) }),
    visible: null,
  },
  {
    name: 'legacy response without release, not stale: nothing renders',
    body: configBody({ stale: null }),
    visible: null,
  },
  {
    name: 'legacy response without release, stale: the existing badge',
    body: configBody({ stale: true, latest_etag: 'bbbbbbbbbbbbbbbb' }),
    visible: UPDATE_LABEL,
  },
  {
    name: 'update available with a release block: the existing badge',
    body: configBody({ stale: true, release: release({ desired_release_id: DESIRED }) }),
    visible: UPDATE_LABEL,
  },
  {
    name: "session config: the neutral chip",
    body: configBody({
      stale: false,
      release: release({
        mode: 'session-files',
        source: 'workspace',
        running_release_id: null,
        desired_release_id: null,
      }),
    }),
    visible: SESSION_FILES_LABEL,
  },
  {
    name: 'fallback: the error chip',
    body: configBody({
      stale: true,
      release: release({
        desired_release_id: DESIRED,
        failed_release_id: DESIRED,
        fallback_reason: FALLBACK_REASON,
      }),
    }),
    visible: FALLBACK_LABEL,
  },
];

async function expectOnlyVisible(page: Page, visible: string | null) {
  const locators: Record<string, ReturnType<Page['getByRole']> | ReturnType<Page['getByTestId']>> =
    {
      [UPDATE_LABEL]: page.getByRole('button', { name: UPDATE_LABEL, exact: true }),
      [SESSION_FILES_LABEL]: page.getByTestId('session-config-files-chip'),
      [FALLBACK_LABEL]: page.getByTestId('session-config-fallback-chip'),
    };
  for (const [label, locator] of Object.entries(locators)) {
    if (label === visible) await expect(locator).toBeVisible();
    else await expect(locator).toHaveCount(0);
  }
}

test('31 — session header renders every config release state from GET /config', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const env = loadEnv();
  const email = `session-config-states-${Date.now()}@example.test`;
  const user = await createAuthUser(email, authOptions);
  const auth = await signIn(email, authOptions);
  let disposeProject = async () => {};
  let releaseStart = () => {};
  try {
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
      name: 'Session config states',
    });
    disposeProject = project.dispose;
    const projectId = project.id;
    const sessionId = await createDatabaseSession(env, {
      projectId,
      accountId,
      userId: user.id,
    });

    // The session header mounts with the chat. With saved transcript history
    // the chat paints before the sandbox is ready, as in journey 30.
    await seedSessionTranscript(env, { projectId, accountId, sessionId });
    await api(auth.access_token, 'PATCH', `/projects/${projectId}/features`, {
      feature: 'session_transcript_history',
      enabled: true,
    });

    await installBrowserSessionDirect(page, auth, `/projects/${projectId}`, authOptions);
    await selectAccountForUi(page, accountId);
    await dismissOnboarding(page);

    // Hold the sandbox start: the header state does not depend on a sandbox,
    // and the local profile has none to provision.
    const held = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    await page.route(`**/sessions/${sessionId}/start*`, async (route) => {
      await held;
      await route.abort().catch(() => {});
    });

    await page.route(`**/sessions/${sessionId}/snapshot*`, async (route) => {
      await held;
      await route.abort().catch(() => {});
    });

    let current: ConfigBody = STATES[0].body;
    await page.route(`**/projects/${projectId}/sessions/${sessionId}/config`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({ status: 200, json: current });
    });

    const openWith = async (body: ConfigBody) => {
      current = body;
      const response = page.waitForResponse(
        (r) =>
          r.url().endsWith(`/projects/${projectId}/sessions/${sessionId}/config`) &&
          r.request().method() === 'GET',
      );
      await page.goto(`/projects/${projectId}/sessions/${sessionId}`, {
        waitUntil: 'domcontentloaded',
      });
      const answered = await response;
      expect(answered.status()).toBe(200);
      expect(await answered.json()).toEqual(body);
    };

    for (const state of STATES) {
      await test.step(state.name, async () => {
        await openWith(state.body);
        await dismissWelcomeCard(page);
        await expectOnlyVisible(page, state.visible);
      });
    }

    await test.step('the session-files chip carries the exact label', async () => {
      await openWith(STATES[4].body);
      const chip = page.getByTestId('session-config-files-chip');
      await expect(chip).toHaveText(SESSION_FILES_LABEL);
      await expect(chip).toHaveAttribute('aria-label', SESSION_FILES_LABEL);
    });

    await test.step('the fallback chip opens the reason, what runs now, and the failed release', async () => {
      await openWith(STATES[5].body);
      await page.getByTestId('session-config-fallback-chip').click();
      const detail = page.getByTestId('session-config-fallback-detail');
      await expect(detail).toBeVisible();
      await expect(detail.getByText('The new agent config failed to load', { exact: true })).toBeVisible();
      await expect(detail.getByText(FALLBACK_REASON, { exact: true })).toBeVisible();
      await expect(detail.getByText('Last working release', { exact: false })).toBeVisible();
      await expect(detail.getByText(RUNNING.slice(0, 12), { exact: true })).toBeVisible();
      await expect(detail.getByText(DESIRED.slice(0, 12), { exact: true })).toBeVisible();
      await page.screenshot({
        animations: 'disabled',
        path: testInfo.outputPath('fallback-light.png'),
      });
      await page.keyboard.press('Escape');
    });

    await test.step('fallback to the image default names no release', async () => {
      await openWith(
        configBody({
          stale: null,
          release: release({
            source: 'image-default',
            running_release_id: null,
            fallback_reason: 'no config dir on the base branch',
          }),
        }),
      );
      await page.getByTestId('session-config-fallback-chip').click();
      const detail = page.getByTestId('session-config-fallback-detail');
      await expect(detail.getByText('The platform default config', { exact: true })).toBeVisible();
      await expect(detail.getByText('Failed release', { exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');
    });

    await test.step('dark theme and a 720 × 480 window keep both chips inside the header', async () => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.setViewportSize({ width: 720, height: 480 });
      for (const [index, testId] of [
        [4, 'session-config-files-chip'],
        [5, 'session-config-fallback-chip'],
      ] as const) {
        await openWith(STATES[index].body);
        const chip = page.getByTestId(testId);
        await expect(chip).toBeVisible();
        const box = await chip.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(720);
        expect(box!.y + box!.height).toBeLessThanOrEqual(480);
        await expect
          .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
          .toBe(true);
        await page.screenshot({
          animations: 'disabled',
          path: testInfo.outputPath(`${testId}-dark-720x480.png`),
        });
      }
    });
  } finally {
    releaseStart();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await disposeProject().catch(() => {});
    await deleteAuthUser(user.id, authOptions).catch(() => {});
  }
});
