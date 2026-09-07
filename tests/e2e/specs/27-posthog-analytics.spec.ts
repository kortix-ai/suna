/**
 * 27 — PostHog product analytics, end to end against a REAL sandbox and the
 * REAL PostHog Cloud project.
 *
 * Quarantined + env-gated: it provisions a cloud sandbox (minutes) and reads
 * back from PostHog's API, so it never runs in the deterministic local
 * profile. Run it by hand against a running dev stack:
 *
 *   E2E_ENABLE_POSTHOG_SMOKE=1 E2E_INCLUDE_TAGS=@quarantine \
 *   E2E_BASE_URL=http://localhost:13500 E2E_API_URL=http://localhost:13508/v1 \
 *   POSTHOG_HOST=https://us.posthog.com POSTHOG_PROJECT_ID=595562 POSTHOG_API_KEY=phx_… \
 *   npx playwright test --config tests/playwright.config.ts 27-posthog
 *
 * What it proves:
 *  1. The browser sends `$pageview`, `$identify` (distinct_id = Supabase user
 *     id, no email) and `$groupidentify` (account, project) through the
 *     `/ingest` reverse proxy and PostHog answers 200.
 *  2. A real user journey (project → session → prompt → answer → stop →
 *     secret) produces the server-side lifecycle events in PostHog, keyed by
 *     the same distinct_id, with the documented properties.
 */
import { expect, test, type Request } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createApiJsonClient } from '../helpers/http';
import {
  type AuthSession,
  type AuthUser,
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

const enabled = process.env.E2E_ENABLE_POSTHOG_SMOKE === '1';
const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const databaseUrl =
  process.env.E2E_DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const password = 'PosthogSmoke123!';
const api = createApiJsonClient(apiBase);
const authOptions = { supabaseUrl, password };

const posthogHost = process.env.POSTHOG_HOST || '';
const posthogProjectId = process.env.POSTHOG_PROJECT_ID || '';
const posthogApiKey = process.env.POSTHOG_API_KEY || '';
const posthogReadable = Boolean(posthogHost && posthogProjectId && posthogApiKey);

/** Events emitted from server-internal paths (turn ledger, sandbox state sync): no request, so no `source`. */
const NO_REQUEST_CONTEXT = new Set(['turn_completed', 'session_stopped']);

/** Server-side events the journey below must produce, with the properties each must carry. */
const EXPECTED_SERVER_EVENTS: Record<string, string[]> = {
  project_created: ['source'],
  session_started: ['provider'],
  prompt_sent: ['source', 'model'],
  turn_completed: ['status'],
  session_stopped: ['reason'],
  secret_created: ['name_kind'],
  provider_configured: ['provider', 'method'],
};

test.use({
  launchOptions: { args: ['--disable-gpu', '--disable-webgl', '--disable-webgl2'] },
  // posthog-js drops every event from a "likely bot" (HeadlessChrome UA or
  // navigator.webdriver), so the browser must look like a real Chrome.
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
});

/** Second half of the bot spoof — must be registered before the first navigation. */
async function hideAutomation(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'userAgentData', {
      get: () => ({
        brands: [
          { brand: 'Chromium', version: '140' },
          { brand: 'Google Chrome', version: '140' },
        ],
        mobile: false,
        platform: 'macOS',
      }),
    });
  });
}

function executeSql(sql: string): string {
  return execFileSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], {
    encoding: 'utf8',
  }).trim();
}

function fundAccount(accountId: string): void {
  executeSql(
    `INSERT INTO kortix.credit_accounts (
       account_id, balance, balance_precise, non_expiring_credits, non_expiring_credits_precise, tier
     ) VALUES ('${accountId}', 1000, 1000, 1000, 1000, 'tier_2_20')
     ON CONFLICT (account_id) DO UPDATE SET
       balance = 1000, balance_precise = 1000,
       non_expiring_credits = 1000, non_expiring_credits_precise = 1000, tier = 'tier_2_20'`,
  );
}

interface PosthogClientEvent {
  event: string;
  distinct_id?: string;
  properties?: Record<string, unknown>;
}

