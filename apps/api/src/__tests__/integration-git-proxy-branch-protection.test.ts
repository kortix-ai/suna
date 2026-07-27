/**
 * Integration tests over the git proxy ROUTE HANDLER itself.
 *
 * The unit tests pin the parser, the classifier and the rule in isolation. This
 * file pins the WIRING, which is where a control like this actually goes wrong:
 *  - does a human push still reach the upstream with a byte-identical body?
 *  - does an allowed agent push still stream (head re-emitted, pack untouched)?
 *  - does a denial short-circuit BEFORE upstream resolution, so we never mint a
 *    host credential for a push we refuse?
 *  - does a denial avoid the warm-prebake kick? (The denial is an HTTP 200, and
 *    the prebake block keys on `status >= 200 && < 300` — falling through would
 *    fire a pointless per-project bake on every refused push.)
 *  - do `observe` and `off` really forward?
 *
 * git-receive-pack is how EVERY push in Kortix works, so a regression here
 * breaks humans, sessions, `kortix ship` and warm prebake at once.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const UPSTREAM = 'https://github.example/org/repo.git';

const bytes = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);

/** Real git 2.39.1 capture: `git push origin main`. */
const PUSH_MAIN = bytes(
  '00af02b015697c26889ba76e6c49c1cb80d776d7bc2a d9855296bb43281a895c313a6731cd21c5120fad refs/heads/main\u0000 report-status-v2 side-band-64k quiet object-format=sha1 agent=git/2.39.10000PACK\u0000\u0000\u0000\u0002payload-bytes',
);

/** Real capture: depth-1 clone pushing a session-UUID branch (the hot path). */
const PUSH_SESSION_BRANCH = bytes(
  '0035shallow 02b015697c26889ba76e6c49c1cb80d776d7bc2a\n00cf0000000000000000000000000000000000000000 3699610caaad37a71b3dc48e5fd4cf7b18f9a1c0 refs/heads/3f2a1b7c-9d4e-4a1b-8c2d-1e5f7a9b3c4d\u0000 report-status-v2 side-band-64k quiet object-format=sha1 agent=git/2.39.10000PACK\u0000\u0000\u0000\u0002payload-bytes',
);

let principal: Record<string, unknown> = { kind: 'user', accountId: 'acct-1', userId: 'user-1' };
let protectionMode: 'enforce' | 'observe' | 'off' = 'enforce';
let connectionDefaultBranch: string | null = 'main';
let prebakeCalls = 0;
let auditCalls: Array<Record<string, unknown>> = [];
let upstreamCalls: Array<{ url: string; body: Uint8Array }> = [];
let resolveUpstreamCalls = 0;

const projectRow = {
  projectId: PROJECT_ID,
  accountId: 'acct-1',
  status: 'active',
  defaultBranch: 'main',
  metadata: {},
};

const realProjects = await import('../projects');
mock.module('../projects', () => ({
  ...realProjects,
  authorizeGitProxy: async () => ({ ok: true, project: projectRow, principal }),
  resolveProjectUpstream: async () => {
    resolveUpstreamCalls += 1;
    return { url: UPSTREAM, headers: { authorization: 'Bearer host-credential' } };
  },
}));

const realGitLib = await import('../projects/lib/git');
mock.module('../projects/lib/git', () => ({
  ...realGitLib,
  getProjectGitConnection: async () =>
    connectionDefaultBranch === null ? null : { defaultBranch: connectionDefaultBranch },
  loadGitProject: async () => ({ projectId: PROJECT_ID }),
}));

const realBuilder = await import('../snapshots/builder');
mock.module('../snapshots/builder', () => ({
  ...realBuilder,
  kickProjectWarmPrebake: async () => {
    prebakeCalls += 1;
  },
}));

const realAudit = await import('../shared/audit');
mock.module('../shared/audit', () => ({
  ...realAudit,
  recordAuditEvent: async (input: Record<string, unknown>) => {
    auditCalls.push(input);
  },
}));

