/**
 * The feature's headline promise, as a measurement: what does the user SEE
 * while the computer is coming up?
 *
 * Every arm holds `/start` and `/snapshot` open, so the sandbox can never
 * answer — that is the entire window saved history exists to cover, and
 * holding it makes the measurement deterministic instead of a race against a
 * real wake (measured 5-240s). The saved transcript must paint, from
 * PostgreSQL alone, in every arm:
 *
 *   cold route — the dev server's first compile of the session route;
 *   warm route — what a user with the app already open experiences;
 *   stored off — a project an older server let turn saved history off. The
 *                override it stored changes nothing now.
 *
 * It reports where the time goes, so the read's own cost never hides inside
 * app boot. Run it alone for numbers:
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

const SAVED_REPLY = 'This reply is stored in the database.';

test('98 — saved history is what you see while the computer starts', async ({
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
     * One arm: fresh session, seeded history.
     *
     * `visibleMs` alone would overstate the feature's cost — most of a cold
     * arm is the dev server compiling the route and the app booting, which the
     * transcript does not pay for and a production build does not have. So the
     * read is timed separately: `readMs` is what asking PostgreSQL for the
     * saved transcript actually costs, and `afterReadMs` is what the client
     * spends turning it into pixels.
     */
    const measure = async (): Promise<{
      visibleMs: number | null;
      readMs: number | null;
      afterReadMs: number | null;
    }> => {
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

      // The sandbox must never come up in any arm.
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
          .waitFor({ state: 'visible', timeout: 60_000 });
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
    const cold = await measure();
    const warm = await measure();
    // What an older server stored when a project turned saved history off.
    await runDatabaseSql(
      `UPDATE kortix.projects SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"experimental":{"session_transcript_history":false}}'::jsonb WHERE project_id = $1`,
      [project.id],
      env.databaseUrl,
    );
    const storedOff = await measure();

    const ms = (v: number | null, fallback: string) => (v === null ? fallback : `${v} ms`);
    const missing = 'NOT VISIBLE within 60000ms';
    const report = [
      'time to first VISIBLE saved message, sandbox held down the whole time',
      '',
      `  cold route : ${ms(cold.visibleMs, missing)}`,
      `  warm route : ${ms(warm.visibleMs, missing)}`,
      `  stored off : ${ms(storedOff.visibleMs, missing)}`,
      '',
      'where the warm-route time goes',
      `  saved-history read (request -> response) : ${ms(warm.readMs, 'n/a')}`,
      `  response -> pixels                       : ${ms(warm.afterReadMs, 'n/a')}`,
    ].join('\n');
    await testInfo.attach('benchmark', { body: report, contentType: 'text/plain' });
    if (process.env.BENCH_OUT) writeFileSync(process.env.BENCH_OUT, `${report}\n`);

    expect(cold.visibleMs, 'the cold route must paint the saved transcript').not.toBeNull();
    expect(warm.visibleMs, 'the warm route must paint the saved transcript').not.toBeNull();
    expect(
      storedOff.visibleMs,
      'a stored off override must not hide the saved transcript',
    ).not.toBeNull();
    expect(storedOff.readMs, 'the saved-history read runs despite the override').not.toBeNull();
  } finally {
    release();
    await dispose().catch(() => {});
  }
});
