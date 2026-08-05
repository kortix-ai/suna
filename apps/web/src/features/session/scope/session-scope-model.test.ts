import type {
  AdminConnector,
  ConnectorAuthorization,
  ProjectSecret,
  SessionScope,
} from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import {
  buildSessionScopeReplacement,
  buildSessionScopeSelectionCatalog,
  createNewSessionScopeDraft,
  createSessionScopeDraft,
  type SessionScopeCatalogState,
} from './session-scope-model';

const scope = (overrides: Partial<SessionScope> = {}): SessionScope => ({
  secrets_allowlist: ['MAIL_TOKEN', 'ISSUE_TOKEN'],
  required_connectors: null,
  connector_bindings: {
    'mail-read': { authorization_id: 'authorization-mail-1' },
    issues: { authorization_id: 'authorization-issues-1' },
  },
  dropped_secrets: [],
  added_secrets: [],
  dropped_bindings: [],
  retroactive: true,
  detail: 'Current session scope.',
  ...overrides,
});

const secret = (identifier: string, overrides: Partial<ProjectSecret> = {}): ProjectSecret => ({
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
  ...overrides,
});

const connector = (
  slug: string,
  authorizationStrategy: AdminConnector['authorizationStrategy'],
  overrides: Partial<AdminConnector> = {},
): AdminConnector => ({
  slug,
  name: slug,
  provider: 'pipedream',
  status: 'active',
  credentialMode: 'shared',
  authorizationStrategy,
  sensitive: false,
  actions: [],
  authSecret: null,
  secretSet: true,
  ...overrides,
});

const authorization = (
  profileId: string,
  connectorAlias: string,
  ownerType: ConnectorAuthorization['owner_type'],
  overrides: Partial<ConnectorAuthorization> = {},
): ConnectorAuthorization => ({
  profile_id: profileId,
  connector_alias: connectorAlias,
  owner_type: ownerType,
  owner_id: ownerType === 'project' ? null : 'user-1',
  label: profileId,
  status: 'active',
  is_default: false,
  metadata: {},
  ...overrides,
});

const ready = <T>(items: readonly T[]): SessionScopeCatalogState<T> => ({
  status: 'ready',
  items,
});

const unavailable = <T>(): SessionScopeCatalogState<T> => ({ status: 'unavailable' });

describe('createSessionScopeDraft', () => {
  test('preserves an unrestricted secret grant as null', () => {
    expect(createSessionScopeDraft(scope({ secrets_allowlist: null })).secrets).toBeNull();
  });

  test('preserves an explicit no-secrets grant as an empty list', () => {
    expect(createSessionScopeDraft(scope({ secrets_allowlist: [] })).secrets).toEqual([]);
  });

  test('copies authoritative connector bindings with canonical authorization IDs', () => {
    expect(createSessionScopeDraft(scope()).connector_bindings).toEqual({
      'mail-read': { authorization_id: 'authorization-mail-1' },
      issues: { authorization_id: 'authorization-issues-1' },
    });
  });

  test('omits an axis whose catalog is unavailable', () => {
    const catalog = buildSessionScopeSelectionCatalog({
      secrets: unavailable(),
      connectors: ready([]),
      authorizations: unavailable(),
      grants: { secrets: 'all', connectors: 'all' },
    });

    expect(createSessionScopeDraft(scope(), catalog)).toEqual({});
  });

  test('keeps axes for loaded empty catalogs', () => {
    const catalog = buildSessionScopeSelectionCatalog({
      secrets: ready([]),
      connectors: ready([]),
      authorizations: ready([]),
      grants: { secrets: 'all', connectors: 'all' },
    });

    expect(createSessionScopeDraft(scope({ secrets_allowlist: [] }), catalog)).toEqual({
      secrets: [],
      connector_bindings: {
        'mail-read': { authorization_id: 'authorization-mail-1' },
        issues: { authorization_id: 'authorization-issues-1' },
      },
      require_connectors: [],
    });
  });
});

