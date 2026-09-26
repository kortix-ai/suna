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
  test('takes the first candidate that has a value, in order', async () => {
    expect(await resolveProjectId('proj_flag', 'proj_default')).toBe('proj_flag');
    expect(await resolveProjectId(null, 'proj_default')).toBe('proj_default');
    expect(await resolveProjectId(undefined, 'proj_default')).toBe('proj_default');
  });

  test('a blank candidate is not a candidate', async () => {
    expect(await resolveProjectId('   ', 'proj_default')).toBe('proj_default');
    expect(await resolveProjectId('  proj_padded  ')).toBe('proj_padded');
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

    expect(await resolveProjectId(null, undefined)).toBe('proj_first');
    expect(seen).toEqual(['/v1/projects']);
  });

  test('an empty project list resolves to null, not a crash', async () => {
    server = Bun.serve({ port: 0, fetch: () => Response.json([]) });
    initKortix(stubHost(`http://127.0.0.1:${server.port}/v1`));

    expect(await resolveProjectId(null, undefined)).toBeNull();
  });

  test('a host that cannot be reached resolves to null, not a crash', async () => {
    initKortix(stubHost('http://127.0.0.1:9/v1'));
    expect(await resolveProjectId(null, undefined)).toBeNull();
  });

  test('no client at all resolves to null — the login screen is the next state', async () => {
    resetKortixForTest();
    expect(await resolveProjectId(null, undefined)).toBeNull();
  });
});
