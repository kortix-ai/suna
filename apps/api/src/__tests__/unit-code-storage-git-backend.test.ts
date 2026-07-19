/**
 * Unit tests for the code.storage (Pierre) managed git backend
 * (projects/git-backends/code-storage.ts): JWT minting (alg/claims/scopes,
 * repo-scoped vs org-wide), createRepo/deleteRepo request+response mapping,
 * buildUpstream's neutral {url, headers} shape for read vs write, and
 * seedFiles' commit-pack ndjson payload. All HTTP is mocked via
 * `globalThis.fetch` (same convention as unit-github-owner-type-routing.test.ts)
 * — this file never touches the live code.storage API, and every private key
 * used below is a throwaway generated in-process with node:crypto, never a
 * real credential.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { jwtVerify, importSPKI } from 'jose';
import { config } from '../config';
import {
  codeStorageBackend,
  codeStorageGitAuthHeader,
  mintCodeStorageJwt,
  type GitConnectionRef,
} from '../projects/git-backends';

// Throwaway EC (P-256) and RSA keypairs — signing-only, never a live
// code.storage credential.
const EC_KEYS = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const EC_PRIVATE_PEM = EC_KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const EC_PUBLIC_PEM = EC_KEYS.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const RSA_KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 });
const RSA_PRIVATE_PEM = RSA_KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const RSA_PUBLIC_PEM = RSA_KEYS.publicKey.export({ type: 'spki', format: 'pem' }).toString();

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const [, payload] = jwt.split('.');
  return JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
}

function decodeJwtHeader(jwt: string): Record<string, unknown> {
  const [header] = jwt.split('.');
  return JSON.parse(Buffer.from(header!, 'base64url').toString('utf8'));
}

const SNAPSHOT_KEYS = [
  'CODE_STORAGE_ORG',
  'CODE_STORAGE_PRIVATE_KEY',
  'CODE_STORAGE_API_BASE',
  'CODE_STORAGE_GIT_HOST',
] as const;
const saved: Record<string, string> = {};

beforeEach(() => {
  for (const k of SNAPSHOT_KEYS) saved[k] = (config as any)[k];
  config.CODE_STORAGE_ORG = 'acme';
  config.CODE_STORAGE_PRIVATE_KEY = EC_PRIVATE_PEM;
  config.CODE_STORAGE_API_BASE = '';
  config.CODE_STORAGE_GIT_HOST = '';
});

afterEach(() => {
  for (const k of SNAPSHOT_KEYS) (config as any)[k] = saved[k];
});

function ref(overrides: Partial<GitConnectionRef> = {}): GitConnectionRef {
  return {
    provider: 'code-storage',
    upstreamUrl: 'https://acme.code.storage/team/project-alpha.git',
    externalRepoId: 'repo_7f2b3d9',
    repoOwner: null,
    repoName: 'team/project-alpha',
    installationId: null,
    credentialRef: null,
    defaultBranch: 'main',
    managed: true,
    metadata: {},
    ...overrides,
  };
}

describe('mintCodeStorageJwt', () => {
  test('signs ES256 for an EC private key, verifiable by a spec-compliant verifier', async () => {
    const jwt = mintCodeStorageJwt({ repo: 'team/project-alpha', scopes: ['git:read'] });
    expect(decodeJwtHeader(jwt)).toEqual({ alg: 'ES256', typ: 'JWT' });
    const key = await importSPKI(EC_PUBLIC_PEM, 'ES256');
    const { payload } = await jwtVerify(jwt, key);
    expect(payload.iss).toBe('acme');
    expect(payload.repo).toBe('team/project-alpha');
    expect(payload.scopes).toEqual(['git:read']);
  });

  test('signs RS256 for an RSA private key, verifiable by a spec-compliant verifier', async () => {
    config.CODE_STORAGE_PRIVATE_KEY = RSA_PRIVATE_PEM;
    const jwt = mintCodeStorageJwt({ scopes: ['repo:write'] });
    expect(decodeJwtHeader(jwt)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const key = await importSPKI(RSA_PUBLIC_PEM, 'RS256');
    const { payload } = await jwtVerify(jwt, key);
    expect(payload.scopes).toEqual(['repo:write']);
  });

  test('claims: iss/sub/scopes/iat/exp, repo-scoped', () => {
    const before = Math.floor(Date.now() / 1000);
    const jwt = mintCodeStorageJwt({
      repo: 'team/project-alpha',
      scopes: ['git:write', 'git:read'],
      ttlSeconds: 120,
      subject: 'kortix-session-42',
    });
    const payload = decodeJwtPayload(jwt);
    expect(payload.iss).toBe('acme');
    expect(payload.sub).toBe('kortix-session-42');
    expect(payload.repo).toBe('team/project-alpha');
    expect(payload.scopes).toEqual(['git:write', 'git:read']);
    expect(payload.iat as number).toBeGreaterThanOrEqual(before);
    expect(payload.exp as number).toBe((payload.iat as number) + 120);
  });

  test('org-wide token omits the `repo` claim entirely', () => {
    const jwt = mintCodeStorageJwt({ scopes: ['repo:write'] });
    const payload = decodeJwtPayload(jwt);
    expect('repo' in payload).toBe(false);
  });

  test('defaults sub to "kortix-api" when no subject given', () => {
    const jwt = mintCodeStorageJwt({ scopes: ['org:read'] });
    expect(decodeJwtPayload(jwt).sub).toBe('kortix-api');
  });

  test('throws when org or private key is not configured', () => {
    config.CODE_STORAGE_ORG = '';
    expect(() => mintCodeStorageJwt({ scopes: ['git:read'] })).toThrow(/not configured/);
  });

  test('throws on an unsupported (e.g. Ed25519) key type', () => {
    const ed = generateKeyPairSync('ed25519');
    config.CODE_STORAGE_PRIVATE_KEY = ed.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => mintCodeStorageJwt({ scopes: ['git:read'] })).toThrow(/unsupported/);
  });

  test('throws on a non-P-256 EC curve (ES256 is only spec-valid for P-256)', () => {
    // secp384r1 (P-384) is a valid EC curve but NOT one ES256 supports —
    // `asymmetricKeyType === 'ec'` alone isn't enough to pick ES256.
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    config.CODE_STORAGE_PRIVATE_KEY = p384.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => mintCodeStorageJwt({ scopes: ['git:read'] })).toThrow(/unsupported/);
  });

  test('normalizeKeyPem: strips surrounding quotes and un-escapes literal \\n before signing', async () => {
    // Same PEM as the happy-path EC key, but stored the way a secret manager
    // / .env round-trip commonly mangles a PEM: wrapped in quotes with real
    // newlines flattened to the two-character sequence `\n`.
    const mangled = `"${EC_PRIVATE_PEM.trim().replace(/\n/g, '\\n')}"`;
    config.CODE_STORAGE_PRIVATE_KEY = mangled;
    const jwt = mintCodeStorageJwt({ repo: 'team/project-alpha', scopes: ['git:read'] });
    expect(decodeJwtHeader(jwt)).toEqual({ alg: 'ES256', typ: 'JWT' });
    // Verifiable against the ORIGINAL (un-mangled) public key — proves the
    // normalized PEM signs identically to the clean one.
    const key = await importSPKI(EC_PUBLIC_PEM, 'ES256');
    const { payload } = await jwtVerify(jwt, key);
    expect(payload.repo).toBe('team/project-alpha');
  });
});

describe('codeStorageGitAuthHeader', () => {
  test('Basic base64("t:<jwt>")', () => {
    const h = codeStorageGitAuthHeader('abc.def.ghi');
    expect(h.Authorization).toBe(`Basic ${Buffer.from('t:abc.def.ghi').toString('base64')}`);
  });
});

describe('isConfigured', () => {
  test('true once org + private key are set', async () => {
    expect(await codeStorageBackend.isConfigured()).toBe(true);
  });

  test('false with no org', async () => {
    config.CODE_STORAGE_ORG = '';
    expect(await codeStorageBackend.isConfigured()).toBe(false);
  });

  test('false with no private key', async () => {
    config.CODE_STORAGE_PRIVATE_KEY = '';
    expect(await codeStorageBackend.isConfigured()).toBe(false);
  });
});

describe('buildUpstream', () => {
  test('write scope: url + Basic header carrying a self-minted git:write+git:read token', () => {
    const up = codeStorageBackend.buildUpstream(ref(), null, 'write');
    expect(up.url).toBe('https://acme.code.storage/team/project-alpha.git');
    const [, encoded] = up.headers.Authorization!.split(' ');
    const [user, jwt] = Buffer.from(encoded!, 'base64').toString('utf8').split(':');
    expect(user).toBe('t');
    const payload = decodeJwtPayload(jwt!);
    expect(payload.repo).toBe('team/project-alpha');
    expect(payload.scopes).toEqual(['git:write', 'git:read']);
  });

  test('read scope: self-minted token scoped to git:read only', () => {
    const up = codeStorageBackend.buildUpstream(ref(), null, 'read');
    const [, encoded] = up.headers.Authorization!.split(' ');
    const [, jwt] = Buffer.from(encoded!, 'base64').toString('utf8').split(':');
    expect(decodeJwtPayload(jwt!).scopes).toEqual(['git:read']);
  });

  test('honors an already-resolved token instead of self-minting', () => {
    const up = codeStorageBackend.buildUpstream(ref(), 'pre-minted-token', 'write');
    const [, encoded] = up.headers.Authorization!.split(' ');
    expect(Buffer.from(encoded!, 'base64').toString('utf8')).toBe('t:pre-minted-token');
  });

  test('CODE_STORAGE_GIT_HOST override changes the remote host', () => {
    config.CODE_STORAGE_GIT_HOST = 'git.acme-cluster.example';
    const up = codeStorageBackend.buildUpstream(ref(), 'tok', 'read');
    expect(up.url).toBe('https://git.acme-cluster.example/team/project-alpha.git');
  });
});

describe('createRepo / deleteRepo (mocked HTTP)', () => {
  const originalFetch = globalThis.fetch;
  let requests: Array<{ url: string; init?: RequestInit }> = [];

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  beforeEach(() => {
    requests = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('createRepo: POST /api/repos with a repo-scoped repo:write bearer token, maps the response', async () => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
      requests.push({ url: href, init });
      return json({
        repo_id: 'repo_7f2b3d9',
        http_url: 'https://git.code.storage/acme/my-project',
        message: 'repository created',
      });
    }) as unknown as typeof fetch;

    const repo = await codeStorageBackend.createRepo({
      accountId: 'acct-1',
      projectId: 'proj-1',
      slug: 'my-project',
      defaultBranch: 'main',
      isPrivate: true,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://api.acme.code.storage/api/repos');
    expect(requests[0]!.init?.method).toBe('POST');
    const authHeader = (requests[0]!.init?.headers as Record<string, string>).Authorization;
    const token = authHeader!.replace('Bearer ', '');
    const payload = decodeJwtPayload(token);
    expect(payload.scopes).toEqual(['repo:write']);
    // Per the live create-repo.md schema (additionalProperties: false, no
    // `id` field): the target repo's identity comes from the JWT `repo`
    // claim, not the body — so the token MUST be repo-scoped to the slug.
    expect(payload.repo).toBe('my-project');
    const sentBody = JSON.parse(String(requests[0]!.init?.body));
    expect(sentBody).toEqual({ default_branch: 'main' });
    expect(sentBody).not.toHaveProperty('id');

    expect(repo.provider).toBe('code-storage');
    expect(repo.externalRepoId).toBe('repo_7f2b3d9');
    expect(repo.repoName).toBe('acme/my-project'); // parsed from http_url's path
    expect(repo.upstreamUrl).toBe('https://acme.code.storage/acme/my-project.git');
    expect(repo.defaultBranch).toBe('main');
    expect(repo.repoOwner).toBeNull();
    expect(repo.installationId).toBeNull();
    // initialToken: repo-scoped git:write(+read)
    expect(repo.initialToken).toBeTruthy();
    const initialPayload = decodeJwtPayload(repo.initialToken!);
    expect(initialPayload.repo).toBe('acme/my-project');
    expect(initialPayload.scopes).toEqual(['git:write', 'git:read']);
  });

  test('createRepo: falls back to the requested slug as repo path when http_url is missing', async () => {
    globalThis.fetch = (async () => json({ repo_id: 'repo_x', message: 'ok' })) as unknown as typeof fetch;
    const repo = await codeStorageBackend.createRepo({
      accountId: 'a',
      projectId: 'p',
      slug: 'fallback-slug',
      defaultBranch: 'main',
      isPrivate: true,
    });
    expect(repo.repoName).toBe('fallback-slug');
  });

  test('createRepo: throws with the RFC 9457 problem detail on failure', async () => {
    globalThis.fetch = (async () =>
      json({ type: 'about:blank', title: 'Conflict', status: 409, detail: 'repo already exists' }, 409)) as unknown as typeof fetch;
    await expect(
      codeStorageBackend.createRepo({
        accountId: 'a',
        projectId: 'p',
        slug: 'dup',
        defaultBranch: 'main',
        isPrivate: true,
      }),
    ).rejects.toThrow(/repo already exists/);
  });

  test('CODE_STORAGE_API_BASE override replaces the default https://api.<org>.code.storage host (trailing slash stripped)', async () => {
    config.CODE_STORAGE_API_BASE = 'https://mgmt.custom-cluster.example/';
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
      requests.push({ url: href, init });
      return json({ repo_id: 'repo_x', http_url: 'https://git.code.storage/acme/my-project', message: 'ok' });
    }) as unknown as typeof fetch;

    await codeStorageBackend.createRepo({
      accountId: 'a',
      projectId: 'p',
      slug: 'my-project',
      defaultBranch: 'main',
      isPrivate: true,
    });

    expect(requests[0]!.url).toBe('https://mgmt.custom-cluster.example/api/repos');
  });

  test('deleteRepo: DELETE /api/repos/{repoName} (URL-encoded) with a repo-scoped repo:write bearer token', async () => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
      requests.push({ url: href, init });
      return json({ repo_id: 'repo_7f2b3d9', message: 'deletion initiated' });
    }) as unknown as typeof fetch;

    await codeStorageBackend.deleteRepo(ref());

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(
      `https://api.acme.code.storage/api/repos/${encodeURIComponent('team/project-alpha')}`,
    );
    expect(requests[0]!.init?.method).toBe('DELETE');
    const token = (requests[0]!.init?.headers as Record<string, string>).Authorization!.replace('Bearer ', '');
    const payload = decodeJwtPayload(token);
    expect(payload.repo).toBe('team/project-alpha');
    expect(payload.scopes).toEqual(['repo:write']);
  });

  test('deleteRepo: 404 (already gone) is treated as success, not thrown', async () => {
    globalThis.fetch = (async () => json({ error: 'not found' }, 404)) as unknown as typeof fetch;
    await expect(codeStorageBackend.deleteRepo(ref())).resolves.toBeUndefined();
  });

  test('deleteRepo: 409 (delete already in flight) is treated as success', async () => {
    globalThis.fetch = (async () => json({ error: 'conflict' }, 409)) as unknown as typeof fetch;
    await expect(codeStorageBackend.deleteRepo(ref())).resolves.toBeUndefined();
  });

  test('deleteRepo: other failures throw', async () => {
    globalThis.fetch = (async () => json({ error: 'forbidden' }, 403)) as unknown as typeof fetch;
    await expect(codeStorageBackend.deleteRepo(ref())).rejects.toThrow(/forbidden/);
  });

  test('deleteRepo: no-op when the ref has no repo identifier at all', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return json({});
    }) as unknown as typeof fetch;
    await codeStorageBackend.deleteRepo(ref({ repoName: null, externalRepoId: null }));
    expect(called).toBe(false);
  });

  test('deleteRepo: throws instead of using externalRepoId as the {repo_name} path when repoName is missing', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return json({});
    }) as unknown as typeof fetch;
    // `externalRepoId` is code.storage's opaque internal repo_id — never a
    // valid `{repo_name}` path segment. Silently substituting it (the old
    // behavior) would call DELETE against the wrong resource.
    await expect(
      codeStorageBackend.deleteRepo(ref({ repoName: null, externalRepoId: 'repo_7f2b3d9' })),
    ).rejects.toThrow(/missing repoName/);
    expect(called).toBe(false);
  });
});

describe('seedFiles (mocked HTTP, commit-pack ndjson)', () => {
  const originalFetch = globalThis.fetch;
  let bodies: string[] = [];
  let urls: string[] = [];
  let headersSeen: Array<Record<string, string>> = [];

  beforeEach(() => {
    bodies = [];
    urls = [];
    headersSeen = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
      urls.push(href);
      bodies.push(String(init?.body ?? ''));
      headersSeen.push((init?.headers as Record<string, string>) ?? {});
      return new Response(
        JSON.stringify({
          commit: { commit_sha: 'sha1', tree_sha: 'tree1', target_branch: 'main', pack_bytes: 10, blob_count: 1 },
          result: { branch: 'main', old_sha: '0'.repeat(40), new_sha: 'sha1', success: true, status: 'ok' },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function parseNdjson(body: string) {
    return body.trim().split('\n').map((line) => JSON.parse(line));
  }

  test('single commit when there are no baseFiles', async () => {
    await codeStorageBackend.seedFiles!(
      ref(),
      'git-write-token',
      [{ path: 'README.md', content: '# hello' }],
      { branch: 'main', message: 'chore: scaffold Kortix project' },
    );

    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe(
      `https://api.acme.code.storage/api/repos/${encodeURIComponent('team/project-alpha')}/commit-pack`,
    );
    const lines = parseNdjson(bodies[0]!);
    expect(lines[0].metadata.target_branch).toBe('main');
    expect(lines[0].metadata.commit_message).toBe('chore: scaffold Kortix project');
    expect(lines[0].metadata.files).toEqual([
      { path: 'README.md', operation: 'upsert', content_id: 'blob-0', mode: '100644' },
    ]);
    expect(lines[0].metadata).not.toHaveProperty('expected_head_sha');
    expect(lines[1].blob_chunk.content_id).toBe('blob-0');
    expect(Buffer.from(lines[1].blob_chunk.data, 'base64').toString('utf8')).toBe('# hello');
    expect(lines[1].blob_chunk.eof).toBe(true);
  });

  test('two sequential commits when baseFiles is set: deterministic scaffold, then project files', async () => {
    await codeStorageBackend.seedFiles!(
      ref(),
      'git-write-token',
      [{ path: 'kortix.yaml', content: 'name: my-project' }],
      {
        branch: 'main',
        message: 'ignored when baseFiles present',
        baseFiles: [{ path: '.kortix/agent.md', content: 'base scaffold' }],
      },
    );

    expect(urls).toHaveLength(2);
    const first = parseNdjson(bodies[0]!);
    expect(first[0].metadata.commit_message).toBe('chore: scaffold Kortix project');
    expect(first[0].metadata.files[0].path).toBe('.kortix/agent.md');

    const second = parseNdjson(bodies[1]!);
    expect(second[0].metadata.commit_message).toBe('chore: project setup');
    expect(second[0].metadata.files[0].path).toBe('kortix.yaml');
  });

  test('uses the caller-supplied token as the bearer credential (never self-mints)', async () => {
    await codeStorageBackend.seedFiles!(
      ref(),
      'caller-token-123',
      [{ path: 'a.txt', content: 'x' }],
      { branch: 'main', message: 'msg' },
    );
    expect(headersSeen[0]!.Authorization).toBe('Bearer caller-token-123');
    expect(headersSeen[0]!['Content-Type']).toBe('application/x-ndjson');
  });

  test('throws when the connection ref has no repo path', async () => {
    await expect(
      codeStorageBackend.seedFiles!(ref({ repoName: null }), 'tok', [{ path: 'a', content: 'b' }], {
        branch: 'main',
        message: 'm',
      }),
    ).rejects.toThrow(/missing a repo path/);
  });

  test('propagates a commit-pack failure (e.g. 409 branch-moved conflict)', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ result: { branch: 'main', message: 'expected branch head did not match current tip', success: false, status: 'precondition_failed' } }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch;
    await expect(
      codeStorageBackend.seedFiles!(ref(), 'tok', [{ path: 'a', content: 'b' }], { branch: 'main', message: 'm' }),
    ).rejects.toThrow(/did not match current tip/);
  });
});
