import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cachedTokenIdentity,
  clearTokenIdentityCache,
  formatGrantList,
  identityFromMe,
  rememberTokenIdentity,
  tokenKindLabel,
} from '../api/token-identity.ts';
import {
  printPermissionDenialIdentity,
  recordPermissionDenial,
  resetPermissionDenial,
} from '../token-denial.ts';
import type { MeResponse } from '../api/types.ts';

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
let dir: string;

/** An `/accounts/me` body for a minted agent session token — the exact shape
 *  the API returns for the SampleCo `osp-vision-route-agent` case. */
function agentMe(): MeResponse {
  return {
    user_id: 'user_123',
    email: 'owner@example.com',
    token_context: {
      auth_type: 'pat',
      project_id: '508bccdd-1edb-4c61-877b-164aceac20e2',
      session_id: 'ea985b87-d12c-4ba4-aa12-ee0711dab6f6',
      agent: 'osp-vision-route-agent',
      connectors: [],
      kortix_permissions: ['project.secret.read', 'project.secret.write'],
      kortix_cli: ['project.secret.read', 'project.secret.write'],
    },
    accounts: [],
  };
}

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
  dir = mkdtempSync(join(tmpdir(), 'kortix-token-identity-'));
  process.env.KORTIX_CONFIG_FILE = join(dir, 'config.json');
  clearTokenIdentityCache();
  resetPermissionDenial();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  clearTokenIdentityCache();
  resetPermissionDenial();
});

