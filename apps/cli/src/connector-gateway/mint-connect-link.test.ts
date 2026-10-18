/**
 * The url handed to the human must be OUR /connect/<token>, not the provider's.
 *
 * The web transcript turns exactly that shape into the one-click Connect button
 * (parseSetupLinkHref -> SetupLinkButton). A `connect.composio.dev/link/...` url
 * has no such handling, so it rendered as a bare underlined link beside a
 * generic link preview — no button, no popup, and the human had to copy it into
 * a tab and then type "done".
 *
 * Despite its name, mintConnectLink used to POST the provider-authorization
 * route and return that raw url, silently dropping `expiresInMinutes` because
 * that route has no such parameter.
 *
 * The test is fully real — a real gateway module over a real HTTP client
 * against a fake API. No `mock.module`: a bun module mock is process-wide and
 * never unmocked, so a partial mock here (api/auth.ts without
 * `loadAuthForHost`, api/client.ts without `ApiError`) poisoned every later
 * test file sharing the process and made whole batches fail depending on file
 * order. The delegation env pins give gateway.ts its auth and project through
 * the real code path instead; each test gets a fresh fake API.
 */
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';

import { type FakeApi, startFakeApi } from '../__tests__/support/account-cli-harness.ts';

const SAVED_ENV: Record<string, string | undefined> = {};
for (const key of [
  'KORTIX_PROJECT_ID',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
]) {
  SAVED_ENV[key] = process.env[key];
}
afterAll(() => {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const setupLinkResponse = { url: 'https://dev.kortix.com/connect/ksl_abc', app: 'gmail' };
const providerResponse = {
  provider: 'composio',
  connectUrl: 'https://connect.composio.dev/link/lk_raw',
};

let api: FakeApi;
let setupLinkThrows = false;

beforeEach(() => {
  setupLinkThrows = false;
  api = startFakeApi((req, url) => {
    if (req.method === 'POST' && url.pathname === '/v1/projects/proj-1/connect-requests') {
      if (setupLinkThrows) return Response.json({ error: 'conflict' }, { status: 409 });
      return Response.json(setupLinkResponse);
    }
    if (
      req.method === 'POST' &&
      url.pathname.startsWith('/v1/connectors/projects/proj-1/connectors/')
    ) {
      return Response.json(providerResponse);
    }
    return undefined;
  });
  process.env.KORTIX_PROJECT_ID = 'proj-1';
  process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
  process.env.KORTIX_TOKEN = 't';
  process.env.KORTIX_API_URL = api.url;
});
afterEach(() => api.stop());

const { mintConnectLink } = await import('./gateway.ts');

test('mints the Kortix connect link the transcript renders as a button', async () => {
  const r = await mintConnectLink({ slug: 'gmail' });
  expect(r.url).toBe('https://dev.kortix.com/connect/ksl_abc');
  expect(r.url).not.toContain('composio.dev');
  expect(api.requests[0].path).toBe('/v1/projects/proj-1/connect-requests');
  expect(api.requests[0].body).toMatchObject({ slug: 'gmail' });
});

test('forwards expires_in_minutes — the setup-link route is the one that takes it', async () => {
  await mintConnectLink({ slug: 'gmail', expiresInMinutes: 45 });
  expect(api.requests[0].body).toMatchObject({ slug: 'gmail', expires_in_minutes: 45 });
});

// The link creates an ACCOUNT, and an account belongs either to the human who
// opens it or to the whole project. The field is omitted unless asked for: the
// connect-request body is `.strict()`, so a CLI that always sent it would 400
// against an API deployed before the field existed.
test('sends owner only when the caller names one', async () => {
  await mintConnectLink({ slug: 'gmail' });
  expect(api.requests[0].body).not.toHaveProperty('owner');

  await mintConnectLink({ slug: 'gmail', owner: 'project' });
  expect(api.requests[1].body).toMatchObject({ slug: 'gmail', owner: 'project' });

  await mintConnectLink({ slug: 'gmail', owner: 'me' });
  expect(api.requests[2].body).toMatchObject({ slug: 'gmail', owner: 'me' });
});

// The agent may suggest a name for the NEW account ("Dad's Gmail"); the human
// sees it prefilled. Omitted unless named, for the same old-API reason as owner.
test('sends the suggested account name only when the caller names one', async () => {
  await mintConnectLink({ slug: 'gmail' });
  expect(api.requests[0].body).not.toHaveProperty('label');

  await mintConnectLink({ slug: 'gmail', label: "Dad's Gmail" });
  expect(api.requests[1].body).toMatchObject({ slug: 'gmail', label: "Dad's Gmail" });
});

test('the provider fallback takes no label: it authorizes the slot account', async () => {
  setupLinkThrows = true;
  await mintConnectLink({ slug: 'weird', label: 'Named' });
  setupLinkThrows = false;
  const last = api.requests.at(-1);
  expect(last?.path).toContain('/connectors/weird/connect');
  expect(last?.body).toEqual({});
});

test('carries owner onto the provider fallback too', async () => {
  setupLinkThrows = true;
  await mintConnectLink({ slug: 'weird', owner: 'project' });
  setupLinkThrows = false;
  const last = api.requests.at(-1);
  expect(last?.path).toContain('/connectors/weird/connect');
  expect(last?.body).toEqual({ owner: 'project' });
});

test('falls back to the provider url when no setup link can be minted', async () => {
  setupLinkThrows = true;
  const r = await mintConnectLink({ slug: 'weird' });
  setupLinkThrows = false;
  // A bare url is worse than a button, but better than telling the human nothing.
  expect(r.url).toBe('https://connect.composio.dev/link/lk_raw');
  expect(api.requests.at(-1)?.path).toContain('/connectors/weird/connect');
});
