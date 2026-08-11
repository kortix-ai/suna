import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Auth } from '../api/auth.ts';
import { ensureDefaultWorkspaceBinding } from '../workspace-bind.ts';

const AUTH: Auth = {
  api_base: 'https://api.example.test/v1',
  token: 'kortix_pat_test',
  user_id: 'user_1',
  user_email: 'user@example.test',
  account_id: 'account_1',
  logged_in_at: '2026-01-01T00:00:00.000Z',
};

const ENV_KEYS = [
  'KORTIX_CONFIG_FILE',
  'KORTIX_CLI_TOKEN',
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_WORKSPACE_ID',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
] as const;

function workspace(id: string, name: string) {
  return {
    workspace_id: id,
    account_id: 'account_1',
    name,
    repo_url: 'https://git.example.test/r.git',
    default_branch: 'main',
    manifest_path: 'kortix.yaml',
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('ensureDefaultWorkspaceBinding', () => {
  let dir: string;
  let configFile: string;
  let stderrChunks: string[];
  const saved: Record<string, string | undefined> = {};
  const realFetch = globalThis.fetch;
  const realStderrWrite = process.stderr.write;

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
    dir = mkdtempSync(join(tmpdir(), 'kortix-bind-'));
    configFile = join(dir, 'config.json');
    process.env.KORTIX_CONFIG_FILE = configFile;
    writeFileSync(
      configFile,
      JSON.stringify({
        active: 'test',
        hosts: {
          test: {
            url: AUTH.api_base,
            token: AUTH.token,
            user_id: AUTH.user_id,
            user_email: AUTH.user_email,
            account_id: AUTH.account_id,
            logged_in_at: AUTH.logged_in_at,
          },
        },
      }),
    );
    stderrChunks = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = realStderrWrite;
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function mockWorkspaces(list: unknown[] | { status: number }) {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url instanceof Request ? url.url : url);
      if (u.includes('/workspaces')) {
        if (Array.isArray(list)) return Response.json(list);
        return Response.json({ error: 'boom' }, { status: list.status });
      }
      return Response.json({ error: 'unexpected route' }, { status: 404 });
    }) as typeof fetch;
  }

  function storedDefaultWorkspace(): { workspace_id: string; name: string } | undefined {
    const cfg = JSON.parse(readFileSync(configFile, 'utf8'));
    return cfg.hosts?.test?.default_workspace;
  }

  it('is a no-op when a default workspace is already bound', async () => {
    const cfg = JSON.parse(readFileSync(configFile, 'utf8'));
    cfg.hosts.test.default_workspace = {
      workspace_id: 'workspace_existing',
      account_id: 'account_1',
      name: 'Existing',
    };
    writeFileSync(configFile, JSON.stringify(cfg));
    globalThis.fetch = (async () => {
      throw new Error('must not fetch when already bound');
    }) as unknown as typeof fetch;

    const outcome = await ensureDefaultWorkspaceBinding(AUTH);

    expect(outcome.bound).toBe(false);
    expect(outcome.workspace?.workspace_id).toBe('workspace_existing');
  });

  it('auto-binds when the account has exactly one workspace', async () => {
    mockWorkspaces([workspace('workspace_only', 'Only One')]);

    const outcome = await ensureDefaultWorkspaceBinding(AUTH);

    expect(outcome.bound).toBe(true);
    expect(outcome.workspace?.workspace_id).toBe('workspace_only');
    expect(storedDefaultWorkspace()?.workspace_id).toBe('workspace_only');
    expect(stderrChunks.join('')).toContain('Default workspace:');
  });

  it('hints at kortix init and binds nothing when the account has zero workspaces', async () => {
    mockWorkspaces([]);

    const outcome = await ensureDefaultWorkspaceBinding(AUTH);

    expect(outcome.bound).toBe(false);
    expect(outcome.workspace).toBeNull();
    expect(storedDefaultWorkspace()).toBeUndefined();
    expect(stderrChunks.join('')).toContain('kortix init');
  });

  it('says "in this account", not "your first" — the user may have workspaces elsewhere', async () => {
    // The old wording told someone with four workspaces under a sibling account to
    // create their first one. It is also the line that makes a command look
    // failed right before its cross-account fallback succeeds.
    mockWorkspaces([]);

    await ensureDefaultWorkspaceBinding(AUTH);

    const out = stderrChunks.join('');
    expect(out).toContain('No workspaces in this account');
    expect(out).toContain('kortix accounts use');
    expect(out).not.toContain('your first');
  });

  it('stays SILENT on a FAILED workspace list too, not just an empty one', async () => {
    // `quiet` promises silence on every path that ends unbound. It first only
    // covered the empty-account branch, so a caller with a fallback still got a
    // "could not list workspaces" line before its scan succeeded.
    mockWorkspaces({ status: 500 });

    const outcome = await ensureDefaultWorkspaceBinding(AUTH, { quiet: true });

    expect(outcome.workspace).toBeNull();
    expect(stderrChunks.join('')).toBe('');
  });

  it('stays SILENT on a non-TTY with several workspaces', async () => {
    mockWorkspaces([workspace('workspace_a', 'A'), workspace('workspace_b', 'B')]);

    const outcome = await ensureDefaultWorkspaceBinding(AUTH, { quiet: true });

    expect(outcome.workspace).toBeNull();
    expect(stderrChunks.join('')).toBe('');
  });

  it('still SPEAKS on those paths without quiet', async () => {
    // The flag must not become a blanket gag: a caller with no fallback needs
    // to know why nothing bound.
    mockWorkspaces({ status: 500 });
    await ensureDefaultWorkspaceBinding(AUTH);
    expect(stderrChunks.join('')).toContain('Could not list workspaces');
  });

  it('stays SILENT when the caller has a fallback', async () => {
    // `locateSessionAnywhere` scans the host's other accounts next and usually
    // finds the session. Announcing "no workspaces" first reports a failure that
    // has not happened — the command goes on to succeed, but the output reads
    // as an error.
    mockWorkspaces([]);

    const outcome = await ensureDefaultWorkspaceBinding(AUTH, { quiet: true });

    expect(outcome.workspace).toBeNull();
    expect(stderrChunks.join('')).toBe('');
  });

  it('does not prompt or bind on a non-TTY when several workspaces exist', async () => {
    mockWorkspaces([workspace('workspace_a', 'A'), workspace('workspace_b', 'B')]);

    const outcome = await ensureDefaultWorkspaceBinding(AUTH);

    expect(outcome.bound).toBe(false);
    expect(outcome.workspace).toBeNull();
    expect(storedDefaultWorkspace()).toBeUndefined();
    expect(stderrChunks.join('')).toContain('kortix workspaces use');
  });

  it('degrades to unbound with the reason on stderr when listing workspaces fails', async () => {
    mockWorkspaces({ status: 500 });

    const outcome = await ensureDefaultWorkspaceBinding(AUTH);

    expect(outcome.bound).toBe(false);
    expect(outcome.workspace).toBeNull();
    expect(stderrChunks.join('')).toContain('Could not list workspaces');
  });
});
