/**
 * Opening a session that has a saved conversation shows that conversation,
 * never the full-screen "Starting your session" screen.
 *
 * The computer takes 5-240 s to wake. The saved copy answers from the control
 * plane in one round trip. So for the length of that round trip the page shows
 * skeleton message rows, and then the conversation. A session with no saved
 * copy still shows the boot screen: there is nothing to read until it wakes.
 *
 * Every arm holds `/start` open, so the computer never comes up, and delays
 * the saved-copy reads (`/snapshot`, `/transcript`) by READ_DELAY_MS, so the
 * wait the user sees on a deployed API is visible here too. A timeline
 * recorder notes the first moment each surface is shown:
 *
 *   skeleton   — `[data-testid="saved-session-skeleton"]`
 *   bootScreen — the boot screen's "Starting your session" heading
 *   reply      — the saved assistant reply
 *
 * It also records every distinct set of skeleton rows it saw. Each session
 * draws its own rows, and the same ones from the route's loading boundary, the
 * server render, and the page: a second set means the rows jumped.
 *
 * Run it alone for numbers:
 *
 *   BENCH_OUT=/tmp/open.txt E2E_GREP='33 — ' pnpm test -- --browser-only
 */
import { writeFileSync } from 'node:fs';
import { type Page, expect, test } from '@playwright/test';
import { loadEnv } from '../../src/core/env';
import { createDatabaseSession } from '../../src/fixtures/database-project';
import { seedSessionTranscript } from '../../src/fixtures/session-transcript';
import { runDatabaseSql } from '../helpers/database';
import { createApiJsonClient } from '../helpers/http';
import { createManifestProject, fundAccount } from '../helpers/manifest-project';
import { createAuthUser, installBrowserSessionDirect, signIn } from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

const api = createApiJsonClient(process.env.E2E_API_URL!);
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL!,
  password: 'SavedSessionOpen123!',
};

/** A deployed API answers a control-plane read in 0.3-2.3 s (measured in
 *  `core/session/open-bundle.ts`). Local answers in milliseconds, which would
 *  hide the wait this journey is about. */
const READ_DELAY_MS = 800;
const SAVED_REPLY = 'This reply is stored in the database.';
const SAVED_PROMPT = 'Show my saved conversation.';
const BOOT_HEADING = 'Starting your session';

interface Timeline {
  skeleton?: number;
  bootScreen?: number;
  reply?: number;
}

/**
 * Record, per document, when each surface is first SHOWN — hit-testable at its
 * center, the way a user can see it. Being in the DOM is not enough: the route
 * paints the chat layer under its overlay (`aria-hidden` + `inert`), and the
 * closed side panel holds a boot checklist with the same heading, clipped to
 * nothing.
 */
async function installTimeline(page: Page) {
  await page.addInitScript(
    ({ reply, heading }) => {
      const state = {
        from: performance.now(),
        marks: {} as Record<string, number>,
        shapes: [] as string[],
      };
      (window as unknown as { __openTimeline: typeof state }).__openTimeline = state;
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
        const skeletons = document.querySelectorAll('[data-testid="saved-session-skeleton"]');
        for (const skeleton of Array.from(skeletons)) {
          if (!shown(skeleton)) continue;
          mark('skeleton');
          const bars = skeleton.querySelectorAll('.animate-pulse');
          const shape = Array.from(bars, (bar) => bar.className).join('|');
          if (!state.shapes.includes(shape)) state.shapes.push(shape);
        }
        for (const h2 of Array.from(document.querySelectorAll('h2'))) {
          if (h2.textContent?.trim() === heading && shown(h2)) mark('bootScreen');
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
      new MutationObserver(scan).observe(document, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['aria-hidden', 'inert'],
      });
    },
    { reply: SAVED_REPLY, heading: BOOT_HEADING },
  );
}

/** Start a fresh timeline for a client-side navigation in the same document. */
async function resetTimeline(page: Page) {
  await page.evaluate(() => {
    const state = (
      window as unknown as { __openTimeline: { from: number; marks: object; shapes: string[] } }
    ).__openTimeline;
    state.from = performance.now();
    state.marks = {};
    state.shapes = [];
  });
}

async function readTimeline(page: Page): Promise<Timeline> {
  return page.evaluate(
    () => (window as unknown as { __openTimeline: { marks: Timeline } }).__openTimeline.marks,
  );
}

/** Every distinct set of skeleton rows shown since the timeline started. */
async function readShapes(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __openTimeline: { shapes: string[] } }).__openTimeline.shapes,
  );
}

