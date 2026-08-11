import type { WorkspaceAdminConnector, Connection, WorkspaceSecret } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import {
  loadSessionScopeCatalog,
  sessionScopeCatalogQueryKey,
  sessionScopeQueryKey,
} from './use-session-scope';

const secret = (identifier: string): WorkspaceSecret => ({
  identifier,
  name: identifier,
  workspace_id: 'workspace-1',
  secret_id: `secret-${identifier}`,
  created_by: null,
  created_at: null,
  updated_at: null,
  configured: true,
  mine: null,
  effective_source: 'shared',
  can_manage_shared: false,
});

const connector = (slug: string): WorkspaceAdminConnector => ({
  slug,
  name: slug,
  provider: 'pipedream',
  status: 'active',
  credentialMode: 'shared',
  authorizationStrategy: 'workspace',
  sensitive: false,
  actions: [],
  authSecret: null,
  secretSet: true,
});

const connection = (connectionId: string): Connection => ({
  connection_id: connectionId,
  connector_alias: 'mail',
  owner_type: 'workspace',
  owner_id: null,
  label: connectionId,
  status: 'active',
  is_default: true,
  metadata: {},
});

describe('session scope query keys', () => {
  test('uses the shared scope and catalog cache keys', () => {
    expect(sessionScopeQueryKey('workspace-1', 'session-1')).toEqual([
      'workspace-session-scope',
      'workspace-1',
      'session-1',
    ]);
    expect(sessionScopeCatalogQueryKey('workspace-1')).toEqual([
      'session-scope-catalog',
      'workspace-1',
    ]);
  });
});

describe('loadSessionScopeCatalog', () => {
  test('loads all catalog axes as ready states', async () => {
    const calls: string[] = [];
    const result = await loadSessionScopeCatalog('workspace-1', {
      listSecrets: async (workspaceId) => {
        calls.push(`secrets:${workspaceId}`);
        return [secret('MAIL_TOKEN')];
      },
      listConnectors: async (workspaceId) => {
        calls.push(`connectors:${workspaceId}`);
        return [connector('mail')];
      },
      listConnections: async (workspaceId) => {
        calls.push(`connections:${workspaceId}`);
        return [connection('connection-mail')];
      },
    });

    expect(calls).toEqual([
      'secrets:workspace-1',
      'connectors:workspace-1',
      'connections:workspace-1',
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
    const result = await loadSessionScopeCatalog('workspace-1', {
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
});
