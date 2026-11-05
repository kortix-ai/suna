import { describe, expect, test } from 'bun:test';
import {
  asLegacyWorkspaceRoute,
  canonicalWorkspaceRoute,
  isWorkspaceAccountFamily,
  legacyWorkspaceRoute,
  renameWorkspaceRouteParams,
} from './workspace-routes';

const WS = '0b6f9b3c-2a51-4b7e-9c11-5d2a8f0e7a10';

describe('canonicalWorkspaceRoute', () => {
  test.each([
    ['/v1/projects', '/v1/workspaces'],
    ['/v1/projects/:workspaceId/sessions', '/v1/workspaces/:workspaceId/sessions'],
    [`/v1/projects/${WS}/sessions`, `/v1/workspaces/${WS}/sessions`],
    ['/v1/accounts/:workspaceId/iam/groups', '/v1/workspaces/:workspaceId/iam/groups'],
    ['/v1/accounts/:workspaceId/audit', '/v1/workspaces/:workspaceId/audit'],
    ['/v1/accounts/:workspaceId/tokens', '/v1/workspaces/:workspaceId/tokens'],
    ['/v1/accounts/me', '/v1/me'],
    ['/v1/accounts/me/devices', '/v1/me/devices'],
    ['/v1/account-invites/:inviteId/accept', '/v1/invites/:inviteId/accept'],
    ['/v1/connectors/projects/:workspaceId/connectors', '/v1/connectors/workspaces/:workspaceId/connectors'],
    ['/scim/v2/accounts/:workspaceId/Users', '/scim/v2/workspaces/:workspaceId/Users'],
  ])('%s → %s', (legacy, canonical) => {
    expect(canonicalWorkspaceRoute(legacy)).toBe(canonical);
    expect(legacyWorkspaceRoute(canonical)).toBe(legacy);
  });

  test.each([
    '/v1/accounts',
    '/v1/accounts/:workspaceId',
    '/v1/accounts/tokens',
    '/v1/accounts/tokens/:tokenId',
    '/v1/billing/account-state',
    '/v1/projectsx',
    '/v1/webhooks/slack/:workspaceId',
  ])('%s has no canonical alias', (path) => {
    expect(canonicalWorkspaceRoute(path)).toBeNull();
  });
});

describe('legacyWorkspaceRoute', () => {
  test('a workspace route that is not an account family is a project route', () => {
    expect(legacyWorkspaceRoute(`/v1/workspaces/${WS}`)).toBe(`/v1/projects/${WS}`);
    expect(legacyWorkspaceRoute('/v1/workspaces/current')).toBe('/v1/projects/current');
    expect(legacyWorkspaceRoute(`/v1/workspaces/${WS}/sessions/s1/audit`)).toBe(`/v1/projects/${WS}/sessions/s1/audit`);
  });

  test('non-workspace paths pass through asLegacyWorkspaceRoute unchanged', () => {
    expect(asLegacyWorkspaceRoute('/v1/billing/plan')).toBe('/v1/billing/plan');
    expect(asLegacyWorkspaceRoute('/v1/meetings')).toBe('/v1/meetings');
    expect(asLegacyWorkspaceRoute('/v1/invitesx')).toBe('/v1/invitesx');
  });
});

describe('families and params', () => {
  test('account families', () => {
    expect(isWorkspaceAccountFamily('iam')).toBe(true);
    expect(isWorkspaceAccountFamily('sessions')).toBe(false);
    expect(isWorkspaceAccountFamily(undefined)).toBe(false);
  });

  test('pre-2026-11-05 templates name the id :projectId / :accountId', () => {
    expect(renameWorkspaceRouteParams('/v1/projects/:projectId/sessions/:sessionId')).toBe(
      '/v1/projects/:workspaceId/sessions/:sessionId',
    );
    expect(renameWorkspaceRouteParams('/v1/accounts/:accountId/iam')).toBe('/v1/accounts/:workspaceId/iam');
    expect(renameWorkspaceRouteParams('/v1/x/:projectIdish')).toBe('/v1/x/:projectIdish');
  });
});
