import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_PROJECT_CONNECTION_LABEL,
  type ProjectConnectDeps,
  projectConnectSteps,
} from './use-pipedream-connect-project';

/**
 * The 409 the connection-scoped connect route answers for a connector's
 * EFFECTIVE project default.
 *
 * `apps/api/src/projects/routes/connection-actions.ts` (INVARIANT, 2026-09-16 `account_required`
 * rule) blocks that route for the sole active project-owned row even when
 * nothing is pinned, and names the route the client must use instead. It is the
 * only 409 that handler returns.
 *
 * Shaped as a plain object with a numeric `status`, matching a real `ApiError`
 * structurally — the SDK ships an ESM build and an IIFE global, so `instanceof`
 * can be false for a genuine one (see `catalog-error.ts`).
 */
const sharedDefaultConflict = () =>
  Object.assign(new Error('Use the shared connector connect endpoint for the default connection'), {
    status: 409,
  });

interface Recorded {
  calls: string[];
  deps: ProjectConnectDeps;
}

/**
 * @param connectionScopedConnect what the connection-scoped connect route does:
 *   `409` for the effective default, `ok` for a labelled non-default account.
 */
function recordingDeps(
  connectionScopedConnect: '409' | 'ok' | 403,
  connectionId = 'conn-1',
): Recorded {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      reconcile: async (projectId, input) => {
        calls.push(`reconcile:${projectId}:${input.owner_type}:${input.label}`);
        return { connection_id: connectionId };
      },
      connectConnection: async (projectId, id) => {
        calls.push(`connect-connection:${projectId}:${id}`);
        if (connectionScopedConnect === '409') throw sharedDefaultConflict();
        if (connectionScopedConnect === 403) {
          throw Object.assign(new Error('forbidden'), { status: 403 });
        }
        return { connectUrl: 'https://connect.example/connection' };
      },
      finalizeConnection: async (projectId, id) => {
        calls.push(`finalize-connection:${projectId}:${id}`);
        return { connected: true };
      },
      connectConnector: async (projectId, slug, options) => {
        calls.push(`connect-connector:${projectId}:${slug}:${options.owner}`);
        return { connectUrl: 'https://connect.example/connector' };
      },
      finalizeConnector: async (projectId, slug, options) => {
        calls.push(
          `finalize-connector:${projectId}:${slug}:${options.owner}:${options.connectionId}`,
        );
        return { connected: true };
      },
    },
  };
}

describe('projectConnectSteps — sole shared account (the connector default)', () => {
  test('falls back to the connector-scoped route the 409 names, so Connect is not dead', async () => {
    // The state immediately after a user adds their first shared account: one
    // unpinned project-owned row, which IS the connector's effective default.
    // Before the fix both shared "Connect" CTAs died here on the 409.
    const { calls, deps } = recordingDeps('409');
    const steps = projectConnectSteps('project-1', 'notion-product', 'Support', deps);

    const started = await steps.start();

    expect(started.connectUrl).toBe('https://connect.example/connector');
    expect(calls).toEqual([
      'reconcile:project-1:project:Support',
      'connect-connection:project-1:conn-1',
      'connect-connector:project-1:notion-product:project',
    ]);
  });

  test('finalize polls the SAME route and the SAME owner the link was minted for', async () => {
    // Two distinct hangs are guarded here. Polling the connection-scoped
    // finalize would hit the very same 409 (one handler serves `connect` and
    // `connect/finalize` — `connection-actions.ts` builds both in one loop). Polling the
    // connector-scoped finalize WITHOUT `owner: 'project'` would default to
    // `me` and poll the caller's member account. Either way the account never
    // reports active and the flow burns its full 10-minute timeout.
    const { calls, deps } = recordingDeps('409');
    const steps = projectConnectSteps('project-1', 'notion-product', 'Support', deps);

    await steps.start();
    calls.length = 0;
    const finalized = await steps.finalize();

    expect(finalized.connected).toBe(true);
    expect(calls).toEqual(['finalize-connector:project-1:notion-product:project:conn-1']);
  });

  test('reconcile still runs first, so the account keeps the label the user typed', async () => {
    // `owner: 'project'` resolves the connector's effective default via
    // `ensureDefaultConnection`, which returns the sole row reconcile just
    // created — so the label survives rather than being replaced.
    const { calls, deps } = recordingDeps('409');

    await projectConnectSteps('project-1', 'notion-product', '  Support  ', deps).start();

    expect(calls[0]).toBe('reconcile:project-1:project:Support');
  });

  test('an omitted label falls back to the default name', async () => {
    const { calls, deps } = recordingDeps('409');

    await projectConnectSteps('project-1', 'notion-product', '   ', deps).start();

    expect(calls[0]).toBe(`reconcile:project-1:project:${DEFAULT_PROJECT_CONNECTION_LABEL}`);
  });
});

describe('projectConnectSteps — a second labelled shared account', () => {
  test('stays on the connection-scoped route, so the new account is the one authorized', async () => {
    // Several project-owned connections per connector are supported and are
    // distinguished by label (`ReconcileConnectionInput`). A non-default row is
    // NOT blocked, and must not be redirected to the connector-scoped route:
    // `owner: 'project'` there reuses `ensureDefaultConnection` and would
    // re-authorize the DEFAULT account, leaving this new row unauthorized.
    const { calls, deps } = recordingDeps('ok', 'conn-2');
    const steps = projectConnectSteps('project-1', 'notion-product', 'Sales', deps);

    const started = await steps.start();
    const finalized = await steps.finalize();

    expect(started.connectUrl).toBe('https://connect.example/connection');
    expect(finalized.connected).toBe(true);
    expect(calls).toEqual([
      'reconcile:project-1:project:Sales',
      'connect-connection:project-1:conn-2',
      'finalize-connection:project-1:conn-2',
    ]);
    expect(calls).not.toContain('connect-connector:project-1:notion-product:project');
  });
});

describe('projectConnectSteps — errors that are not the default-account 409', () => {
  test('a 403 propagates instead of silently retrying the other route', async () => {
    const { calls, deps } = recordingDeps(403);
    const steps = projectConnectSteps('project-1', 'notion-product', 'Support', deps);

    await expect(steps.start()).rejects.toThrow('forbidden');
    expect(calls).not.toContain('connect-connector:project-1:notion-product:project');
  });

  test('finalize before start names the missing connection rather than throwing on null', async () => {
    const { deps } = recordingDeps('ok');
    const steps = projectConnectSteps('project-1', 'notion-product', 'Support', deps);

    expect(() => steps.finalize()).toThrow('The project connection was not created.');
  });
});