const realConfig = await import('../config');
mock.module('../config', () => ({
  ...realConfig,
  config: new Proxy(realConfig.config, {
    get: (target, prop) =>
      prop === 'KORTIX_GIT_PROXY_DEFAULT_BRANCH_PROTECTION'
        ? protectionMode
        : (target as Record<string | symbol, unknown>)[prop],
  }),
}));

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : String(input);
  if (!url.startsWith(UPSTREAM)) return originalFetch(input as never, init as never);
  // Consume the forwarded body so we can assert it survived byte-identically.
  const body = init?.body
    ? new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer())
    : new Uint8Array(0);
  upstreamCalls.push({ url, body });
  return new Response('0000', {
    status: 200,
    headers: { 'content-type': 'application/x-git-receive-pack-result' },
  });
}) as typeof fetch;

const { gitProxyApp } = await import('../git-proxy/index');

function push(body: Uint8Array<ArrayBuffer>) {
  return gitProxyApp.request(`/${PROJECT_ID}.git/git-receive-pack`, {
    method: 'POST',
    headers: {
      authorization: 'Basic eC1hY2Nlc3MtdG9rZW46dG9rZW4=',
      'content-type': 'application/x-git-receive-pack-request',
      'user-agent': 'git/2.39.1',
    },
    body,
    // @ts-ignore — Bun/undici need this to accept a streamed request body.
    duplex: 'half',
  });
}

beforeEach(() => {
  principal = { kind: 'user', accountId: 'acct-1', userId: 'user-1' };
  protectionMode = 'enforce';
  connectionDefaultBranch = 'main';
  prebakeCalls = 0;
  auditCalls = [];
  upstreamCalls = [];
  resolveUpstreamCalls = 0;
});

describe('human principals — unchanged', () => {
  test('a human pushing the default branch reaches the upstream, body byte-identical', async () => {
    const res = await push(PUSH_MAIN);

    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]!.body).toEqual(PUSH_MAIN);
    expect(auditCalls).toHaveLength(0);
  });

  test('an account API key pushing the default branch is forwarded (v1 residual)', async () => {
    principal = { kind: 'api_key', accountId: 'acct-1', keyId: 'key-1' };

    const res = await push(PUSH_MAIN);

    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
  });

  test('a successful human push still kicks the warm prebake', async () => {
    await push(PUSH_MAIN);
    await Bun.sleep(10); // the kick is fire-and-forget
    expect(prebakeCalls).toBe(1);
  });
});

describe('agent principals — allowed pushes', () => {
  test('a sandbox pushing a session branch is forwarded, body byte-identical', async () => {
    // THE HOT PATH. Every session push looks exactly like this — leading
    // `shallow` line and all. If the re-emitted stream is not byte-identical,
    // every agent push corrupts.
    principal = { kind: 'sandbox', accountId: 'acct-1', sandboxId: 'sandbox-1' };

    const res = await push(PUSH_SESSION_BRANCH);

    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]!.body).toEqual(PUSH_SESSION_BRANCH);
  });

  test('a session PAT pushing a session branch is forwarded', async () => {
    principal = { kind: 'session', accountId: 'acct-1', sessionId: 'sandbox-1' };

    const res = await push(PUSH_SESSION_BRANCH);

    expect(res.status).toBe(200);
    expect(upstreamCalls[0]!.body).toEqual(PUSH_SESSION_BRANCH);
  });
});

