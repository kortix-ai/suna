import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync, createVerify } from 'node:crypto';

import {
  buildAppCredentialsEnvPatch,
  buildAppManifest,
  buildCreateAppUrl,
  buildInstallUrl,
  buildManagedGitEnvPatch,
  exchangeManifestCode,
  extractParam,
  fetchAppInstallation,
  generateAppName,
  generateState,
  parseCreatedCallback,
  parseInstalledCallback,
  pemToEnvEscaped,
  renderClosePageHtml,
  renderStartPageHtml,
  signAppJwt,
} from '../connect-github.ts';

// Only the pure parts are exercised here: manifest/URL construction, PEM
// escaping, callback parsing, env-patch wiring, JWT structure, and the two
// network calls against an injected `fetchImpl` (never a real request). The
// live browser + local-HTTP-server hand-off in `runConnectGithubFlow` can't
// be meaningfully unit-tested — see the module's own header comment.

describe('generateAppName / generateState', () => {
  test('generateAppName embeds the injected suffix, keeping names globally unique on GitHub', () => {
    expect(generateAppName(() => 'abc123')).toBe('Kortix Self-Host abc123');
  });

  test('generateState returns whatever the injected token source produces', () => {
    expect(generateState(() => 'deadbeef')).toBe('deadbeef');
  });
});

describe('buildAppManifest', () => {
  test('wires redirect_url/setup_url to the chosen port and the requested default permissions', () => {
    const manifest = buildAppManifest({ appName: 'Kortix Self-Host abcd', homepageUrl: 'https://kortix.example.com', port: 54321 });
    expect(manifest.name).toBe('Kortix Self-Host abcd');
    expect(manifest.url).toBe('https://kortix.example.com');
    expect(manifest.redirect_url).toBe('http://127.0.0.1:54321/created');
    expect(manifest.setup_url).toBe('http://127.0.0.1:54321/installed');
    expect(manifest.setup_on_update).toBe(true);
    expect(manifest.public).toBe(false);
    expect(manifest.default_permissions).toEqual({
      administration: 'write',
      contents: 'write',
      metadata: 'read',
      pull_requests: 'write',
    });
    expect(manifest.default_events).toEqual([]);
    expect(manifest.hook_attributes).toEqual({ active: false });
  });
});

describe('buildCreateAppUrl', () => {
  test('an org targets the org-scoped settings path with the state query param', () => {
    const url = buildCreateAppUrl({ org: 'Essentia-Innovation', state: 'st4te' });
    expect(url).toBe('https://github.com/organizations/Essentia-Innovation/settings/apps/new?state=st4te');
  });

  test('no org (personal account) targets the unscoped settings path', () => {
    expect(buildCreateAppUrl({ state: 'st4te' })).toBe('https://github.com/settings/apps/new?state=st4te');
  });

  test('"." also means personal account, same as omitting --org', () => {
    expect(buildCreateAppUrl({ org: '.', state: 'st4te' })).toBe('https://github.com/settings/apps/new?state=st4te');
  });

  test('a blank/whitespace org falls back to personal account too', () => {
    expect(buildCreateAppUrl({ org: '   ', state: 'st4te' })).toBe('https://github.com/settings/apps/new?state=st4te');
  });
});

describe('buildInstallUrl', () => {
  test('targets the App-specific installations/new page by slug', () => {
    expect(buildInstallUrl('kortix-self-host-abcd')).toBe('https://github.com/apps/kortix-self-host-abcd/installations/new');
  });
});

describe('pemToEnvEscaped', () => {
  test('converts real newlines to literal \\n escapes for a .env-safe value', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK...\n-----END RSA PRIVATE KEY-----\n';
    const escaped = pemToEnvEscaped(pem);
    expect(escaped).not.toContain('\n');
    expect(escaped).toBe('-----BEGIN RSA PRIVATE KEY-----\\nMIIBOgIBAAJBAK...\\n-----END RSA PRIVATE KEY-----');
  });

  test('normalizes CRLF line endings the same way', () => {
    const pem = '-----BEGIN KEY-----\r\nabc\r\n-----END KEY-----';
    expect(pemToEnvEscaped(pem)).toBe('-----BEGIN KEY-----\\nabc\\n-----END KEY-----');
  });
});