/** Decode one posthog-js capture request body (gzip-js, JSON, or form+base64). */
function decodeCaptureBody(request: Request): PosthogClientEvent[] {
  const raw = request.postDataBuffer();
  if (!raw) return [];
  const url = new URL(request.url());
  let text: string;
  try {
    text =
      url.searchParams.get('compression') === 'gzip-js'
        ? gunzipSync(raw).toString('utf8')
        : raw.toString('utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const form = new URLSearchParams(text);
    const data = form.get('data');
    if (!data) return [];
    try {
      parsed = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
    } catch {
      return [];
    }
  }
  if (Array.isArray(parsed)) return parsed as PosthogClientEvent[];
  if (parsed && typeof parsed === 'object') {
    const batch = (parsed as { batch?: PosthogClientEvent[] }).batch;
    if (Array.isArray(batch)) return batch;
    return [parsed as PosthogClientEvent];
  }
  return [];
}

async function waitForReadySession(token: string, projectId: string, sessionId: string): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  let last = '';
  while (Date.now() < deadline) {
    const result = await api<{ stage: string; sandbox?: { status?: string; external_id?: string | null } | null }>(
      token,
      'POST',
      `/projects/${projectId}/sessions/${sessionId}/start?wait_ms=8000`,
      {},
    );
    last = `${result.stage}:${result.sandbox?.status ?? 'none'}`;
    if (result.stage === 'ready' && result.sandbox?.status === 'active' && result.sandbox.external_id) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`session did not become ready: ${last}`);
}

