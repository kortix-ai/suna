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
 */
import { expect, mock, test } from 'bun:test';

const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
let setupLinkResponse: unknown = { url: 'https://dev.kortix.com/connect/ksl_abc', app: 'gmail' };
let setupLinkThrows = false;

mock.module('./io.ts', () => ({ CliError: class extends Error {} }));
mock.module('../api/auth.ts', () => ({ loadAuth: () => ({ token: 't' }) }));
mock.module('../project-link.ts', () => ({ resolveProjectId: () => 'proj-1' }));
mock.module('../api/sdk.ts', () => ({ kortixFromAuth: () => ({}) }));
mock.module('../api/client.ts', () => ({
  clientFromAuth: () => ({
    post: async (path: string, body: Record<string, unknown>) => {
      posts.push({ path, body });
      if (path.includes('/connect-requests')) {
        if (setupLinkThrows) throw new Error('409 provider unsupported');
        return setupLinkResponse;
      }
      return { provider: 'composio', connectUrl: 'https://connect.composio.dev/link/lk_raw' };
    },
  }),
}));

const { mintConnectLink } = await import('./gateway.ts');

test('mints the Kortix connect link the transcript renders as a button', async () => {
  posts.length = 0;
  const r = await mintConnectLink({ slug: 'gmail' });
  expect(r.url).toBe('https://dev.kortix.com/connect/ksl_abc');
  expect(r.url).not.toContain('composio.dev');
  expect(posts[0].path).toBe('/projects/proj-1/connect-requests');
  expect(posts[0].body).toMatchObject({ slug: 'gmail' });
});

test('forwards expires_in_minutes — the setup-link route is the one that takes it', async () => {
  posts.length = 0;
  await mintConnectLink({ slug: 'gmail', expiresInMinutes: 45 });
  expect(posts[0].body).toMatchObject({ slug: 'gmail', expires_in_minutes: 45 });
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
