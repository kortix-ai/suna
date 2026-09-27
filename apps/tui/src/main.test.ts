import { afterEach, describe, expect, test } from 'bun:test';

import type { ResolvedHost } from './auth/hosts.ts';
import { initKortix, resetKortixForTest } from './kortix.ts';
import { resolveProjectId } from './main.tsx';

/**
 * `runTui()` itself needs a renderer and a real tty, so it is proved by the
 * compiled-binary pty run, not here. What IS unit-testable is the half of boot
 * that decides WHICH project the app opens on — the precedence every caller
 * depends on:
 *
 *   explicit `--project` / `KORTIX_PROJECT_ID`  →  the host's default project
 *   →  the first project the host can see  →  nothing (the empty state).
 */

function stubHost(backendUrl: string): ResolvedHost {
  return {
    name: 'test',
    backendUrl,
    token: 'test-token',
    accountId: '',
    userEmail: '',
    source: 'env',
  };
}

let server: ReturnType<typeof Bun.serve> | null = null;

afterEach(() => {
  server?.stop(true);
  server = null;
  resetKortixForTest();
});

describe('resolveProjectId', () => {
  const alive = new Set(['proj_flag', 'proj_default', 'proj_first', 'proj_padded']);
  const notes: string[] = [];
  const deps = {
    getProject: async (id: string) => {
      if (!alive.has(id)) throw new Error('Not found');
      return { project_id: id };
    },
    listProjects: async (accountId: string | null) =>
      accountId === 'acct_host'
        ? [{ project_id: 'proj_first' }, { project_id: 'proj_second' }]
        : [{ project_id: 'proj_other_account' }],
    note: (text: string) => notes.push(text),
  };

  test('a default project that no longer exists is skipped, said so, and the first visible project wins', async () => {
    notes.length = 0;
    expect(await resolveProjectId(['proj_gone'], 'acct_host', deps)).toBe('proj_first');
    expect(notes).toEqual([
      'Project proj_gon is not available on this host (Not found); using the first project in your account.',
    ]);
  });

  test('the fallback stays inside the host account — never the first project of any account', async () => {
    expect(await resolveProjectId(['proj_gone'], 'acct_host', deps)).toBe('proj_first');
    expect(await resolveProjectId([], null, deps)).toBe('proj_other_account');
  });

  test('a dead flag value falls through to a live default before the list', async () => {
    expect(await resolveProjectId(['proj_gone', 'proj_default'], 'acct_host', deps)).toBe(
      'proj_default',
    );
  });

  test('nothing alive and no list → null, never a dead id', async () => {
    expect(
      await resolveProjectId(['proj_gone'], 'acct_host', {
        ...deps,
        listProjects: async () => {
          throw new Error('offline');
        },
      }),
    ).toBeNull();
  });

  test('takes the first candidate that has a value, in order', async () => {
    expect(await resolveProjectId(['proj_flag', 'proj_default'], 'acct_host', deps)).toBe(
      'proj_flag',
    );
    expect(await resolveProjectId([null, 'proj_default'], 'acct_host', deps)).toBe('proj_default');
    expect(await resolveProjectId([undefined, 'proj_default'], 'acct_host', deps)).toBe(
      'proj_default',
    );
  });

  test('a blank candidate is not a candidate', async () => {
    expect(await resolveProjectId(['   ', 'proj_default'], 'acct_host', deps)).toBe('proj_default');
    expect(await resolveProjectId(['  proj_padded  '], 'acct_host', deps)).toBe('proj_padded');
  });

  test('with no candidate it asks the host and takes its first project', async () => {
    const seen: string[] = [];
    server = Bun.serve({
      port: 0,
      fetch(request) {
        seen.push(new URL(request.url).pathname);
        return Response.json([
          { project_id: 'proj_first', name: 'First' },
          { project_id: 'proj_second', name: 'Second' },
        ]);
      },
    });
    initKortix(stubHost(`http://127.0.0.1:${server.port}/v1`));

    expect(await resolveProjectId([null, undefined])).toBe('proj_first');
    expect(seen).toEqual(['/v1/projects']);
  });

  test('an empty project list resolves to null, not a crash', async () => {
    server = Bun.serve({ port: 0, fetch: () => Response.json([]) });
    initKortix(stubHost(`http://127.0.0.1:${server.port}/v1`));

    expect(await resolveProjectId([null, undefined])).toBeNull();
  });

  test('a host that cannot be reached resolves to null, not a crash', async () => {
    initKortix(stubHost('http://127.0.0.1:9/v1'));
    expect(await resolveProjectId([null, undefined])).toBeNull();
  });

  test('no client at all resolves to null — the login screen is the next state', async () => {
    resetKortixForTest();
    expect(await resolveProjectId([null, undefined])).toBeNull();
  });
});