interface PosthogServerEvent {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

/** Read the user's events back from PostHog (needs a personal API key with query:read). */
async function readServerEvents(distinctId: string): Promise<PosthogServerEvent[]> {
  const response = await fetch(`${posthogHost}/api/projects/${posthogProjectId}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${posthogApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // The query endpoint caches results; a poll must bypass the cache.
      refresh: 'force_blocking',
      query: {
        kind: 'HogQLQuery',
        query: `SELECT event, distinct_id, properties, timestamp FROM events WHERE distinct_id = '${distinctId}' ORDER BY timestamp ASC LIMIT 500`,
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`PostHog query failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { results: unknown[][] };
  return body.results.map((row) => ({
    event: String(row[0]),
    distinct_id: String(row[1]),
    properties: typeof row[2] === 'string' ? (JSON.parse(row[2]) as Record<string, unknown>) : ((row[2] as Record<string, unknown>) ?? {}),
    timestamp: String(row[3]),
  }));
}

test.describe.serial('27 — PostHog product analytics', { tag: '@quarantine' }, () => {
  test.skip(!enabled, 'Set E2E_ENABLE_POSTHOG_SMOKE=1 for the real sandbox + PostHog flow.');
  test.setTimeout(15 * 60_000);

  let user: AuthUser;
  let auth: AuthSession;
  let accountId = '';
  let projectId = '';
  let sessionId = '';

  test.beforeAll(async () => {
    test.setTimeout(12 * 60_000);
    const email = `posthog-smoke-${Date.now()}-${randomUUID().slice(0, 8)}@example.test`;
    user = await createAuthUser(email, authOptions);
    auth = await signIn(email, authOptions);
    // The personal account is bootstrapped on the first authenticated call (this also emits user_signed_up).
    const accounts = await api<{ account_id: string; personal_account?: boolean }[]>(auth.access_token, 'GET', '/accounts');
    accountId = (accounts.find((item) => item.personal_account) ?? accounts[0]).account_id;
    fundAccount(accountId);

    const project = await api<{ project_id: string }>(
      auth.access_token,
      'POST',
      '/projects/provision',
      { account_id: accountId, name: `PostHog smoke ${Date.now()}`, seed_starter: true },
      201,
    );
    projectId = project.project_id;
    await api(auth.access_token, 'PATCH', `/projects/${projectId}/onboarding`, { completed: true });

    const session = await api<{ session_id: string }>(
      auth.access_token,
      'POST',
      `/projects/${projectId}/sessions`,
      { name: 'PostHog smoke session' },
      201,
    );
    sessionId = session.session_id;
    await waitForReadySession(auth.access_token, projectId, sessionId);
  });

  test.afterAll(async () => {
    if (projectId && sessionId) {
      await api(auth.access_token, 'DELETE', `/projects/${projectId}/sessions/${sessionId}`).catch(() => {});
    }
    if (projectId) await api(auth.access_token, 'DELETE', `/projects/${projectId}`).catch(() => {});
    if (accountId) {
      try {
        executeSql(`DELETE FROM kortix.accounts WHERE account_id = '${accountId}'`);
      } catch {
        // best effort
      }
    }
    if (user?.id) await deleteAuthUser(user.id, { supabaseUrl });
  });

  test('browser capture goes through /ingest with id-only identify and groups; the journey lands server-side events in PostHog', async ({ page }) => {
    await hideAutomation(page);
    const captured: PosthogClientEvent[] = [];
    const ingestStatuses: number[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (request.method() === 'POST' && url.pathname.startsWith('/ingest/') && !url.pathname.startsWith('/ingest/flags')) {
        captured.push(...decodeCaptureBody(request));
      }
    });
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (response.request().method() === 'POST' && url.pathname.startsWith('/ingest/') && !url.pathname.startsWith('/ingest/flags')) {
        ingestStatuses.push(response.status());
      }
    });

    // 1. Project home: pageview + identify + account group.
    await installBrowserSessionDirect(page, auth, `/projects/${projectId}`, authOptions);
    await expect(page).toHaveURL(`/projects/${projectId}`);
    await dismissOnboarding(page);
    await expect
      .poll(() => captured.some((e) => e.event === '$pageview'), { timeout: 30_000, message: 'no $pageview sent through /ingest' })
      .toBe(true);
    await expect
      .poll(() => captured.some((e) => e.event === '$identify'), { timeout: 30_000, message: 'no $identify sent' })
      .toBe(true);
    const identify = captured.find((e) => e.event === '$identify')!;
    expect(identify.distinct_id ?? identify.properties?.distinct_id).toBe(user.id);
    const identifySet = (identify.properties?.$set ?? {}) as Record<string, unknown>;
    expect(JSON.stringify(identifySet)).not.toContain('@'); // no email in person properties

    // The `account` group reads the persisted current-account store. The first
    // sign-in on a fresh browser runs resetClientState(), which clears it, so a
    // normal visit sets it afterwards (dashboard, account switcher, project
    // start). Mirror that like 08-accounts-project-access does: select, reload.
    await selectAccountForUi(page, accountId);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await dismissOnboarding(page);
    // posthog.group() registers $groups on every later event; the one-off
    // $groupidentify may leave via sendBeacon during the reload and never
    // reach page.on('request'), so assert the association, not the beacon.
    const groupOf = (e: PosthogClientEvent, type: string) =>
      ((e.properties?.$groups ?? {}) as Record<string, string>)[type];
    await expect
      .poll(() => captured.some((e) => groupOf(e, 'account') === accountId), {
        timeout: 30_000,
        message: 'no browser event carried $groups.account',
      })
      .toBe(true);

    // 2. Session page: project group + a real prompt/answer round trip.
    await page.goto(`/projects/${projectId}/sessions/${sessionId}`, { waitUntil: 'domcontentloaded' });
    await dismissOnboarding(page);
    // A cold dev-server compile can fail the first project fetch; the app offers one retry.
    const tryAgain = page.getByRole('button', { name: 'Try again' });
    if (await tryAgain.isVisible({ timeout: 5_000 }).catch(() => false)) await tryAgain.click();
    await expect(page.getByTestId('session-chat')).toBeVisible({ timeout: 120_000 });
    const welcomeCard = page.getByRole('complementary', { name: /Welcome from Marko/i });
    if (await welcomeCard.isVisible().catch(() => false)) {
      await welcomeCard.getByRole('button', { name: 'Dismiss' }).click({ force: true });
    }
    const input = page.getByRole('textbox', { name: 'Message input' });
    await expect(input).toBeVisible({ timeout: 60_000 });
    await input.fill('Reply with exactly one word: PONG');
    await page.getByRole('button', { name: 'Send message' }).click({ force: true });
    await expect(page.getByText('PONG', { exact: true }).last()).toBeVisible({ timeout: 4 * 60_000 });
    await expect
      .poll(() => captured.some((e) => groupOf(e, 'project') === projectId), {
        timeout: 30_000,
        message: 'no browser event carried $groups.project',
      })
      .toBe(true);

    // 3. Server-side lifecycle through the API: stop, secret (a provider key).
    // The answer renders from the OpenCode stream before the daemon reports the
    // turn end to the API; stopping first would pause the box and lose
    // turn_completed. Wait for the server-side turn ledger to drain.
    await expect
      .poll(
        async () => {
          const state = await api<{ turns: unknown[]; last_ended?: unknown }>(
            auth.access_token,
            'GET',
            `/projects/${projectId}/sessions/${sessionId}/turn`,
          );
          return state.turns.length;
        },
        { timeout: 90_000, intervals: [2_000], message: 'turn never ended server-side' },
      )
      .toBe(0);
    await api(auth.access_token, 'POST', `/projects/${projectId}/sessions/${sessionId}/stop`, {}, [200, 202]);
    await api(
      auth.access_token,
      'POST',
      `/projects/${projectId}/secrets`,
      { name: 'OPENAI_API_KEY', value: 'sk-posthog-smoke-not-a-real-key' },
      [200, 201],
    );

    // Every /ingest capture was accepted by PostHog.
    expect(ingestStatuses.length).toBeGreaterThan(0);
    expect(ingestStatuses.every((status) => status === 200)).toBe(true);

    // Session replay never runs here: every page this test opened is under
    // /projects/, which lib/analytics/posthog-replay.ts blocks.
    expect(captured.filter((event) => event.event === '$snapshot')).toEqual([]);

    // 4. Read back from PostHog: ingestion is asynchronous, allow up to 3 minutes.
    test.skip(!posthogReadable, 'POSTHOG_HOST / POSTHOG_PROJECT_ID / POSTHOG_API_KEY not set: server-side read-back skipped.');
    await expect
      .poll(
        async () => {
          const events = await readServerEvents(user.id);
          const names = new Set(events.map((e) => e.event));
          return Object.keys(EXPECTED_SERVER_EVENTS).filter((name) => !names.has(name));
        },
        { timeout: 3 * 60_000, intervals: [5_000, 10_000, 15_000], message: 'server-side events missing in PostHog' },
      )
      .toEqual([]);

    const events = await readServerEvents(user.id);
    for (const [name, requiredProps] of Object.entries(EXPECTED_SERVER_EVENTS)) {
      const event = events.find((e) => e.event === name)!;
      for (const prop of requiredProps) {
        expect(event.properties[prop], `${name}.${prop}`).toBeDefined();
      }
      if (!NO_REQUEST_CONTEXT.has(name)) expect(event.properties.source, `${name}.source`).toBeDefined();
      expect(JSON.stringify(event.properties)).not.toContain('sk-posthog-smoke'); // never a secret value
    }
    const promptSent = events.find((e) => e.event === 'prompt_sent')!;
    expect(promptSent.properties.$groups).toMatchObject({ account: accountId, project: projectId });
    const providerConfigured = events.find((e) => e.event === 'provider_configured')!;
    expect(providerConfigured.properties.provider).toBe('openai');
    expect(providerConfigured.properties.method).toBe('api_key');
    console.log(
      `[27-posthog] events for ${user.id}: ${events.map((e) => e.event).join(', ')}`,
    );
  });
});

