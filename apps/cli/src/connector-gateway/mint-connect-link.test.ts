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
 * The auth + project context come from the sandbox env (KORTIX_TOKEN,
 * KORTIX_API_URL, KORTIX_PROJECT_ID) against a real local HTTP server that
 * records every POST — no `mock.module`. Bun runs a package's test files in
 * one process, so a module mock registered here would replace the module for
 * every test file that runs later in the same worker.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';

const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
let setupLinkResponse: unknown = { url: 'https://dev.kortix.com/connect/ksl_abc', app: 'gmail' };
let setupLinkThrows = false;

let server: ReturnType<typeof Bun.serve> | null = null;
let apiPort = 0;

const ENV_KEYS = [
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_SESSION_ID',
  'BASH_ENV',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
  'KORTIX_CONFIG_FILE',
  'KORTIX_AUTH_FILE',
] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.KORTIX_TOKEN = 't';
  process.env.KORTIX_API_URL = `http://127.0.0.1:${apiPort}`;
  process.env.KORTIX_PROJECT_ID = 'proj-1';
  process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
  process.env.KORTIX_CONFIG_FILE = '/nonexistent/kortix-mint-connect-test.json';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const { mintConnectLink } = await import('./gateway.ts');

function startApi(): void {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return Response.json({ error: 'not found' }, { status: 404 });
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const path = new URL(req.url).pathname;
      posts.push({ path, body });
      if (path.includes('/connect-requests')) {
        if (setupLinkThrows) {
          return Response.json({ error: '409 provider unsupported' }, { status: 409 });
        }
        return Response.json(setupLinkResponse);
      }
      return Response.json({
        provider: 'composio',
        connectUrl: 'https://connect.composio.dev/link/lk_raw',
      });
    },
  });
  apiPort = server.port ?? 0;
}

startApi();

test('mints the Kortix connect link the transcript renders as a button', async () => {
  posts.length = 0;
  const r = await mintConnectLink({ slug: 'gmail' });
  expect(r.url).toBe('https://dev.kortix.com/connect/ksl_abc');
  expect(r.url).not.toContain('composio.dev');
  expect(posts[0].path).toBe('/v1/projects/proj-1/connect-requests');
  expect(posts[0].body).toMatchObject({ slug: 'gmail' });
});

test('forwards expires_in_minutes — the setup-link route is the one that takes it', async () => {
  posts.length = 0;
  await mintConnectLink({ slug: 'gmail', expiresInMinutes: 45 });
  expect(posts[0].body).toMatchObject({ slug: 'gmail', expires_in_minutes: 45 });
});

// The link creates an ACCOUNT, and an account belongs either to the human who
// opens it or to the whole project. The field is omitted unless asked for: the
// connect-request body is `.strict()`, so a CLI that always sent it would 400
// against an API deployed before the field existed.
test('sends owner only when the caller names one', async () => {
  posts.length = 0;
  await mintConnectLink({ slug: 'gmail' });
  expect(posts[0].body).not.toHaveProperty('owner');

  posts.length = 0;
  await mintConnectLink({ slug: 'gmail', owner: 'project' });
  expect(posts[0].body).toMatchObject({ slug: 'gmail', owner: 'project' });

  posts.length = 0;
  await mintConnectLink({ slug: 'gmail', owner: 'me' });
  expect(posts[0].body).toMatchObject({ slug: 'gmail', owner: 'me' });
});

// The agent may suggest a name for the NEW account ("Dad's Gmail"); the human
// sees it prefilled. Omitted unless named, for the same old-API reason as owner.
test('sends the suggested account name only when the caller names one', async () => {
  posts.length = 0;
  await mintConnectLink({ slug: 'gmail' });
  expect(posts[0].body).not.toHaveProperty('label');

  posts.length = 0;
  await mintConnectLink({ slug: 'gmail', label: "Dad's Gmail" });
  expect(posts[0].body).toMatchObject({ slug: 'gmail', label: "Dad's Gmail" });
});

test('the provider fallback takes no label: it authorizes the slot account', async () => {
  posts.length = 0;
  setupLinkThrows = true;
  await mintConnectLink({ slug: 'weird', label: 'Named' });
  setupLinkThrows = false;
  expect(posts.at(-1)?.path).toContain('/connectors/weird/connect');
  expect(posts.at(-1)?.body).toEqual({});
});

test('carries owner onto the provider fallback too', async () => {
  posts.length = 0;
  setupLinkThrows = true;
  await mintConnectLink({ slug: 'weird', owner: 'project' });
  setupLinkThrows = false;
  expect(posts.at(-1)?.path).toContain('/connectors/weird/connect');
  expect(posts.at(-1)?.body).toEqual({ owner: 'project' });
});

test('falls back to the provider url when no setup link can be minted', async () => {
  posts.length = 0;
  setupLinkThrows = true;
  const r = await mintConnectLink({ slug: 'weird' });
  setupLinkThrows = false;
  // A bare url is worse than a button, but better than telling the human nothing.
  expect(r.url).toBe('https://connect.composio.dev/link/lk_raw');
  expect(posts.at(-1)?.path).toContain('/connectors/weird/connect');
});
