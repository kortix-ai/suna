import { describe, expect, test } from 'bun:test';
import {
  WORKSPACE_LEGACY_ONLY_ROUTES,
  WORKSPACE_LEGACY_REPLACEMENTS,
  WORKSPACE_MERGED_LEGACY_ROUTES,
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
    // The project audit slice: `/v1/workspaces/:workspaceId/audit` is the workspace audit log.
    ['/v1/projects/:workspaceId/audit', '/v1/workspaces/:workspaceId/audit/events'],
    [`/v1/projects/${WS}/audit`, `/v1/workspaces/${WS}/audit/events`],
    ['/v1/webhooks/projects/:workspaceId/:slug', '/v1/webhooks/workspaces/:workspaceId/:slug'],
    ['/v1/projects/:workspaceId/transfer', '/v1/workspaces/:workspaceId/transfer'],
    ['/v1/projects/create-repo', '/v1/workspaces/create-repo'],
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

describe('legacy routes with their own meaning', () => {
  test('every merged and legacy-only route names its canonical replacement', () => {
    for (const route of [...WORKSPACE_MERGED_LEGACY_ROUTES, ...WORKSPACE_LEGACY_ONLY_ROUTES]) {
      expect({ route, replacement: typeof WORKSPACE_LEGACY_REPLACEMENTS[route] }).toEqual({ route, replacement: 'string' });
    }
  });

  test('each replacement is a canonical route', () => {
    for (const [route, replacement] of Object.entries(WORKSPACE_LEGACY_REPLACEMENTS)) {
      expect({ route, replacement }).toEqual({ route, replacement: expect.stringMatching(/^(GET|POST|PATCH|DELETE) \/v1\/(workspaces|me)(\/|$)/) });
    }
  });

  test('the account record, the account list and the query-scoped token routes are deprecated for their workspace routes', () => {
    expect(WORKSPACE_LEGACY_REPLACEMENTS['GET /v1/accounts']).toBe('GET /v1/workspaces');
    expect(WORKSPACE_LEGACY_REPLACEMENTS['PATCH /v1/accounts/:workspaceId']).toBe('PATCH /v1/workspaces/:workspaceId');
    expect(WORKSPACE_LEGACY_REPLACEMENTS['GET /v1/accounts/tokens']).toBe('GET /v1/workspaces/:workspaceId/tokens');
  });

  test('transfer and the repository creates are aliases now, not legacy-only', () => {
    for (const route of ['POST /v1/projects/:workspaceId/transfer', 'POST /v1/projects/create-repo', 'POST /v1/projects/link-repository', 'GET /v1/projects/:workspaceId/audit']) {
      expect([...WORKSPACE_MERGED_LEGACY_ROUTES, ...WORKSPACE_LEGACY_ONLY_ROUTES]).not.toContain(route);
    }
  });
});