// No sandbox needed: only the web server and the PostHog key.
test.describe('27 — PostHog consent', { tag: '@quarantine' }, () => {
  test.skip(!enabled, 'Set E2E_ENABLE_POSTHOG_SMOKE=1 for the real PostHog flow.');

  test('anonymous visitors are captured only after CookieYes "analytics" consent', async ({ browser }) => {
    const cky = (fields: string) => ({
      name: 'cookieyes-consent',
      value: `consentid:e2e,${fields}`,
      url: process.env.E2E_BASE_URL || 'http://localhost:3000',
    });
    const visit = async (cookie?: ReturnType<typeof cky>, waitForEvent?: string) => {
      const context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      });
      if (cookie) await context.addCookies([cookie]);
      const page = await context.newPage();
      await hideAutomation(page);
      const captures: string[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (request.method() === 'POST' && url.pathname.startsWith('/ingest/') && !url.pathname.startsWith('/ingest/flags')) {
          captures.push(...decodeCaptureBody(request).map((e) => e.event));
        }
      });
      await page.goto('/', { waitUntil: 'load' });
      if (waitForEvent) {
        // The replay recorder is a lazily loaded script, so `$snapshot` lands
        // seconds after the pageview. Poll instead of guessing a fixed wait.
        const deadline = Date.now() + 25_000;
        while (Date.now() < deadline && !captures.includes(waitForEvent)) {
          await page.waitForTimeout(500);
        }
      } else {
        await page.waitForTimeout(6_000);
      }
      await context.close();
      return captures;
    };

    // No decision yet: nothing leaves the browser.
    expect(await visit()).toEqual([]);
    // Reject All: still nothing.
    expect(await visit(cky('consent:no,action:yes,necessary:yes,functional:no,analytics:no,advertisement:no'))).toEqual([]);
    // Accept All: the pageview goes out, and replay records this allowed route.
    const accepted = await visit(
      cky('consent:yes,action:yes,necessary:yes,functional:yes,analytics:yes,advertisement:yes'),
      '$snapshot',
    );
    expect(accepted).toContain('$pageview');
    expect(accepted).toContain('$snapshot');
  });
});
