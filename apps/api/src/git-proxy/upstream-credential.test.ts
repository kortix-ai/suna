/**
 * The proxy never forwards a git request it could not credential.
 *
 * A managed repository is private. When `resolveProjectGitAuth` cannot produce
 * a token — the managed GitHub App mint is the usual way, and it fails with a
 * plain HTTP 422 the moment the named repository is not yet visible to the
 * installation — the upstream used to be built with NO Authorization header and
 * forwarded anyway. GitHub answers a credential-less request for a private repo
 * with `404 Repository not found.`, which git reports as
 *
 *     remote: Repository not found.
 *     fatal: repository '<proxy url>' not found
 *
 * so a transient, retryable credential failure was indistinguishable from a
 * deleted repository — for the user and for the release gate alike (AGP-7/9/10,
 * GH-17). Worse, `resolveProjectUpstreamMemo` cached that credential-less
 * upstream for 30 s, so one failed mint poisoned every following request for
 * the same project.
 *
 * The proxy now fails CLOSED: it refuses with 503 and names the reason, and the
 * refusal is never memoized, so the next request re-resolves.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

const PROJECT_ID = 'b06a70f1-be0a-4fd0-b052-26fffb92713f';

/** Swapped per test: what the credential resolver manages to produce. */
let upstreamResult: any = null;
/** Every request the fake upstream actually received. */
let upstreamHits: Array<{ path: string; authorization: string | null }> = [];

const realProjects = await import('../projects');
mock.module('../projects', () => ({
  ...realProjects,
  authorizeGitProxy: async () => ({
    ok: true,
    principal: { kind: 'user', userId: 'user-1', tokenId: 'tok-1' },
    agentGrant: null,
    project: {
      projectId: PROJECT_ID,
      accountId: 'acc-1',
      defaultBranch: 'main',
      repoUrl: 'https://example.invalid/managed.git',
      metadata: {},
    },
  }),
  resolveProjectUpstream: async () => upstreamResult,
}));

const { gitProxyApp, __resetGitProxyMemosForTests } = await import('./index');

let upstreamServer: ReturnType<typeof Bun.serve>;
let proxyServer: ReturnType<typeof Bun.serve>;
let upstreamUrl = '';
let proxyBase = '';

beforeAll(() => {
  // Stands in for GitHub: records what it was asked and with which credential.
  upstreamServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      upstreamHits.push({ path: url.pathname, authorization: req.headers.get('authorization') });
      const body =
        '001e# service=git-upload-pack\n' +
        '0000' +
        '003f' +
        'c'.repeat(40) +
        ' refs/heads/main\n' +
        '0000';
      return new Response(body, {
        headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
      });
    },
  });
  upstreamUrl = `http://127.0.0.1:${upstreamServer.port}/upstream.git`;

  const host = new Hono();
  host.route('/', gitProxyApp);
  proxyServer = Bun.serve({ port: 0, fetch: (req) => host.fetch(req) });
  proxyBase = `http://127.0.0.1:${proxyServer.port}`;
});

afterAll(() => {
  upstreamServer?.stop(true);
  proxyServer?.stop(true);
});

/** Ref discovery — the first request of every clone, fetch and ls-remote. */
const discover = () =>
  fetch(`${proxyBase}/${PROJECT_ID}/info/refs?service=git-upload-pack`, {
    // Any credential: the verdict is mocked, but the proxy refuses before it
    // calls the authorizer when no Authorization header is present at all.
    headers: { authorization: `Basic ${Buffer.from('x:kortix_pat_test').toString('base64')}` },
  });

describe('an upstream whose credential could not be produced', () => {
  beforeAll(() => __resetGitProxyMemosForTests());

  test('is refused with 503 and a retryable reason, and is never forwarded', async () => {
    __resetGitProxyMemosForTests();
    upstreamHits = [];
    upstreamResult = {
      url: upstreamUrl,
      headers: {},
      credentialUnavailable: 'managed_git_token_mint_failed',
    };

    const res = await discover();
    expect(res.status).toBe(503);
    const body = (await res.json()) as any;
    expect(body.error).toBe('git_credential_unavailable');
    expect(body.reason).toBe('managed_git_token_mint_failed');
    expect(body.retry).toBe(true);
    // The whole point: a private repo is never probed without a credential, so
    // GitHub never gets the chance to answer "Repository not found".
    expect(upstreamHits).toEqual([]);
  });

  test('a reason the account must act on is refused too, but not as retryable', async () => {
    __resetGitProxyMemosForTests();
    upstreamHits = [];
    upstreamResult = {
      url: upstreamUrl,
      headers: {},
      credentialUnavailable: 'installation_missing',
    };

    const res = await discover();
    expect(res.status).toBe(503);
    const body = (await res.json()) as any;
    expect(body.reason).toBe('installation_missing');
    expect(body.retry).toBe(false);
    expect(upstreamHits).toEqual([]);
  });

  test('is not memoized — the next request re-resolves and succeeds', async () => {
    __resetGitProxyMemosForTests();
    upstreamHits = [];
    upstreamResult = {
      url: upstreamUrl,
      headers: {},
      credentialUnavailable: 'managed_git_token_mint_failed',
    };
    expect((await discover()).status).toBe(503);

    // The mint recovers. Without the memo fix the credential-less upstream is
    // still cached for 30 s and this second request fails exactly like the first.
    upstreamResult = { url: upstreamUrl, headers: { authorization: 'Basic dGVzdA==' } };
    const res = await discover();
    expect(res.status).toBe(200);
    expect(upstreamHits.map((h) => h.authorization)).toEqual(['Basic dGVzdA==']);
  });
});

describe('an upstream that has its credential', () => {
  test('is forwarded with the credential attached', async () => {
    __resetGitProxyMemosForTests();
    upstreamHits = [];
    upstreamResult = { url: upstreamUrl, headers: { authorization: 'Basic dGVzdA==' } };

    const res = await discover();
    expect(res.status).toBe(200);
    expect(upstreamHits).toHaveLength(1);
    expect(upstreamHits[0]!.authorization).toBe('Basic dGVzdA==');
  });
});
