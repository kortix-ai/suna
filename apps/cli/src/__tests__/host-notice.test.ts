import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderContext, renderHostNotice } from '../host-notice.ts';
import { clearTokenIdentityCache } from '../api/token-identity.ts';

const ENV_KEYS = [
  'KORTIX_TOKEN',
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
let savedCwd: string;

beforeEach(() => {
  saved = {};
  savedCwd = process.cwd();
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
  clearTokenIdentityCache();
});

afterEach(() => {
  process.chdir(savedCwd);
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  clearTokenIdentityCache();
});

function writeConfig(hosts: Record<string, unknown>, active = 'cloud'): string {
  const dir = mkdtempSync(join(tmpdir(), 'kortix-cli-banner-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ active, hosts }, null, 2));
  process.env.KORTIX_CONFIG_FILE = file;
  return dir;
}

/** A logged-out `cloud` host — exactly what a sandbox sees, since the sandbox
 *  never runs `kortix login` and gets its credential from the environment. */
const LOGGED_OUT_CLOUD = {
  cloud: {
    url: 'https://api.kortix.com',
    token: '',
    user_id: '',
    user_email: '',
    account_id: '',
    logged_in_at: '',
  },
};

/** Create a linked project directory and chdir into it, as every sandbox
 *  workspace is (`.kortix/link.json` is committed by `kortix init`). */
function enterLinkedProject(host: string, accountId: string, projectId: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'kortix-cli-linked-'));
  mkdirSync(join(dir, '.kortix'), { recursive: true });
  writeFileSync(
    join(dir, '.kortix', 'link.json'),
    JSON.stringify({
      project_id: projectId,
      account_id: accountId,
      host,
      host_url: 'https://api.kortix.com',
      linked_at: '2026-07-13T17:06:24.828Z',
    }),
  );
  process.chdir(dir);
  return dir;
}

/** Seed the token-identity cache the way a real `/accounts/me` response would
 *  (see api/client.ts captureIdentity), without a network call. */
function seedTokenIdentity(token: string, agent: string): void {
  const configFile = process.env.KORTIX_CONFIG_FILE!;
  const key = createHash('sha256').update(token).digest('hex').slice(0, 16);
  writeFileSync(
    join(configFile, '..', 'token-identity.json'),
    JSON.stringify({
      entries: {
        [key]: {
          identity: {
            authType: 'pat',
            agent,
            projectId: 'proj_123',
            sessionId: 'sess_123',
            kortixCli: ['project.secret.read', 'project.secret.write'],
            userId: 'user_123',
            userEmail: 'agent@example.com',
          },
          fetchedAt: Date.now(),
        },
      },
    }),
  );
  clearTokenIdentityCache();
}

describe('host notice', () => {
  test('shows env-provided sandbox host and project-token auth instead of logged-out config host', () => {
    const dir = writeConfig({
      cloud: {
        url: 'https://api.kortix.com',
        token: '',
        user_id: '',
        user_email: '',
        account_id: '',
        logged_in_at: '',
      },
    });
    try {
      process.env.KORTIX_API_URL = 'https://dev-api.kortix.com/v1';
      process.env.KORTIX_TOKEN = 'kortix_pat_project';
      process.env.KORTIX_PROJECT_ID = 'proj_123';

      const notice = renderHostNotice(['whoami']);
      expect(notice).toContain('host sandbox');
      expect(notice).toContain('https://dev-api.kortix.com/v1');
      expect(notice).toContain('authenticated (project token)');
      expect(notice).not.toContain('https://api.kortix.com');
      expect(notice).not.toContain('not logged in');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('shows KORTIX_API_URL override for stored user auth', () => {
    const dir = writeConfig({
      cloud: {
        url: 'https://api.kortix.com',
        token: 'kortix_pat_user',
        user_id: 'user_123',
        user_email: 'user@example.com',
        account_id: 'acct_123',
        logged_in_at: '2026-01-01T00:00:00.000Z',
      },
    });
    try {
      process.env.KORTIX_API_URL = 'https://dev-api.kortix.com/v1';

      const notice = renderHostNotice(['whoami']);
      expect(notice).toContain('host env');
      expect(notice).toContain('https://dev-api.kortix.com/v1');
      expect(notice).toContain('user@example.com (user)');
      expect(notice).not.toContain('https://api.kortix.com');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('shows session-token auth when sandbox env includes a session id', () => {
    const dir = writeConfig({
      cloud: {
        url: 'https://api.kortix.com',
        token: '',
        user_id: '',
        user_email: '',
        account_id: '',
        logged_in_at: '',
      },
    });
    try {
      process.env.KORTIX_API_URL = 'https://api.kortix.com/v1';
      process.env.KORTIX_TOKEN = 'kortix_pat_session';
      process.env.KORTIX_PROJECT_ID = 'proj_123';
      process.env.KORTIX_SESSION_ID = 'sess_123';

      const notice = renderHostNotice(['whoami']);
      expect(notice).toContain('host sandbox');
      expect(notice).toContain('authenticated (session token)');
      expect(notice).not.toContain('authenticated (project token)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--host display uses the requested stored host instead of sandbox env auth', () => {
    const dir = writeConfig(
      {
        customdev: {
          url: 'https://dev-api.kortix.com/v1',
          token: 'kortix_pat_user',
          user_id: 'user_123',
          user_email: 'dev@example.com',
          account_id: 'acct_123',
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
      'customdev',
    );
    try {
      process.env.KORTIX_API_URL = 'https://sandbox-api.kortix.test/v1';
      process.env.KORTIX_TOKEN = 'kortix_pat_project';

      const notice = renderHostNotice(['whoami', '--host', 'customdev']);
      expect(notice).toContain('host customdev');
      expect(notice).toContain('https://dev-api.kortix.com/v1');
      expect(notice).toContain('dev@example.com (user)');
      expect(notice).not.toContain('https://sandbox-api.kortix.test/v1');
      expect(notice).not.toContain('project token');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Regression: a sandbox workspace ALWAYS carries `.kortix/link.json`, whose
  // named host has no stored credentials there. Reading it for the auth state
  // reported a fully-authenticated agent CLI as "not logged in" on every
  // command, which is what sent an agent hunting for a login problem instead of
  // a missing grant.
  test('linked directory does not override sandbox env auth', () => {
    const configDir = writeConfig(LOGGED_OUT_CLOUD);
    const projectDir = enterLinkedProject('cloud', 'acct_3b1fc472', 'proj_508bccdd');
    try {
      process.env.KORTIX_API_URL = 'https://api.kortix.com';
      process.env.KORTIX_TOKEN = 'kortix_pat_session';
      process.env.KORTIX_SESSION_ID = 'sess_ea985b87';

      const notice = renderHostNotice(['sessions', 'restart', 'sess_ea985b87']);
      expect(notice).toContain('authenticated (session token)');
      expect(notice).not.toContain('not logged in');
      // The link still supplies account + project; only the auth state moved.
      expect(notice).toContain('account acct_3b1');
      expect(notice).toContain('project proj_508');
      expect(notice).toContain('session sess_ea9');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('names the agent a minted session token belongs to', () => {
    const configDir = writeConfig(LOGGED_OUT_CLOUD);
    const projectDir = enterLinkedProject('cloud', 'acct_3b1fc472', 'proj_508bccdd');
    try {
      process.env.KORTIX_API_URL = 'https://api.kortix.com';
      process.env.KORTIX_TOKEN = 'kortix_pat_session';
      process.env.KORTIX_SESSION_ID = 'sess_ea985b87';
      seedTokenIdentity('kortix_pat_session', 'osp-vision-route-agent');

      expect(renderHostNotice(['sessions', 'restart', 'x'])).toContain(
        'agent osp-vision-route-agent',
      );
      // The bare-`kortix` hierarchy names it too, on its own row.
      const context = renderContext();
      expect(context).toContain('agent');
      expect(context).toContain('osp-vision-route-agent');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('omits the agent row when the token identity is not cached', () => {
    const configDir = writeConfig(LOGGED_OUT_CLOUD);
    try {
      process.env.KORTIX_API_URL = 'https://api.kortix.com';
      process.env.KORTIX_TOKEN = 'kortix_pat_session';
      process.env.KORTIX_SESSION_ID = 'sess_ea985b87';

      const notice = renderHostNotice(['sessions', 'ls']);
      expect(notice).toContain('authenticated (session token)');
      expect(notice).not.toContain('agent ');
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
