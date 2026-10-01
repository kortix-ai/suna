import { describe, expect, test } from 'bun:test';

import { appConnectSteps } from './use-pipedream-connect-app';

/**
 * `usePipedreamConnect` documents itself as connecting "the project's shared
 * account", and used to send no `owner` on either verb. Both connector-scoped
 * routes default an absent owner to `me`
 * (`apps/api/src/projects/lib/connection-access.ts:94`, applied at
 * `apps/api/src/connectors/db-deps.ts:2325` and `:2439`), so it would have
 * authorized the caller's own private account instead — the same defect fixed
 * in `use-tool-connect.ts`, verified live there against the real API.
 *
 * This hook currently has no callers; every live surface uses
 * `usePipedreamConnectProject` / `usePipedreamConnectMember`. The owner is
 * named here so wiring it up cannot reintroduce the bug.
 */
describe('appConnectSteps', () => {
  function spyDeps(connectResult: { connectionId?: string } = {}) {
    const calls: { verb: string; args: unknown[] }[] = [];
    return {
      calls,
      deps: {
        connectProject: async (...args: unknown[]) => {
          calls.push({ verb: 'connect', args });
          return { connectUrl: 'https://connect.example/app', ...connectResult };
        },
        finalizeProject: async (...args: unknown[]) => {
          calls.push({ verb: 'finalize', args });
          return { connected: true };
        },
      } as never,
    };
  }

  test('connect names the project owner', async () => {
    const { calls, deps } = spyDeps();
    await appConnectSteps('project-1', 'gmail', deps).start();

    expect(calls[0]).toEqual({
      verb: 'connect',
      args: ['project-1', 'gmail', { owner: 'project' }],
    });
  });

  test('finalize repeats the owner and pins the connection the connect returned', async () => {
    const { calls, deps } = spyDeps({ connectionId: 'connection-9' });
    const steps = appConnectSteps('project-1', 'gmail', deps);
    await steps.start();
    await steps.finalize();

    expect(calls[1]).toEqual({
      verb: 'finalize',
      args: ['project-1', 'gmail', { owner: 'project', connectionId: 'connection-9' }],
    });
  });

  test('finalize still names the owner when no connection id came back', async () => {
    const { calls, deps } = spyDeps();
    const steps = appConnectSteps('project-1', 'gmail', deps);
    await steps.start();
    await steps.finalize();

    expect(calls[1]?.args[2]).toEqual({ owner: 'project' });
  });
});