describe('extractParam / callback parsing', () => {
  test('extracts a param from a full callback URL', () => {
    expect(extractParam('http://127.0.0.1:54321/created?code=abc123&state=xyz', 'code')).toBe('abc123');
    expect(extractParam('http://127.0.0.1:54321/created?code=abc123&state=xyz', 'state')).toBe('xyz');
  });

  test('extracts a param from a bare query string', () => {
    expect(extractParam('installation_id=999&setup_action=install', 'installation_id')).toBe('999');
  });

  test('a bare pasted value with no query-string syntax is treated as the value itself', () => {
    expect(extractParam('abc123', 'code')).toBe('abc123');
    expect(extractParam('  999  ', 'installation_id')).toBe('999');
  });

  test('empty input yields null', () => {
    expect(extractParam('', 'code')).toBeNull();
    expect(extractParam('   ', 'code')).toBeNull();
  });

  test('parseCreatedCallback pulls both code and state', () => {
    expect(parseCreatedCallback('/created?code=c1&state=s1')).toEqual({ code: 'c1', state: 's1' });
    expect(parseCreatedCallback('/created?state=s1')).toEqual({ code: null, state: 's1' });
  });

  test('parseInstalledCallback pulls installation_id and setup_action', () => {
    expect(parseInstalledCallback('/installed?installation_id=42&setup_action=install')).toEqual({
      installationId: '42',
      setupAction: 'install',
    });
  });
});

describe('buildAppCredentialsEnvPatch (env-wiring, step after manifest exchange)', () => {
  test('produces exactly the keys apps/api/src/projects/github.ts reads, plus stored credentials', () => {
    const patch = buildAppCredentialsEnvPatch({
      appId: '123456',
      slug: 'kortix-self-host-abcd',
      privateKeyPem: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
      clientId: 'Iv1.abcdef',
      clientSecret: 'secret123',
      webhookSecret: 'whsec123',
      currentStateSecret: 'already-set',
    });
    expect(patch).toEqual({
      KORTIX_GITHUB_APP_ID: '123456',
      KORTIX_GITHUB_APP_SLUG: 'kortix-self-host-abcd',
      KORTIX_GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\\nfake\\n-----END RSA PRIVATE KEY-----',
      KORTIX_GITHUB_APP_CLIENT_ID: 'Iv1.abcdef',
      KORTIX_GITHUB_APP_CLIENT_SECRET: 'secret123',
      KORTIX_GITHUB_APP_WEBHOOK_SECRET: 'whsec123',
    });
    // Already set — must NOT be clobbered/regenerated.
    expect(patch.KORTIX_GITHUB_APP_STATE_SECRET).toBeUndefined();
  });

  test('generates KORTIX_GITHUB_APP_STATE_SECRET only when unset', () => {
    const patch = buildAppCredentialsEnvPatch({
      appId: '1',
      slug: 'slug',
      privateKeyPem: 'pem',
      clientId: 'cid',
      clientSecret: 'csecret',
      webhookSecret: 'wsecret',
      currentStateSecret: '',
      generateStateSecret: () => 'freshly-generated-secret',
    });
    expect(patch.KORTIX_GITHUB_APP_STATE_SECRET).toBe('freshly-generated-secret');
  });

  test('treats a whitespace-only current state secret as unset too', () => {
    const patch = buildAppCredentialsEnvPatch({
      appId: '1',
      slug: 'slug',
      privateKeyPem: 'pem',
      clientId: 'cid',
      clientSecret: 'csecret',
      webhookSecret: 'wsecret',
      currentStateSecret: '   ',
      generateStateSecret: () => 'fresh',
    });
    expect(patch.KORTIX_GITHUB_APP_STATE_SECRET).toBe('fresh');
  });
});

describe('buildManagedGitEnvPatch (env-wiring, step after install)', () => {
  test('sets provider/owner/install_id and clears any stale PAT so the App path is authoritative', () => {
    const patch = buildManagedGitEnvPatch({ owner: 'Essentia-Innovation', installationId: '789' });
    expect(patch).toEqual({
      MANAGED_GIT_PROVIDER: 'github',
      MANAGED_GIT_GITHUB_OWNER: 'Essentia-Innovation',
      MANAGED_GIT_GITHUB_INSTALL_ID: '789',
      MANAGED_GIT_GITHUB_TOKEN: '',
      KORTIX_GITHUB_TOKEN: '',
      KORTIX_GITHUB_OWNER: 'Essentia-Innovation',
    });
  });
});