test('33 — a session with a saved conversation opens on skeleton rows and then the conversation, never the boot screen', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const env = loadEnv();
  const email = `saved-open-${Date.now()}@example.test`;
  const user = await createAuthUser(email, authOptions);
  const auth = await signIn(email, authOptions);
  let dispose = async () => {};
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
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
      name: 'Saved session open',
    });
    dispose = project.dispose;

    const newSession = async (options: {
      saved: boolean;
      history: boolean;
      /** Hold the saved-copy reads until this settles, instead of READ_DELAY_MS. */
      holdCopy?: Promise<void>;
    }) => {
      const sessionId = await createDatabaseSession(env, {
        projectId: project.id,
        accountId,
        userId: user.id,
      });
      if (options.saved) {
        await seedSessionTranscript(env, { projectId: project.id, accountId, sessionId });
      }
      await runDatabaseSql(
        "UPDATE kortix.project_sessions SET agent_name='kortix' WHERE session_id=$1",
        [sessionId],
        env.databaseUrl ?? undefined,
      );
      await api(auth.access_token, 'PATCH', `/projects/${project.id}/features`, {
        feature: 'session_transcript_history',
        enabled: options.history,
      });
      // The computer never comes up in any arm.
      await page.route(`**/sessions/${sessionId}/start*`, async (route) => {
        await held;
        await route.continue().catch(() => {});
      });
      // The saved copy answers, as slowly as a deployed API does.
      for (const path of ['snapshot', 'transcript']) {
        await page.route(`**/sessions/${sessionId}/${path}*`, async (route) => {
          await (options.holdCopy ?? new Promise((resolve) => setTimeout(resolve, READ_DELAY_MS)));
          await route.continue().catch(() => {});
        });
      }
      return sessionId;
    };

    // The rows are drawn on the server and again on the client; if the two
    // differ, React (a dev build here) reports a hydration error whose diff
    // names the skeleton's components and classes.
    const hydrationErrors: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (
        message.type() === 'error' &&
        /hydrat/i.test(text) &&
        /SavedSessionSkeleton|SkeletonBar|animate-pulse/.test(text)
      ) {
        hydrationErrors.push(text);
      }
    });

    await installTimeline(page);
    await installBrowserSessionDirect(page, auth, `/projects/${project.id}`, authOptions);
    await selectAccountForUi(page, accountId);
    await dismissOnboarding(page);

    // Pay the dev server's first compile of the session route outside the
    // measured arms.
    const warmup = await newSession({ saved: true, history: false });
    await page.goto(`/projects/${project.id}/sessions/${warmup}`, { waitUntil: 'commit' });
    await expect(page.getByText(SAVED_REPLY, { exact: true })).toBeVisible({ timeout: 120_000 });

    const openByUrl = async (sessionId: string) => {
      await page.goto(`/projects/${project.id}/sessions/${sessionId}`, { waitUntil: 'commit' });
    };
    const openFromSidebar = async (sessionId: string) => {
      await page.goto(`/projects/${project.id}`, { waitUntil: 'domcontentloaded' });
      const link = page.locator(`a[href$="/sessions/${sessionId}"]`).first();
      await expect(link).toBeVisible({ timeout: 60_000 });
      await resetTimeline(page);
      await link.click();
    };

    /** A saved session: skeleton first, then the conversation, no boot screen. */
    const savedArm = async (label: string, open: () => Promise<void>) => {
      await open();
      await expect(page.getByText(SAVED_REPLY, { exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(SAVED_PROMPT, { exact: true })).toBeVisible();
      await expect(page.getByTestId('saved-session-skeleton')).toHaveCount(0);
      const marks = await readTimeline(page);
      // Soft, so every arm runs and the report below is attached either way.
      expect.soft(marks.bootScreen, `${label}: the boot screen must not appear`).toBeUndefined();
      expect.soft(marks.skeleton, `${label}: skeleton rows must cover the wait`).toBeDefined();
      expect
        .soft(
          marks.skeleton ?? Number.POSITIVE_INFINITY,
          `${label}: skeleton before the conversation`,
        )
        .toBeLessThan(marks.reply ?? Number.NEGATIVE_INFINITY);
      expect
        .soft(await readShapes(page), `${label}: the skeleton rows never change while shown`)
        .toHaveLength(1);
      return { label, ...marks };
    };

    const results: Array<Timeline & { label: string }> = [];

    const offByUrl = await newSession({ saved: true, history: false });
    results.push(await savedArm('saved copy, flag off, open by URL', () => openByUrl(offByUrl)));

    const onByUrl = await newSession({ saved: true, history: true });
    results.push(await savedArm('saved copy, flag on, open by URL', () => openByUrl(onByUrl)));

    const offBySidebar = await newSession({ saved: true, history: false });
    results.push(
      await savedArm('saved copy, flag off, open from sidebar', () =>
        openFromSidebar(offBySidebar),
      ),
    );

    // No saved copy: nothing can be read until the computer wakes, so the boot
    // screen is still the honest answer.
    const unsaved = await newSession({ saved: false, history: false });
    await openByUrl(unsaved);
    await expect(page.getByRole('heading', { name: BOOT_HEADING })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByTestId('saved-session-skeleton')).toHaveCount(0);
    const unsavedMarks = await readTimeline(page);
    expect(unsavedMarks.reply, 'no saved copy: no conversation to paint').toBeUndefined();
    results.push({ label: 'no saved copy, flag off, open by URL', ...unsavedMarks });

    const ms = (value: number | undefined) =>
      value === undefined ? 'never' : `${Math.round(value)} ms`;
    const report = [
      `first shown after navigation (saved-copy reads delayed ${READ_DELAY_MS} ms, computer held down)`,
      '',
      ...results.map(
        (r) =>
          `  ${r.label.padEnd(40)} skeleton ${ms(r.skeleton).padStart(8)}  boot screen ${ms(r.bootScreen).padStart(8)}  conversation ${ms(r.reply).padStart(8)}`,
      ),
    ].join('\n');
    await testInfo.attach('timeline', { body: report, contentType: 'text/plain' });
    if (process.env.BENCH_OUT) writeFileSync(process.env.BENCH_OUT, `${report}\n`);

    // Evidence for review: the skeleton while the saved copy is held, then the
    // conversation, in both themes and at the smallest supported window.
    const views = [
      { scheme: 'light', width: 1280, height: 800 },
      { scheme: 'dark', width: 1280, height: 800 },
      { scheme: 'light', width: 720, height: 480 },
    ] as const;
    const rowSets: string[] = [];
    for (const [index, view] of views.entries()) {
      let releaseCopy = () => {};
      const copy = new Promise<void>((resolve) => {
        releaseCopy = resolve;
      });
      const sessionId = await newSession({ saved: true, history: false, holdCopy: copy });
      await page.setViewportSize({ width: view.width, height: view.height });
      await page.emulateMedia({ colorScheme: view.scheme });
      await openByUrl(sessionId);
      await expect(page.getByTestId('saved-session-skeleton')).toBeVisible({ timeout: 60_000 });
      const name = `${view.scheme}-${view.width}x${view.height}`;
      const bars = page.getByTestId('saved-session-skeleton').locator('.animate-pulse');
      rowSets.push(await bars.evaluateAll((els) => els.map((el) => el.className).join('|')));
      // One pulse travels down the rows, so at any instant they sit at
      // different points of it. Rows pulsing in step would share one opacity.
      const opacities = await bars.evaluateAll((els) =>
        els.map((el) => getComputedStyle(el).opacity),
      );
      expect
        .soft(new Set(opacities).size, `${name}: the rows pulse out of step`)
        .toBeGreaterThan(2);
      if (index === 0) {
        // Frames of the wave, for review.
        for (let frame = 0; frame < 4; frame++) {
          await page.screenshot({ path: testInfo.outputPath(`skeleton-wave-${frame}.png`) });
          await page.waitForTimeout(250);
        }
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const still = await bars.evaluateAll((els) =>
          els.map((el) => `${getComputedStyle(el).animationName}:${getComputedStyle(el).opacity}`),
        );
        expect
          .soft(new Set(still), 'reduced motion: every row holds still')
          .toEqual(new Set(['none:1']));
        await page.emulateMedia({ reducedMotion: 'no-preference' });
      }
      await page.screenshot({
        path: testInfo.outputPath(`skeleton-${name}.png`),
        animations: 'disabled',
      });
      releaseCopy();
      await expect(page.getByText(SAVED_REPLY, { exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('saved-session-skeleton')).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath(`conversation-${name}.png`),
        animations: 'disabled',
      });
      const marks = await readTimeline(page);
      expect.soft(marks.bootScreen, `${name}: the boot screen must not appear`).toBeUndefined();
    }
    expect.soft(new Set(rowSets).size, 'each session draws its own rows').toBe(views.length);
    expect(hydrationErrors, 'the server and the client draw the same rows').toEqual([]);
  } finally {
    release();
    await dispose().catch(() => {});
  }
});
