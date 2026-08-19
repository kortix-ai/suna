import type { AdminConnector, Connection, ProjectSecret } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import {
  loadSessionScopeCatalog,
  sessionScopeCatalogQueryKey,
  sessionScopeQueryKey,
} from './use-session-scope';

const secret = (identifier: string): ProjectSecret => ({
  identifier,
  name: identifier,
  project_id: 'project-1',
  secret_id: `secret-${identifier}`,
  created_by: null,
  created_at: null,
  updated_at: null,
  configured: true,
  mine: null,
  effective_source: 'shared',
  can_manage_shared: false,
});

const connector = (slug: string): AdminConnector => ({
  slug,
  name: slug,
  provider: 'pipedream',
  status: 'active',
  credentialMode: 'shared',
  authorizationStrategy: 'project',
  sensitive: false,
  actions: [],
  authSecret: null,
  secretSet: true,
});

const connection = (connectionId: string): Connection => ({
  connection_id: connectionId,
  connector_alias: 'mail',
  owner_type: 'project',
  owner_id: null,
  label: connectionId,
  status: 'active',
  is_default: true,
  metadata: {},
});

describe('session scope query keys', () => {
  test('uses the shared scope and catalog cache keys', () => {
    expect(sessionScopeQueryKey('project-1', 'session-1')).toEqual([
      'project-session-scope',
      'project-1',
      'session-1',
    ]);
    expect(sessionScopeCatalogQueryKey('project-1')).toEqual([
      'session-scope-catalog',
      'project-1',
      true,
      true,
    ]);
  });

  test('the permits are part of the catalog key', () => {
    // Two users on the same project get different catalogs. Sharing one cache
    // slot would serve a manager's secrets list to a member, and would strand a
    // member on "unavailable" for the whole staleTime after they are granted
    // the leaf.
    expect(sessionScopeCatalogQueryKey('project-1', { secrets: false, connectors: true })).toEqual([
      'session-scope-catalog',
      'project-1',
      false,
      true,
    ]);
    expect(sessionScopeCatalogQueryKey('project-1', { secrets: false, connectors: true })).not.toEqual(
      sessionScopeCatalogQueryKey('project-1'),
    );
  });
});

describe('loadSessionScopeCatalog', () => {
  test('loads all catalog axes as ready states', async () => {
    const calls: string[] = [];
    const result = await loadSessionScopeCatalog('project-1', {
      listSecrets: async (projectId) => {
        calls.push(`secrets:${projectId}`);
        return [secret('MAIL_TOKEN')];
      },
      listConnectors: async (projectId) => {
        calls.push(`connectors:${projectId}`);
        return [connector('mail')];
      },
      listConnections: async (projectId) => {
        calls.push(`connections:${projectId}`);
        return [connection('connection-mail')];
      },
    });

    expect(calls).toEqual([
      'secrets:project-1',
      'connectors:project-1',
      'connections:project-1',
    ]);
    expect(result.raw.secrets).toEqual({
      status: 'ready',
      items: [secret('MAIL_TOKEN')],
    });
    expect(result.raw.connectors).toEqual({
      status: 'ready',
      items: [connector('mail')],
    });
    expect(result.raw.connections).toEqual({
      status: 'ready',
      items: [connection('connection-mail')],
    });
    expect(result.errors).toEqual({
      secrets: null,
      connectors: null,
      connections: null,
    });
  });

  test('keeps failed axes unavailable and preserves successful empty catalogs', async () => {
    const result = await loadSessionScopeCatalog('project-1', {
      listSecrets: async () => {
        throw new Error('secret catalog denied');
      },
      listConnectors: async () => [],
      listConnections: async () => {
        throw new Error('connection catalog denied');
      },
    });

    expect(result.raw.secrets).toEqual({ status: 'unavailable' });
    expect(result.raw.connectors).toEqual({ status: 'ready', items: [] });
    expect(result.raw.connections).toEqual({ status: 'unavailable' });
    expect(result.errors.secrets?.message).toBe('secret catalog denied');
    expect(result.errors.connectors).toBeNull();
    expect(result.errors.connections?.message).toBe('connection catalog denied');
  });

  test('an unpermitted axis is NOT requested', async () => {
    // The point of the permits. A project `member` holds neither
    // project.secret.read nor project.connector.read, so both of these used to
    // be sent and refused — two 403s on every project-home load.
    const calls: string[] = [];
    const result = await loadSessionScopeCatalog(
      'project-1',
      {
        listSecrets: async () => {
          calls.push('secrets');
          return [secret('MAIL_TOKEN')];
        },
        listConnectors: async () => {
          calls.push('connectors');
          return [connector('mail')];
        },
        listConnections: async () => {
          calls.push('connections');
          return [connection('conn-1')];
        },
      },
      { secrets: false, connectors: false },
    );

    expect(calls).toEqual(['connections']);
    expect(result.raw.secrets).toEqual({ status: 'unavailable' });
    expect(result.raw.connectors).toEqual({ status: 'unavailable' });
    // Connections stays in: project.connector.connections IS in the member
    // baseline, and that endpoint answers 200 for a member.
    expect(result.raw.connections).toEqual({ status: 'ready', items: [connection('conn-1')] });
  });

  test('a skipped axis reports no error — it did not fail, it was never asked', async () => {
    // `firstCatalogError` drives a visible failure state. A permission the user
    // simply does not hold is not a failure, so nothing must surface.
    const result = await loadSessionScopeCatalog(
      'project-1',
      {
        listSecrets: async () => [secret('MAIL_TOKEN')],
        listConnectors: async () => [connector('mail')],
        listConnections: async () => [connection('conn-1')],
      },
      { secrets: false, connectors: true },
    );

    expect(result.raw.secrets).toEqual({ status: 'unavailable' });
    expect(result.errors.secrets).toBeNull();
    expect(result.raw.connectors).toEqual({ status: 'ready', items: [connector('mail')] });
  });
});

// Source pins. Both call sites gate a query on a manager-tier leaf; neither
// behaviour is observable from the pure loader above, and both are one careless
// edit away from silently sending the request again.
const scopeSrc = await Bun.file(
  new URL('./use-session-scope.ts', import.meta.url).pathname,
).text();
const gateSrc = await Bun.file(
  new URL('../use-model-connection-gate.tsx', import.meta.url).pathname,
).text();

describe('project-home makes no request it knows will 403', () => {
  test('the scope catalog probes both leaves and holds the query until they answer', () => {
    expect(scopeSrc).toContain('useProjectCans');
    expect(scopeSrc).toContain('PROJECT_ACTIONS.PROJECT_SECRET_READ');
    expect(scopeSrc).toContain('PROJECT_ACTIONS.PROJECT_CONNECTOR_READ');
    // Without the resolved-gate the query fires once with the loading default
    // (both false) and again with the real answer.
    expect(scopeSrc).toContain('catalogPermitsResolved');
    expect(scopeSrc).toContain('enabled: Boolean(projectId) && catalogPermitsResolved');
  });

  test('the model connection gate requires project.secret.read before listing secrets', () => {
    expect(gateSrc).toContain('PROJECT_ACTIONS.PROJECT_SECRET_READ');
    expect(gateSrc).toContain('llmGatewayEnabled && canReadSecrets');
  });
});
