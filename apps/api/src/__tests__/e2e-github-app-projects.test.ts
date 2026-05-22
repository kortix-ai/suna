import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  buildGitHubAppInstallUrl,
  commitFile,
  createGitHubAppJwt,
  createInstallationToken,
  createRepo,
  getFileSha,
  getGitHubAppInstallation,
} from '../projects/github';
import { runWithContext } from '../lib/request-context';

const originalFetch = globalThis.fetch;
const envKeys = [
  'KORTIX_GITHUB_APP_ID',
  'KORTIX_GITHUB_APP_PRIVATE_KEY',
  'KORTIX_GITHUB_APP_SLUG',
  'KORTIX_GITHUB_TOKEN',
  'GITHUB_TOKEN',
] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

let requests: Array<{ url: string; init?: RequestInit }> = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function resetEnv() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.KORTIX_GITHUB_APP_ID = '12345';
  process.env.KORTIX_GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  process.env.KORTIX_GITHUB_APP_SLUG = 'kortix-test-app';
  delete process.env.KORTIX_GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
}

function restoreEnv() {
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('GitHub App project repository auth', () => {
  beforeEach(() => {
    resetEnv();
    requests = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
      requests.push({ url: href, init });

      if (href.endsWith('/app/installations/42')) {
        return json({
          id: 42,
          account: { login: 'kortix-org', type: 'Organization' },
          target_type: 'Organization',
          repository_selection: 'all',
          permissions: { contents: 'write', metadata: 'read' },
          html_url: 'https://github.com/organizations/kortix-org/settings/installations/42',
        });
      }

      if (href.endsWith('/app/installations/42/access_tokens')) {
        return json({
          token: 'installation-token',
          expires_at: '2026-01-01T00:00:00Z',
          permissions: { contents: 'write', metadata: 'read' },
          repository_selection: 'all',
        });
      }

      if (href.endsWith('/orgs/kortix-org/repos')) {
        return json({
          id: 7,
          name: 'company-os',
          full_name: 'kortix-org/company-os',
          private: true,
          html_url: 'https://github.com/kortix-org/company-os',
          clone_url: 'https://github.com/kortix-org/company-os.git',
          ssh_url: 'git@github.com:kortix-org/company-os.git',
          default_branch: 'main',
          description: null,
        });
      }

      if (href.includes('/repos/kortix-org/company-os/contents/README.md')) {
        if (init?.method === 'PUT') return json({ content: { path: 'README.md' } });
        return json({ sha: 'existing-readme-sha' });
      }

      return json({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  test('creates a signed GitHub App JWT and install URL', () => {
    const token = createGitHubAppJwt(Date.UTC(2026, 0, 1, 0, 0, 0));
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    expect(payload.iss).toBe('12345');
    expect(payload.exp - payload.iat).toBe(600);

    // The install state is now a signed token (v1.<payload>.<sig>) carrying the
    // account id, not a bare account id — verify structure + decoded account.
    const installUrl = buildGitHubAppInstallUrl('account-1');
    expect(installUrl).toBeTruthy();
    expect(installUrl!.startsWith('https://github.com/apps/kortix-test-app/installations/new?state=')).toBe(true);
    const state = new URL(installUrl!).searchParams.get('state')!;
    expect(state.startsWith('v1.')).toBe(true);
    const statePayload = JSON.parse(Buffer.from(state.split('.')[1]!, 'base64url').toString('utf8'));
    expect(statePayload.account_id).toBe('account-1');
  });

  test('verifies installation metadata with the app JWT', async () => {
    const installation = await getGitHubAppInstallation('42');
    expect(installation.account?.login).toBe('kortix-org');
    expect(requests[0]?.url).toBe('https://api.github.com/app/installations/42');
    expect((requests[0]?.init?.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
  });

  test('propagates request trace headers to GitHub API calls', async () => {
    await runWithContext(
      'POST',
      '/v1/projects/create-repo',
      async () => {
        await getGitHubAppInstallation('42');
      },
      '00-55555555555555555555555555555555-6666666666666666-01',
    );

    const headers = requests[0]?.init?.headers as Record<string, string>;
    expect(headers.traceparent).toMatch(/^00-55555555555555555555555555555555-[0-9a-f]{16}-01$/);
    expect(headers['X-Request-Id']).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
  });

  test('mints installation tokens with the app JWT', async () => {
    const token = await createInstallationToken('42');
    expect(token.token).toBe('installation-token');
    expect(requests[0]?.url).toBe('https://api.github.com/app/installations/42/access_tokens');
    expect(requests[0]?.init?.method).toBe('POST');
    expect((requests[0]?.init?.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
  });

  test('uses the account installation token for repo create and starter commits', async () => {
    const auth = {
      token: 'installation-token',
      source: 'app_installation' as const,
      owner: 'kortix-org',
      ownerType: 'Organization',
      installationId: '42',
    };

    const repo = await createRepo({
      name: 'company-os',
      isPrivate: true,
      autoInit: true,
      auth,
    });
    expect(repo.full_name).toBe('kortix-org/company-os');

    const sha = await getFileSha({
      owner: 'kortix-org',
      repo: 'company-os',
      path: 'README.md',
      branch: 'main',
      auth,
    });
    expect(sha).toBe('existing-readme-sha');

    await commitFile({
      owner: 'kortix-org',
      repo: 'company-os',
      path: 'README.md',
      content: '# Company OS',
      message: 'chore: scaffold README.md',
      branch: 'main',
      existingSha: sha ?? undefined,
      auth,
    });

    const repoCreate = requests.find((request) => request.url.endsWith('/orgs/kortix-org/repos'));
    const readFile = requests.find((request) => request.init?.method !== 'PUT' && request.url.includes('/contents/README.md'));
    const writeFile = requests.find((request) => request.init?.method === 'PUT' && request.url.includes('/contents/README.md'));

    expect((repoCreate?.init?.headers as Record<string, string>).Authorization).toBe('Bearer installation-token');
    expect((readFile?.init?.headers as Record<string, string>).Authorization).toBe('Bearer installation-token');
    expect((writeFile?.init?.headers as Record<string, string>).Authorization).toBe('Bearer installation-token');
  });
});