describe('token identity cache', () => {
  test('remembers what a token resolves to and reads it back', () => {
    rememberTokenIdentity('kortix_pat_session', agentMe());
    clearTokenIdentityCache(); // force a disk read, not the in-process memo

    const identity = cachedTokenIdentity('kortix_pat_session');
    expect(identity?.agent).toBe('osp-vision-route-agent');
    expect(identity?.sessionId).toBe('ea985b87-d12c-4ba4-aa12-ee0711dab6f6');
    expect(identity?.permissions).toEqual(['project.secret.read', 'project.secret.write']);
  });

  test('reads the grant from a pre-rename API that only sends kortix_cli', () => {
    const me = agentMe();
    delete (me.token_context as { kortix_permissions?: unknown }).kortix_permissions;
    expect(identityFromMe(me).permissions).toEqual(['project.secret.read', 'project.secret.write']);
  });

  test('reads a cache entry written before the rename (kortixCli key)', () => {
    writeFileSync(
      join(dir, 'token-identity.json'),
      JSON.stringify({
        entries: {
          [createHash('sha256').update('kortix_pat_legacy').digest('hex').slice(0, 16)]: {
            fetchedAt: Date.now(),
            identity: {
              authType: 'pat',
              agent: 'a',
              projectId: 'p',
              sessionId: 's',
              kortixCli: 'all',
              userId: 'u',
              userEmail: 'e',
            },
          },
        },
      }),
    );
    clearTokenIdentityCache();
    const identity = cachedTokenIdentity('kortix_pat_legacy');
    expect(identity?.permissions).toBe('all');
    expect(identity).not.toHaveProperty('kortixCli');
  });

  test('never writes the token itself to disk, and keeps the file 0600', () => {
    rememberTokenIdentity('kortix_pat_supersecret', agentMe());
    const path = join(dir, 'token-identity.json');
    const raw = readFileSync(path, 'utf8');

    expect(raw).not.toContain('kortix_pat_supersecret');
    expect(raw).toContain('osp-vision-route-agent');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('a re-minted token misses the cache instead of showing a stale agent', () => {
    rememberTokenIdentity('kortix_pat_old', agentMe());
    clearTokenIdentityCache();

    expect(cachedTokenIdentity('kortix_pat_old')?.agent).toBe('osp-vision-route-agent');
    expect(cachedTokenIdentity('kortix_pat_new')).toBeNull();
  });

  test('an expired entry is a miss, but the error path can still read it', () => {
    rememberTokenIdentity('kortix_pat_session', agentMe());
    const path = join(dir, 'token-identity.json');
    const file = JSON.parse(readFileSync(path, 'utf8')) as {
      entries: Record<string, { fetchedAt: number }>;
    };
    for (const entry of Object.values(file.entries)) {
      entry.fetchedAt = Date.now() - 60 * 60 * 1000; // 1h — past the 15m TTL
    }
    writeFileSync(path, JSON.stringify(file));
    clearTokenIdentityCache();

    expect(cachedTokenIdentity('kortix_pat_session')).toBeNull();
    expect(cachedTokenIdentity('kortix_pat_session', { allowStale: true })?.agent).toBe(
      'osp-vision-route-agent',
    );
  });

  test('a corrupt cache file is an empty cache, not a crash', () => {
    writeFileSync(join(dir, 'token-identity.json'), '{ not json');
    expect(cachedTokenIdentity('kortix_pat_session')).toBeNull();
  });

  test('labels a token by what it is', () => {
    expect(tokenKindLabel(identityFromMe(agentMe()))).toBe(
      'session token · agent osp-vision-route-agent',
    );
    expect(
      tokenKindLabel({
        authType: 'supabase',
        agent: null,
        projectId: null,
        sessionId: null,
        permissions: null,
        userId: 'u',
        userEmail: 'a@b.c',
      }),
    ).toBe('supabase');
    expect(formatGrantList('all')).toBe('all');
    expect(formatGrantList([])).toBe('none');
    expect(formatGrantList(null)).toBe('ungated');
    expect(formatGrantList(['project.secret.read'])).toBe('project.secret.read');
  });
});

describe('permission-denial identity footer', () => {
  function captureStderr(): { output: () => string; restore: () => void } {
    const original = process.stderr.write.bind(process.stderr);
    let buffer = '';
    (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk) => {
      buffer += chunk;
      return true;
    };
    return {
      output: () => buffer,
      restore: () => {
        (process.stderr as unknown as { write: typeof original }).write = original;
      },
    };
  }

  test('names the agent, its grant, and where to change it', async () => {
    process.env.KORTIX_API_URL = 'https://api.kortix.com';
    process.env.KORTIX_TOKEN = 'kortix_pat_session';
    rememberTokenIdentity('kortix_pat_session', agentMe());
    recordPermissionDenial(403);

    const cap = captureStderr();
    try {
      await printPermissionDenialIdentity();
    } finally {
      cap.restore();
    }
    const out = cap.output();

    expect(out).toContain('session token · agent osp-vision-route-agent');
    expect(out).toContain('project.secret.read, project.secret.write');
    expect(out).toContain('agents.osp-vision-route-agent.kortix_permissions');
  });

  async function footerFor(detail: { code?: string; action?: string }): Promise<string> {
    process.env.KORTIX_API_URL = 'https://api.kortix.com';
    process.env.KORTIX_TOKEN = 'kortix_pat_session';
    rememberTokenIdentity('kortix_pat_session', agentMe());
    recordPermissionDenial(403, undefined, detail);
    const cap = captureStderr();
    try {
      await printPermissionDenialIdentity();
    } finally {
      cap.restore();
    }
    return cap.output();
  }

  test('agent_scope_insufficient names the action and the manifest key to change', async () => {
    const out = await footerFor({ code: 'agent_scope_insufficient', action: 'project.file.read' });
    expect(out).toContain('project.file.read');
    expect(out).toContain('agents.osp-vision-route-agent.kortix_permissions');
  });

  test('agent_ceiling_insufficient asks an admin to raise the agent role, never the manifest', async () => {
    const out = await footerFor({ code: 'agent_ceiling_insufficient', action: 'project.file.read' });
    expect(out).toMatch(/ask an admin/i);
    expect(out).toContain('osp-vision-route-agent');
    expect(out).not.toContain('kortix_permissions');
  });

  test('agent_human_only_action says a human must do it', async () => {
    const out = await footerFor({ code: 'agent_human_only_action', action: 'project.delete' });
    expect(out).toMatch(/a human must do this/i);
    expect(out).not.toContain('kortix_permissions');
  });

  test('agent_session_forbidden (e.g. granting a secret) says a person must do it', async () => {
    // No kortix_permissions entry unlocks these routes, so the manifest hint
    // would send the agent to a fix that cannot work.
    const out = await footerFor({ code: 'agent_session_forbidden' });
    expect(out).toMatch(/a person with project access must do this/i);
    expect(out).not.toContain('kortix_permissions');
  });

  test('any other code keeps the existing manifest hint', async () => {
    const out = await footerFor({ code: 'project_role_insufficient', action: 'project.file.read' });
    expect(out).toContain('agents.osp-vision-route-agent.kortix_permissions');
  });

  test('prints nothing when no call was refused', async () => {
    process.env.KORTIX_API_URL = 'https://api.kortix.com';
    process.env.KORTIX_TOKEN = 'kortix_pat_session';
    rememberTokenIdentity('kortix_pat_session', agentMe());

    const cap = captureStderr();
    try {
      await printPermissionDenialIdentity();
    } finally {
      cap.restore();
    }
    expect(cap.output()).toBe('');
  });

  test('a non-identity status is not recorded', async () => {
    process.env.KORTIX_API_URL = 'https://api.kortix.com';
    process.env.KORTIX_TOKEN = 'kortix_pat_session';
    rememberTokenIdentity('kortix_pat_session', agentMe());
    recordPermissionDenial(404);
    recordPermissionDenial(500);

    const cap = captureStderr();
    try {
      await printPermissionDenialIdentity();
    } finally {
      cap.restore();
    }
    expect(cap.output()).toBe('');
  });

  test('the footer is emitted once per command', async () => {
    process.env.KORTIX_API_URL = 'https://api.kortix.com';
    process.env.KORTIX_TOKEN = 'kortix_pat_session';
    rememberTokenIdentity('kortix_pat_session', agentMe());
    recordPermissionDenial(403);
    recordPermissionDenial(403);

    const first = captureStderr();
    try {
      await printPermissionDenialIdentity();
    } finally {
      first.restore();
    }
    const second = captureStderr();
    try {
      await printPermissionDenialIdentity();
    } finally {
      second.restore();
    }

    expect(first.output()).toContain('osp-vision-route-agent');
    expect(second.output()).toBe('');
  });
});
