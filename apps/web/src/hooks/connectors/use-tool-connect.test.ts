import { describe, expect, test } from 'bun:test';

import { buildToolConnectorDraft, toolConnectSteps } from './use-tool-connect';

describe('buildToolConnectorDraft', () => {
  test('uses the selected connector identity instead of the provider slug', () => {
    // No `authorizationStrategy` — ownership is an account property
    // (`owner_type`), not a connector-level mode. Adding a tool from the
    // catalogue always authorizes the PROJECT's shared account; a personal
    // account is added afterwards from the connector's Accounts tab.
    expect(
      buildToolConnectorDraft({
        appSlug: 'notion',
        appName: 'Notion',
        provider: 'composio',
        connectorName: 'Product workspace',
        connectorSlug: 'notion-product',
      }),
    ).toEqual({
      slug: 'notion-product',
      name: 'Product workspace',
      provider: 'composio',
      app: 'notion',
      account: 'default',
      create_only: true,
    });
  });
});

describe('toolConnectSteps', () => {
  interface Call {
    verb: 'connect' | 'finalize';
    projectId: string;
      slug: string;
    options: unknown;
  }

  function spyDeps(connectResult: { connectionId?: string } = {}) {
    const calls: Call[] = [];
    return {
      calls,
      deps: {
        connectProject: async (projectId: string, slug: string, options?: unknown) => {
          calls.push({ verb: 'connect' as const, projectId, slug, options });
          return { connectUrl: 'https://connect.example/project', ...connectResult };
        },
        finalizeProject: async (projectId: string, slug: string, options?: unknown) => {
          calls.push({ verb: 'finalize' as const, projectId, slug, options });
          return { connected: true };
        },
      },
    };
  }

  // The whole point of this hook: adding a tool from the catalogue is a PROJECT
  // act, so the account it authorizes must be the project's shared one.
  //
  // The connector-scoped connect route defaults an ABSENT owner to `me`
  // (`apps/api/src/projects/lib/connection-access.ts:94`, then
  // `apps/api/src/connectors/db-deps.ts:2325`), which routes to
  // `ensureMemberConnection` and lands a `member`-owned row owned by whoever
  // clicked. Verified live: a connect with no owner produced
  // `owner_type=member owner_id=<caller>` labelled "Private connection", while
  // `owner: 'project'` resolved the shared `owner_type=project` row.
  //
  // A `member` row is reachable only by that one user and NEVER by a service
  // account (`connectionIsReachable`, `connection-access.ts:42`), so the rest
  // of the project — and every trigger — got nothing.
  test('connect names the project owner explicitly', async () => {
    const { calls, deps } = spyDeps();
    await toolConnectSteps('project-1', 'notion-product', deps).start();

    expect(calls).toEqual([
      {
        verb: 'connect',
        projectId: 'project-1',
        slug: 'notion-product',
        options: { owner: 'project' },
      },
    ]);
  });

  // The owner MUST match the connect. The finalize route defaults an absent
  // owner to `me` the same way (`apps/api/src/connectors/db-deps.ts:2439`) and
  // then selects the row by `ownerType = 'member' AND ownerId = caller`, so a
  // `project` authorization finalized without the owner polls the caller's own
  // member connection and never reports the shared account active. Same rule
  // `projectConnectSteps` follows in `use-pipedream-connect-project.ts:113`.
  test('finalize repeats the project owner and pins the connection the connect returned', async () => {
    const { calls, deps } = spyDeps({ connectionId: 'connection-42' });
    const steps = toolConnectSteps('project-1', 'notion-product', deps);
    await steps.start();
    await steps.finalize();

    expect(calls[1]).toEqual({
      verb: 'finalize',
      projectId: 'project-1',
      slug: 'notion-product',
      options: { owner: 'project', connectionId: 'connection-42' },
    });
  });

  // `connectionId` is optional on `ConnectorConnectResult`
  // (`packages/sdk/src/core/rest/projects-client/connectors.ts:843`). When the
  // provider does not return one, finalize still has to name the owner — the
  // route then resolves the most recently updated row in that owner scope,
  // which is the one this connect just touched.
  test('finalize still names the owner when the connect returned no connection id', async () => {
    const { calls, deps } = spyDeps();
    const steps = toolConnectSteps('project-1', 'notion-product', deps);
    await steps.start();
    await steps.finalize();

    expect(calls[1]?.options).toEqual({ owner: 'project' });
  });
});
