import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connectorContext } from '../connector-gateway/gateway.ts';

// KRTX-2529: `kortix connectors call denies-connector ls` inside a directory
// linked to the dogfood project answered with the SANDBOX session identity
// (KORTIX_TOKEN + KORTIX_PROJECT_ID) while `kortix connectors ls` in the same
// cwd answered as the LINK — the call saw "active", the ls did not. The
// gateway face pinned auth to the env token instead of resolving the project
// context the way every project-scoped command does. After the fix the two
// faces resolve through resolveProjectContext, so they cannot disagree: the
// link (or --host) supplies BOTH the project and its host's stored credential,
// and the injected env token remains the fallback for a session with no link.

const ENV_KEYS = [
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
  'KORTIX_CONFIG_FILE',
  'KORTIX_AUTH_FILE',
] as const;

const DF_TOKEN = 'kortix_pat_dogfood';
const ENV_TOKEN = 'kortix_pat_session';
const ENV_PROJECT = 'proj-session';

function hostEntry(token: string, defaultProject?: { project_id: string; account_id: string }) {
  return {
    url: 'https://api.example.test',
    token,
    user_id: 'u',
    user_email: 'user@example.test',
    account_id: 'acct-1',
    logged_in_at: '2026-01-01T00:00:00.000Z',
    ...(defaultProject ? { default_project: defaultProject } : {}),
  };
}

function writeConfig(path: string, body: unknown) {
  writeFileSync(path, JSON.stringify(body));
}

describe('connectorContext — the gateway face resolves the project context', () => {
  let dir: string;
  let savedCwd: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
    // The session sandbox identity a dogfood worker runs under.
    process.env.KORTIX_TOKEN = ENV_TOKEN;
    process.env.KORTIX_API_URL = 'https://api.sandbox.test';
    process.env.KORTIX_PROJECT_ID = ENV_PROJECT;
    dir = mkdtempSync(join(tmpdir(), 'kortix-connector-ctx-'));
    process.env.KORTIX_CONFIG_FILE = join(dir, 'config.json');
    savedCwd = process.cwd();
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    rmSync(dir, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('a linked directory resolves the LINK principal and project — not the sandbox env', async () => {
    writeConfig(process.env.KORTIX_CONFIG_FILE!, {
      active: 'home',
      hosts: {
        home: hostEntry('kortix_pat_home'),
        dogfood: hostEntry(DF_TOKEN),
      },
    });
    mkdirSync(join(dir, '.kortix'), { recursive: true });
    writeFileSync(
      join(dir, '.kortix', 'link.json'),
      JSON.stringify({
        project_id: 'proj-dogfood',
        account_id: 'acct-1',
        host: 'dogfood',
        linked_at: '2026-01-01T00:00:00.000Z',
      }),
    );
    const ctx = await connectorContext();
    expect(ctx.projectId).toBe('proj-dogfood');
    expect(ctx.auth.token).toBe(DF_TOKEN);
  });

  it('--host resolves that host\'s own context (its stored default project)', async () => {
    writeConfig(process.env.KORTIX_CONFIG_FILE!, {
      active: 'home',
      hosts: {
        home: hostEntry('kortix_pat_home'),
        dogfood: hostEntry(DF_TOKEN, { project_id: 'proj-dogfood', account_id: 'acct-1' }),
      },
    });
    const ctx = await connectorContext(undefined, 'dogfood');
    expect(ctx.projectId).toBe('proj-dogfood');
    expect(ctx.auth.token).toBe(DF_TOKEN);
  });

  it('a session with no link keeps the injected env identity (KRTX-1705 unchanged)', async () => {
    writeConfig(process.env.KORTIX_CONFIG_FILE!, {
      active: 'home',
      hosts: { home: hostEntry('kortix_pat_home') },
    });
    const ctx = await connectorContext();
    expect(ctx.projectId).toBe(ENV_PROJECT);
    expect(ctx.auth.token).toBe(ENV_TOKEN);
    expect(ctx.auth.api_base).toBe('https://api.sandbox.test');
  });

  it('--project pins the project on the session identity', async () => {
    writeConfig(process.env.KORTIX_CONFIG_FILE!, {
      active: 'home',
      hosts: { home: hostEntry('kortix_pat_home') },
    });
    const ctx = await connectorContext('proj-pinned');
    expect(ctx.projectId).toBe('proj-pinned');
    expect(ctx.auth.token).toBe(ENV_TOKEN);
  });
});