describe('createNewSessionScopeDraft', () => {
  test('starts with unrestricted secrets (null) and no connector authorizations selected', () => {
    // `null` is the no-override state — "inherit everything the agent's grant
    // allows", identical to how a server-created session starts. `[]` would be an
    // explicit "inject zero project secrets", which silently denied every
    // browser-created session its grant. A user who deliberately wants zero can
    // still get `[]` via `setAllSessionSecrets(draft, false)`; the two are
    // opposite and must not be conflated.
    const catalog = buildSessionScopeSelectionCatalog({
      secrets: ready([secret('MAIL_TOKEN')]),
      connectors: ready([connector('mail-read', 'project'), connector('issues', 'user')]),
      authorizations: ready([
        authorization('authorization-mail-secondary', 'mail-read', 'project'),
        authorization('authorization-mail-default', 'mail-read', 'project', {
          is_default: true,
        }),
        authorization('authorization-issues-only', 'issues', 'member'),
      ]),
    });

    expect(createNewSessionScopeDraft(catalog)).toEqual({
      secrets: null,
      connector_bindings: {},
      require_connectors: [],
    });
  });

  test('preserves null secrets even when the secret catalog is ready but empty', () => {
    // An empty (but loaded) secret catalog is still "no override" for a new
    // session — the grant ceiling happens to list nothing, so `null` and `[]`
    // happen to deliver the same set, but the SEMANTICS differ and a later grant
    // expansion must widen a `null` session automatically. Stay `null`.
    const catalog = buildSessionScopeSelectionCatalog({
      secrets: ready([]),
      connectors: ready([]),
      authorizations: ready([]),
      grants: { secrets: 'all', connectors: 'all' },
    });

    expect(createNewSessionScopeDraft(catalog)).toEqual({
      secrets: null,
      connector_bindings: {},
      require_connectors: [],
    });
  });

  test('omits axes whose catalogs are unavailable', () => {
    expect(
      createNewSessionScopeDraft({
        secrets: { status: 'unavailable' },
        connector_profiles: { status: 'unavailable' },
      }),
    ).toEqual({});
  });
});

describe('buildSessionScopeReplacement', () => {
  test('sends each present axis as a complete replacement', () => {
    expect(
      buildSessionScopeReplacement({
        secrets: ['ISSUE_TOKEN'],
        connector_bindings: {
          issues: { authorization_id: 'authorization-issues-2' },
        },
        require_connectors: [],
      }),
    ).toEqual({
      secrets: ['ISSUE_TOKEN'],
      connector_bindings: {
        issues: { authorization_id: 'authorization-issues-2' },
      },
      require_connectors: [],
    });
  });

  test('uses authorization_id without the deprecated profile_id field', () => {
    const replacement = buildSessionScopeReplacement({
      connector_bindings: {
        'mail-read': { authorization_id: 'authorization-mail-2' },
      },
      require_connectors: [],
    });

    expect(replacement.connector_bindings).toEqual({
      'mail-read': { authorization_id: 'authorization-mail-2' },
    });
    expect(JSON.stringify(replacement)).not.toContain('profile_id');
  });

  test('preserves omitted axes', () => {
    expect(buildSessionScopeReplacement({ secrets: null })).toEqual({ secrets: null });
    // `require_connectors` is absent from BOTH the draft and any previous scope,
    // so it stays out of the replacement — sending `[]` would be an instruction
    // to clear every requirement the session has, off a request that said nothing
    // about them. Omitted and empty are opposite here, exactly as for secrets.
    expect(buildSessionScopeReplacement({ connector_bindings: {} })).toEqual({
      connector_bindings: {},
    });
  });

  test('a new-session draft with null secrets stays null in the replacement', () => {
    // Regression: `createNewSessionScopeDraft` returns `secrets: null` (no
    // override). The replacement MUST carry `null` — "stop narrowing, inherit the
    // grant" — not `[]` ("inject zero project secrets"). The two are opposite, and
    // flipping null to [] silently denied every browser-created session its grant.
    expect(
      buildSessionScopeReplacement({
        secrets: null,
        connector_bindings: {},
        require_connectors: [],
      }),
    ).toEqual({
      secrets: null,
      connector_bindings: {},
      require_connectors: [],
    });
  });

  test('completes available axes from authoritative read-back', () => {
    expect(
      buildSessionScopeReplacement({ secrets: ['MAIL_TOKEN'] }, scope(), {
        secrets: true,
        connector_bindings: true,
      }),
    ).toEqual({
      secrets: ['MAIL_TOKEN'],
      connector_bindings: {
        'mail-read': { authorization_id: 'authorization-mail-1' },
        issues: { authorization_id: 'authorization-issues-1' },
      },
      require_connectors: [],
    });
  });

  test('omits an authoritative axis when its catalog is unavailable', () => {
    expect(
      buildSessionScopeReplacement({ secrets: [] }, scope(), {
        secrets: true,
        connector_bindings: false,
      }),
    ).toEqual({ secrets: [] });
  });
});

