import type { AdminConnector, ConnectorAuthorization, ProjectSecret } from '@kortix/sdk';
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

const authorization = (profileId: string): ConnectorAuthorization => ({
  profile_id: profileId,
  connector_alias: 'mail',
  owner_type: 'project',
  owner_id: null,
  label: profileId,
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
    ]);
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
      listAuthorizations: async (projectId) => {
        calls.push(`authorizations:${projectId}`);
        return [authorization('authorization-mail')];
      },
    });

    expect(calls).toEqual([
      'secrets:project-1',
      'connectors:project-1',
      'authorizations:project-1',
    ]);
    expect(result.raw.secrets).toEqual({
      status: 'ready',
      items: [secret('MAIL_TOKEN')],
    });
    expect(result.raw.connectors).toEqual({
      status: 'ready',
      items: [connector('mail')],
    });
    expect(result.raw.authorizations).toEqual({
      status: 'ready',
      items: [authorization('authorization-mail')],
    });
    expect(result.errors).toEqual({
      secrets: null,
      connectors: null,
      authorizations: null,
    });
  });

  test('keeps failed axes unavailable and preserves successful empty catalogs', async () => {
    const result = await loadSessionScopeCatalog('project-1', {
      listSecrets: async () => {
        throw new Error('secret catalog denied');
      },
      listConnectors: async () => [],
      listAuthorizations: async () => {
        throw new Error('authorization catalog denied');
      },
    });

    expect(result.raw.secrets).toEqual({ status: 'unavailable' });
    expect(result.raw.connectors).toEqual({ status: 'ready', items: [] });
    expect(result.raw.authorizations).toEqual({ status: 'unavailable' });
    expect(result.errors.secrets?.message).toBe('secret catalog denied');
    expect(result.errors.connectors).toBeNull();
    expect(result.errors.authorizations?.message).toBe('authorization catalog denied');
  });
});