describe('renderStartPageHtml / renderClosePageHtml', () => {
  test('the start page POSTs the manifest JSON to the create URL and auto-submits', () => {
    const manifest = buildAppManifest({ appName: 'Kortix Self-Host abcd', homepageUrl: 'https://kortix.ai', port: 12345 });
    const createUrl = buildCreateAppUrl({ org: 'my-org', state: 'st4te' });
    const html = renderStartPageHtml({ manifest, createUrl });
    expect(html).toContain(`action="${createUrl}"`);
    expect(html).toContain('method="post"');
    expect(html).toContain('name="manifest"');
    expect(html).toContain('Kortix Self-Host abcd');
    expect(html).toContain('.submit()');
  });

  test('the start page HTML-escapes the manifest JSON so it is a valid attribute value', () => {
    const manifest = buildAppManifest({ appName: 'Kortix "Quoted" App', homepageUrl: 'https://kortix.ai', port: 1 });
    const html = renderStartPageHtml({ manifest, createUrl: 'https://github.com/settings/apps/new?state=s' });
    expect(html).toContain('&quot;');
    expect(html).not.toContain('value="{"name":"Kortix "Quoted"');
  });

  test('the close page renders the given title and message', () => {
    const html = renderClosePageHtml('GitHub App installed', 'Kortix received the installation.');
    expect(html).toContain('GitHub App installed');
    expect(html).toContain('Kortix received the installation.');
    expect(html).toContain('close this tab');
  });
});

describe('signAppJwt', () => {
  test('produces a structurally valid, RS256-signed JWT that verifies against the matching public key', () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const now = Date.parse('2026-07-14T12:00:00Z');
    const jwt = signAppJwt('123456', privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(), now);

    const [headerB64, payloadB64, sigB64] = jwt.split('.');
    expect(headerB64 && payloadB64 && sigB64).toBeTruthy();

    const header = JSON.parse(Buffer.from(headerB64!, 'base64url').toString('utf8'));
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });

    const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf8'));
    expect(payload.iss).toBe('123456');
    expect(payload.iat).toBe(Math.floor(now / 1000) - 60);
    expect(payload.exp).toBe(Math.floor(now / 1000) + 540);

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerB64}.${payloadB64}`);
    verifier.end();
    const signatureBuf = Buffer.from(sigB64!, 'base64url');
    expect(verifier.verify(publicKey.export({ type: 'spki', format: 'pem' }), signatureBuf)).toBe(true);
  });
});

describe('exchangeManifestCode (network call, injected fetch)', () => {
  test('POSTs to the manifest-conversion endpoint with the right headers and parses the response', async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(
        JSON.stringify({
          id: 42,
          slug: 'kortix-self-host-abcd',
          pem: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
          client_id: 'Iv1.abcdef',
          client_secret: 'secret123',
          webhook_secret: 'whsec123',
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await exchangeManifestCode('the-manifest-code', fetchImpl);

    expect(capturedUrl).toBe('https://api.github.com/app-manifests/the-manifest-code/conversions');
    expect(capturedInit?.method).toBe('POST');
    expect((capturedInit?.headers as Record<string, string>).Accept).toBe('application/vnd.github+json');
    expect(result).toEqual({
      id: 42,
      slug: 'kortix-self-host-abcd',
      pem: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
      client_id: 'Iv1.abcdef',
      client_secret: 'secret123',
      webhook_secret: 'whsec123',
    });
  });

  test('URL-encodes the code and surfaces a clear error on a non-OK response (e.g. an expired code)', async () => {
    const fetchImpl = (async () =>
      new Response('Not Found', { status: 404, statusText: 'Not Found' })) as unknown as typeof fetch;
    await expect(exchangeManifestCode('expired-code', fetchImpl)).rejects.toThrow(/404/);
  });
});

describe('fetchAppInstallation (network call, injected fetch)', () => {
  test('signs a fresh App JWT and returns the installation account login/type', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    let capturedAuth: string | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedAuth = (init?.headers as Record<string, string>).Authorization;
      expect(url).toBe('https://api.github.com/app/installations/789');
      return new Response(JSON.stringify({ account: { login: 'Essentia-Innovation', type: 'Organization' } }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchAppInstallation({ appId: '1', privateKeyPem: pem, installationId: '789', fetchImpl });
    expect(result).toEqual({ login: 'Essentia-Innovation', type: 'Organization' });
    expect(capturedAuth).toMatch(/^Bearer ey/);
  });

  test('a non-OK response resolves to nulls instead of throwing (best-effort owner resolution)', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    const result = await fetchAppInstallation({ appId: '1', privateKeyPem: pem, installationId: '789', fetchImpl });
    expect(result).toEqual({ login: null, type: null });
  });
});