describe('buildSessionScopeSelectionCatalog', () => {
  test('filters secrets and connector profiles to explicit agent grants', () => {
    const result = buildSessionScopeSelectionCatalog({
      secrets: ready([secret('MAIL_TOKEN'), secret('ISSUE_TOKEN'), secret('UNUSED_TOKEN')]),
      connectors: ready([
        connector('mail-read', 'project'),
        connector('issues', 'user'),
        connector('storage', 'project'),
      ]),
      authorizations: ready([
        authorization('authorization-mail-1', 'mail-read', 'project'),
        authorization('authorization-issues-1', 'issues', 'member'),
      ]),
      grants: {
        secrets: ['MAIL_TOKEN', 'ISSUE_TOKEN'],
        connectors: ['mail-read', 'issues'],
      },
    });

    expect(result.secrets).toEqual({
      status: 'ready',
      items: [
        { identifier: 'MAIL_TOKEN', name: 'MAIL_TOKEN' },
        { identifier: 'ISSUE_TOKEN', name: 'ISSUE_TOKEN' },
      ],
    });
    expect(
      result.connector_profiles.status === 'ready'
        ? result.connector_profiles.items.map((item) => item.slug)
        : [],
    ).toEqual(['mail-read', 'issues']);
  });

  test('treats an ungoverned grant as all and none as empty', () => {
    const inputs = {
      secrets: ready([secret('MAIL_TOKEN')]),
      connectors: ready([connector('mail-read', 'project')]),
      authorizations: ready([authorization('authorization-mail-1', 'mail-read', 'project')]),
    };

    const ungoverned = buildSessionScopeSelectionCatalog({
      ...inputs,
      grants: {},
    });
    const none = buildSessionScopeSelectionCatalog({
      ...inputs,
      grants: { secrets: 'none', connectors: 'none' },
    });

    expect(ungoverned.secrets.status === 'ready' ? ungoverned.secrets.items : []).toHaveLength(1);
    expect(
      ungoverned.connector_profiles.status === 'ready' ? ungoverned.connector_profiles.items : [],
    ).toHaveLength(1);
    expect(none.secrets).toEqual({ status: 'ready', items: [] });
    expect(none.connector_profiles).toEqual({ status: 'ready', items: [] });
  });

  test('offers only project authorizations for project strategy profiles', () => {
    const result = buildSessionScopeSelectionCatalog({
      secrets: ready([]),
      connectors: ready([connector('mail-read', 'project')]),
      authorizations: ready([
        authorization('project-active', 'mail-read', 'project', { is_default: true }),
        authorization('member-active', 'mail-read', 'member'),
        authorization('project-revoked', 'mail-read', 'project', { status: 'revoked' }),
        authorization('other-project', 'issues', 'project'),
      ]),
      grants: { connectors: 'all' },
    });

    expect(result.connector_profiles).toEqual({
      status: 'ready',
      items: [
        {
          slug: 'mail-read',
          name: 'mail-read',
          authorization_strategy: 'project',
          authorizations: [
            {
              authorization_id: 'project-active',
              label: 'project-active',
              is_default: true,
            },
          ],
        },
      ],
    });
  });

  test('offers only current-user authorizations for user strategy profiles', () => {
    const result = buildSessionScopeSelectionCatalog({
      secrets: ready([]),
      connectors: ready([connector('issues', 'user')]),
      authorizations: ready([
        authorization('member-active', 'issues', 'member'),
        authorization('project-active', 'issues', 'project'),
        authorization('member-error', 'issues', 'member', { status: 'error' }),
      ]),
      grants: { connectors: 'all' },
    });

    expect(result.connector_profiles).toEqual({
      status: 'ready',
      items: [
        {
          slug: 'issues',
          name: 'issues',
          authorization_strategy: 'user',
          authorizations: [
            {
              authorization_id: 'member-active',
              label: 'member-active',
              is_default: false,
            },
          ],
        },
      ],
    });
  });

  test('preserves catalog failures instead of converting them to empty lists', () => {
    const secretsUnavailable = buildSessionScopeSelectionCatalog({
      secrets: unavailable(),
      connectors: ready([]),
      authorizations: ready([]),
      grants: {},
    });
    const authorizationsUnavailable = buildSessionScopeSelectionCatalog({
      secrets: ready([]),
      connectors: ready([connector('mail-read', 'project')]),
      authorizations: unavailable(),
      grants: {},
    });

    expect(secretsUnavailable.secrets).toEqual({ status: 'unavailable' });
    expect(authorizationsUnavailable.connector_profiles).toEqual({ status: 'unavailable' });
  });
});