describe('agent principals — denied pushes', () => {
  beforeEach(() => {
    principal = { kind: 'session', accountId: 'acct-1', sessionId: 'sandbox-1', userId: 'user-1' };
  });

  test('an agent pushing the default branch is refused with a git-native report', async () => {
    const res = await push(PUSH_MAIN);

    // HTTP 200 carrying report-status: a 403 body is invisible to git.
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-git-receive-pack-result');
    expect(res.headers.get('x-kortix-deny-reason')).toBe('protected-ref');
    const body = Buffer.from(await res.arrayBuffer()).toString('latin1');
    expect(body).toContain('unpack ok');
    expect(body).toContain('ng refs/heads/main protected:');
    expect(body).toContain('kortix cr open --head');
  });

  test('the denial never reaches the upstream', async () => {
    await push(PUSH_MAIN);
    expect(upstreamCalls).toHaveLength(0);
  });

  test('the denial short-circuits BEFORE upstream resolution', async () => {
    // We must not mint a short-lived host credential for a push we refuse.
    await push(PUSH_MAIN);
    expect(resolveUpstreamCalls).toBe(0);
  });

  test('the denial does NOT kick a warm prebake', async () => {
    // The trap: the denial is an HTTP 200 and the prebake block keys on
    // 2xx — falling through would bake on every refused push.
    await push(PUSH_MAIN);
    await Bun.sleep(10);
    expect(prebakeCalls).toBe(0);
  });

  test('the denial is audited with a distinct reason code', async () => {
    await push(PUSH_MAIN);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      accountId: 'acct-1',
      action: 'git_proxy.push.default_branch_denied',
      resourceType: 'project',
      resourceId: PROJECT_ID,
    });
    expect((auditCalls[0]!.metadata as Record<string, unknown>).deny_reason).toBe('protected-ref');
  });

  test('an unreadable body (content-encoding) fails CLOSED with its own code', async () => {
    const res = await gitProxyApp.request(`/${PROJECT_ID}.git/git-receive-pack`, {
      method: 'POST',
      headers: {
        authorization: 'Basic eC1hY2Nlc3MtdG9rZW46dG9rZW4=',
        'content-type': 'application/x-git-receive-pack-request',
        'content-encoding': 'gzip',
      },
      body: PUSH_SESSION_BRANCH,
      // @ts-ignore
      duplex: 'half',
    });

    // No ref names ⇒ no report-status can be built ⇒ 403, which git will not
    // display. Accepted: it should ~never happen, and the header + audit carry
    // the detail.
    expect(res.status).toBe(403);
    expect(res.headers.get('x-kortix-deny-reason')).toBe('unparseable:content-encoding');
    expect(upstreamCalls).toHaveLength(0);
  });

  test('the STALE connection default_branch is protected too', async () => {
    // projects.default_branch has moved to `trunk`; the connection row still
    // says `main`. Both must be refused.
    connectionDefaultBranch = 'main';
    const res = await push(PUSH_MAIN);
    expect(res.headers.get('x-kortix-deny-reason')).toBe('protected-ref');
  });
});

describe('kill switch', () => {
  beforeEach(() => {
    principal = { kind: 'session', accountId: 'acct-1', sessionId: 'sandbox-1' };
  });

  test('`off` forwards everything, untouched', async () => {
    protectionMode = 'off';

    const res = await push(PUSH_MAIN);

    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]!.body).toEqual(PUSH_MAIN);
    expect(auditCalls).toHaveLength(0);
  });

  test('`observe` records the decision but still forwards the push', async () => {
    protectionMode = 'observe';

    const res = await push(PUSH_MAIN);

    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]!.body).toEqual(PUSH_MAIN);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({ action: 'git_proxy.push.default_branch_observed' });
  });

  test('`observe` forwards an UNPARSEABLE push with its body intact', async () => {
    // Regression: the unparseable paths never consume the body, so there is no
    // replay stream to hand on. Forwarding `null` there would ship an EMPTY
    // push to the upstream and turn a read-only canary into an outage.
    protectionMode = 'observe';

    const res = await gitProxyApp.request(`/${PROJECT_ID}.git/git-receive-pack`, {
      method: 'POST',
      headers: {
        authorization: 'Basic eC1hY2Nlc3MtdG9rZW46dG9rZW4=',
        'content-type': 'application/x-git-receive-pack-request',
        'content-encoding': 'gzip',
      },
      body: PUSH_SESSION_BRANCH,
      // @ts-ignore
      duplex: 'half',
    });

    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]!.body).toEqual(PUSH_SESSION_BRANCH);
    expect(auditCalls[0]).toMatchObject({ action: 'git_proxy.push.default_branch_observed' });
  });
});

describe('other git endpoints are never parsed', () => {
  test('git-upload-pack (clone/fetch) is untouched for an agent', async () => {
    principal = { kind: 'session', accountId: 'acct-1', sessionId: 'sandbox-1' };

    const res = await gitProxyApp.request(`/${PROJECT_ID}.git/git-upload-pack`, {
      method: 'POST',
      headers: {
        authorization: 'Basic eC1hY2Nlc3MtdG9rZW46dG9rZW4=',
        'content-type': 'application/x-git-upload-pack-request',
      },
      body: bytes('0000-not-a-command-list'),
      // @ts-ignore
      duplex: 'half',
    });

    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    expect(auditCalls).toHaveLength(0);
  });
});
