import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_PROJECT_CONNECTION_LABEL,
  type ProjectConnectionConnectDeps,
  CONNECT_LINK_POLL_INTERVAL_MS,
  CONNECT_LINK_TIMEOUT_MS,
  connectLinkUrl,
  pollConnectLinkFinalize,
  workspaceConnectionConnectSteps,
} from './connect-link';

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
  deps: ProjectConnectionConnectDeps;
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

describe('projectConnectionConnectSteps — sole shared account (the connector default)', () => {
  test('falls back to the connector-scoped route the 409 names, so Connect is not dead', async () => {
    // The state immediately after a user adds their first shared account: one
    // unpinned project-owned row, which IS the connector's effective default.
    // Before the fix both shared "Connect" CTAs died here on the 409.
    const { calls, deps } = recordingDeps('409');
    const steps = workspaceConnectionConnectSteps('project-1', 'notion-product', 'Support', deps);

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
    const steps = workspaceConnectionConnectSteps('project-1', 'notion-product', 'Support', deps);

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

    await workspaceConnectionConnectSteps('project-1', 'notion-product', '  Support  ', deps).start();

    expect(calls[0]).toBe('reconcile:project-1:project:Support');
  });

  test('an omitted label falls back to the default name', async () => {
    const { calls, deps } = recordingDeps('409');

    await workspaceConnectionConnectSteps('project-1', 'notion-product', '   ', deps).start();

    expect(calls[0]).toBe(`reconcile:project-1:project:${DEFAULT_PROJECT_CONNECTION_LABEL}`);
  });
});

describe('projectConnectionConnectSteps — a second labelled shared account', () => {
  test('stays on the connection-scoped route, so the new account is the one authorized', async () => {
    // Several project-owned connections per connector are supported and are
    // distinguished by label (`ReconcileConnectionInput`). A non-default row is
    // NOT blocked, and must not be redirected to the connector-scoped route:
    // `owner: 'project'` there reuses `ensureDefaultConnection` and would
    // re-authorize the DEFAULT account, leaving this new row unauthorized.
    const { calls, deps } = recordingDeps('ok', 'conn-2');
    const steps = workspaceConnectionConnectSteps('project-1', 'notion-product', 'Sales', deps);

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

describe('projectConnectionConnectSteps — errors that are not the default-account 409', () => {
  test('a 403 propagates instead of silently retrying the other route', async () => {
    const { calls, deps } = recordingDeps(403);
    const steps = workspaceConnectionConnectSteps('project-1', 'notion-product', 'Support', deps);

    await expect(steps.start()).rejects.toThrow('forbidden');
    expect(calls).not.toContain('connect-connector:project-1:notion-product:project');
  });

  test('finalize before start names the missing connection rather than throwing on null', async () => {
    const { deps } = recordingDeps('ok');
    const steps = workspaceConnectionConnectSteps('project-1', 'notion-product', 'Support', deps);

    expect(() => steps.finalize()).toThrow('The project connection was not created.');
  });
});

describe('projectConnectionConnectSteps — an account shared with chosen people', () => {
  test('narrows the new account after it exists and before authorization starts', async () => {
    // A shared account with no grant is usable by everyone. Writing the grants
    // before the OAuth link opens means the account never holds a credential
    // while it is open to the whole project.
    const { calls, deps } = recordingDeps('ok', 'conn-3');
    const steps = workspaceConnectionConnectSteps('project-1', 'notion-product', 'Sales', deps, async (id) => {
      calls.push(`narrow:${id}`);
    });

    await steps.start();

    expect(calls).toEqual([
      'reconcile:project-1:project:Sales',
      'narrow:conn-3',
      'connect-connection:project-1:conn-3',
    ]);
  });

  test('names the account it created, so a caller can finalize exactly that one', async () => {
    const { deps } = recordingDeps('ok', 'conn-5');
    const steps = workspaceConnectionConnectSteps('project-1', 'notion-product', 'Sales', deps);
    expect(steps.connectionId()).toBeNull();
    await steps.start();
    expect(steps.connectionId()).toBe('conn-5');
  });

  test('a failed narrowing stops the flow before any authorization link', async () => {
    const { calls, deps } = recordingDeps('ok', 'conn-4');
    const steps = workspaceConnectionConnectSteps('project-1', 'notion-product', 'Sales', deps, async () => {
      throw new Error('grant refused');
    });

    await expect(steps.start()).rejects.toThrow('grant refused');
    expect(calls).toEqual(['reconcile:project-1:project:Sales']);
  });
});

describe('pollConnectLinkFinalize', () => {
  test('polls every 2 s until the provider reports the account connected', async () => {
    let calls = 0;
    const slept: number[] = [];
    await expect(
      pollConnectLinkFinalize(async () => ({ connected: ++calls === 3 }), {
        sleep: async (ms) => void slept.push(ms),
        now: () => 0,
      }),
    ).resolves.toEqual({ connected: true });
    expect(calls).toBe(3);
    expect(slept).toEqual([CONNECT_LINK_POLL_INTERVAL_MS, CONNECT_LINK_POLL_INTERVAL_MS]);
    expect(CONNECT_LINK_POLL_INTERVAL_MS).toBe(2000);
  });

  test('gives up after 10 minutes with the web wording', async () => {
    let now = 0;
    await expect(
      pollConnectLinkFinalize(async () => ({ connected: false }), {
        sleep: async (ms) => {
          now += ms;
        },
        now: () => now,
      }),
    ).rejects.toThrow('Authorization timed out after 10 minutes. Try again.');
    expect(now).toBe(CONNECT_LINK_TIMEOUT_MS);
  });

  test('an abort ends the wait, even while a finalize is still pending', async () => {
    const controller = new AbortController();
    const wait = pollConnectLinkFinalize(() => new Promise(() => undefined), { signal: controller.signal });
    controller.abort(new Error('cancelled'));
    await expect(wait).rejects.toThrow('cancelled');
  });

  test('the Connect Link URL is the normalized field first', () => {
    expect(connectLinkUrl({ connectUrl: 'https://a', redirectUrl: 'https://b' })).toBe('https://a');
    expect(connectLinkUrl({ redirectUrl: 'https://b' })).toBe('https://b');
    expect(connectLinkUrl({})).toBeNull();
  });
});
