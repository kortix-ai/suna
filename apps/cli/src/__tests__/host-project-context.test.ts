import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveProjectContext } from '../command-helpers.ts';

// An explicit `--host <name>` targets a different Kortix deployment. The
// project id must then come from THAT host's own context — a `--project`
// pin, a `.kortix/link.json` bound to the same host, or the named host's
// stored default project. Falling back to the ambient environment's project
// id (KORTIX_PROJECT_ID, a link bound to another host, the active host's
// default) sends a project id that does not exist on the named host and
// surfaces as a misleading 404.
const ENV_KEYS = [
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
  'KORTIX_CONFIG_FILE',
  'KORTIX_AUTH_FILE',
] as const;

const HOME_TOKEN = 'kortix_pat_home';
const OTHER_TOKEN = 'kortix_pat_other';
const AMBIENT_PROJECT = 'ambient-project-id';

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

describe('resolveProjectContext with an explicit --host', () => {
  let dir: string;
  let savedCwd: string;
  let stderrChunks: string[];
  const saved: Record<string, string | undefined> = {};
  const realStderrWrite = process.stderr.write;

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
    process.env.KORTIX_PROJECT_ID = AMBIENT_PROJECT;
    dir = mkdtempSync(join(tmpdir(), 'kortix-host-ctx-'));
    process.env.KORTIX_CONFIG_FILE = join(dir, 'config.json');
    writeFileSync(
      process.env.KORTIX_CONFIG_FILE,
      JSON.stringify({
        active: 'home',
        hosts: {
          home: hostEntry(HOME_TOKEN),
          other: hostEntry(OTHER_TOKEN),
        },
      }),
    );
    savedCwd = process.cwd();
    process.chdir(dir);
    stderrChunks = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = realStderrWrite;
    process.chdir(savedCwd);
    rmSync(dir, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('fails with a no-project-context message instead of the ambient project id', async () => {
    const ctx = await resolveProjectContext({ hostArg: 'other' });
    expect(ctx).toBeNull();
    const out = stderrChunks.join('');
    expect(out).toContain('No project context on host "other"');
    expect(out).toContain('--project');
    expect(out).not.toContain(AMBIENT_PROJECT);
  });

  it('pins --project and uses the named host credentials', async () => {
    const ctx = await resolveProjectContext({ hostArg: 'other', projectArg: 'proj-on-other' });
    expect(ctx).not.toBeNull();
    expect(ctx?.projectId).toBe('proj-on-other');
    expect(ctx?.auth.token).toBe(OTHER_TOKEN);
    expect(ctx?.auth.api_base).toBe('https://api.example.test');
  });

  it('uses the named host stored default project', async () => {
    process.env.KORTIX_CONFIG_FILE = join(dir, 'config.json');
    writeFileSync(
      process.env.KORTIX_CONFIG_FILE,
      JSON.stringify({
        active: 'home',
        hosts: {
          home: hostEntry(HOME_TOKEN),
          other: hostEntry(OTHER_TOKEN, { project_id: 'proj-other-default', account_id: 'acct-1' }),
        },
      }),
    );
    const ctx = await resolveProjectContext({ hostArg: 'other' });
    expect(ctx?.projectId).toBe('proj-other-default');
    expect(ctx?.auth.token).toBe(OTHER_TOKEN);
  });

  it('uses a link bound to the named host, ignores one bound elsewhere', async () => {
    mkdirSync(join(dir, '.kortix'), { recursive: true });
    writeFileSync(
      join(dir, '.kortix', 'link.json'),
      JSON.stringify({
        project_id: 'proj-link-home',
        account_id: 'acct-1',
        host: 'home',
        linked_at: '2026-01-01T00:00:00.000Z',
      }),
    );
    // The link points at "home" — it must not leak into the "other" host call.
    const ctx = await resolveProjectContext({ hostArg: 'other' });
    expect(ctx).toBeNull();

    writeFileSync(
      join(dir, '.kortix', 'link.json'),
      JSON.stringify({
        project_id: 'proj-link-other',
        account_id: 'acct-1',
        host: 'other',
        linked_at: '2026-01-01T00:00:00.000Z',
      }),
    );
    const sameHost = await resolveProjectContext({ hostArg: 'other' });
    expect(sameHost?.projectId).toBe('proj-link-other');
    expect(sameHost?.auth.token).toBe(OTHER_TOKEN);
  });

  it('without --host the ambient project id still resolves (unchanged)', async () => {
    const ctx = await resolveProjectContext();
    expect(ctx).not.toBeNull();
    expect(ctx?.projectId).toBe(AMBIENT_PROJECT);
    expect(ctx?.auth.token).toBe(HOME_TOKEN);
  });

  it('the ambient sandbox session token never overrides a named --host', async () => {
    // The platform-injected session credential of a sandbox outranks the
    // stored ACTIVE host, so before the host routing this was the state that
    // sent a session-scoped principal to another deployment. A named --host
    // must keep using that host's own stored token (KRTX-1404).
    process.env.KORTIX_TOKEN = 'kortix_pat_session';
    process.env.KORTIX_API_URL = 'https://api.sandbox.test';
    const ctx = await resolveProjectContext({ hostArg: 'other', projectArg: 'proj-on-other' });
    expect(ctx?.auth.token).toBe(OTHER_TOKEN);
    expect(ctx?.auth.api_base).toBe('https://api.example.test');
  });
});
