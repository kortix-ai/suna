/**
 * The feature's headline promise, as a measurement: what does the user SEE
 * while the computer is coming up?
 *
 * Every arm holds `/start` and `/snapshot` open, so the sandbox can never
 * answer — that is the entire window `session_transcript_history` exists to
 * cover, and holding it makes the comparison deterministic instead of a race
 * against a real wake (measured 5-240s).
 *
 *   flag ON  — the saved transcript must paint, from PostgreSQL alone.
 *   flag OFF — nothing can paint, and no saved-history read is even issued.
 *
 * Journey 30 asserts the ON arm renders. This one pins the CONTRAST, which is
 * the claim the feature is sold on, and reports where the time goes so the
 * read's own cost never hides inside app boot. Run it alone for numbers:
 *
 *   BENCH_OUT=/tmp/bench.txt E2E_GREP='98 — ' pnpm test -- --browser-only
 */
import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { loadEnv } from '../../src/core/env';
import { createDatabaseSession } from '../../src/fixtures/database-project';
import { seedSessionTranscript } from '../../src/fixtures/session-transcript';
import { runDatabaseSql } from '../helpers/database';
import { createApiJsonClient } from '../helpers/http';
import { createManifestProject, fundAccount } from '../helpers/manifest-project';
import {
  createAuthUser,
  installBrowserSessionDirect,
  signIn,
} from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

const api = createApiJsonClient(process.env.E2E_API_URL!);
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL!,
  password: 'TranscriptHistory123!',
};

/**
 * How long the OFF arm waits before declaring "nothing visible".
 *
 * A slow machine makes this assertion MORE likely to hold, never less — the
 * claim is an absence — so this is sized for suite cost, not for headroom.
 */
const BLIND_WINDOW_MS = 8_000;
const SAVED_REPLY = 'This reply is stored in the database.';

test('98 — saved history is what you see while the computer starts (flag ON vs OFF)', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const env = loadEnv();
  const email = `history-bench-${Date.now()}@example.test`;
  const user = await createAuthUser(email, authOptions);
  const auth = await signIn(email, authOptions);
  let dispose = async () => {};
  let release = () => {};
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
      name: 'Transcript history benchmark',
    });
    dispose = project.dispose;

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    /**
     * One arm: fresh session, seeded history, flag as given.
     *
     * `visibleMs` alone would overstate the feature's cost — most of a cold
     * arm is the dev server compiling the route and the app booting, which the
     * transcript does not pay for and a production build does not have. So the
     * read is timed separately: `readMs` is what asking PostgreSQL for the
     * saved transcript actually costs, and `afterReadMs` is what the client
     * spends turning it into pixels.
     */
    const measure = async (
      enabled: boolean,
    ): Promise<{ visibleMs: number | null; readMs: number | null; afterReadMs: number | null }> => {
      const sessionId = await createDatabaseSession(env, {
        projectId: project.id,
        accountId,
        userId: user.id,
      });
      await seedSessionTranscript(env, { projectId: project.id, accountId, sessionId });
      await runDatabaseSql(
        "UPDATE kortix.project_sessions SET agent_name='kortix' WHERE session_id=$1",
        [sessionId],
        env.databaseUrl,
      );
      await api(auth.access_token, 'PATCH', `/projects/${project.id}/features`, {
        feature: 'session_transcript_history',
        enabled,
      });

      // The sandbox must never come up in either arm.
      await page.route(`**/sessions/${sessionId}/start*`, async (route) => {
        await held;
        await route.continue().catch(() => {});
      });
      await page.route(`**/sessions/${sessionId}/snapshot*`, async (route) => {
        await held;
        await route.continue().catch(() => {});
      });

      // Time the saved-history read itself: request issued -> response in hand.
      let readMs: number | null = null;
      let readDoneAt: number | null = null;
      const issuedAt = new Map<string, number>();
      const onRequest = (r: { url: () => string }) => {
        const url = r.url();
        if (url.includes(`/sessions/${sessionId}/transcript?`) && url.includes('history=true'))
          issuedAt.set(url, Date.now());
      };
      const onResponse = (r: { url: () => string }) => {
        const url = r.url();
        const began = issuedAt.get(url);
        if (began === undefined || readMs !== null) return;
        readDoneAt = Date.now();
        readMs = readDoneAt - began;
      };
      page.on('request', onRequest);
      page.on('response', onResponse);

      const startedAt = Date.now();
      await page.goto(`/projects/${project.id}/sessions/${sessionId}`, {
        waitUntil: 'commit',
      });
      try {
        await page
          .getByText(SAVED_REPLY, { exact: true })
          .waitFor({ state: 'visible', timeout: enabled ? 60_000 : BLIND_WINDOW_MS });
        const visibleAt = Date.now();
        return {
          visibleMs: visibleAt - startedAt,
          readMs,
          afterReadMs: readDoneAt === null ? null : visibleAt - readDoneAt,
        };
      } catch {
        return { visibleMs: null, readMs, afterReadMs: null };
      } finally {
        page.off('request', onRequest);
        page.off('response', onResponse);
      }
    };

    await installBrowserSessionDirect(page, auth, `/projects/${project.id}`, authOptions);
    await selectAccountForUi(page, accountId);
    await dismissOnboarding(page);

    // Cold arm pays the dev server's first compile of the session route; the
    // warm arm is what a user with the app already open actually experiences.
    const onCold = await measure(true);
    const onWarm = await measure(true);
    const off = await measure(false);

    const ms = (v: number | null, fallback: string) => (v === null ? fallback : `${v} ms`);
    const report = [
      'time to first VISIBLE saved message, sandbox held down the whole time',
      '',
      `  flag ON, cold route : ${ms(onCold.visibleMs, 'NOT VISIBLE within 60000ms')}`,
      `  flag ON, warm route : ${ms(onWarm.visibleMs, 'NOT VISIBLE within 60000ms')}`,
      `  flag OFF            : ${ms(off.visibleMs, `NOT VISIBLE within ${BLIND_WINDOW_MS}ms`)}`,
      '',
      'where the warm-route time goes',
      `  saved-history read (request -> response) : ${ms(onWarm.readMs, 'n/a')}`,
      `  response -> pixels                       : ${ms(onWarm.afterReadMs, 'n/a')}`,
      '',
      'flag OFF has no saved-history read at all:',
      `  read observed : ${off.readMs === null ? 'none (route is 403-gated when off)' : `${off.readMs} ms`}`,
    ].join('\n');
    await testInfo.attach('benchmark', { body: report, contentType: 'text/plain' });
    if (process.env.BENCH_OUT) writeFileSync(process.env.BENCH_OUT, `${report}\n`);

    expect(onCold.visibleMs, 'flag ON must paint the saved transcript').not.toBeNull();
    expect(onWarm.visibleMs, 'flag ON must paint the saved transcript').not.toBeNull();
    expect(off.visibleMs, 'flag OFF must show nothing while the sandbox is down').toBeNull();
  } finally {
    release();
    await dispose().catch(() => {});
  }
});
