import type { WorkspaceAdminConnector, Connection, WorkspaceSecret, SessionScope } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import {
  buildSessionScopeReplacement,
  buildSessionScopeSelectionCatalog,
  createNewSessionScopeDraft,
  createSessionScopeDraft,
  resetSessionConnectorBindings,
  resetSessionSecrets,
  sessionConnectorsSummary,
  sessionSecretsSummary,
  type SessionScopeCatalogState,
} from './session-scope-model';

const scope = (overrides: Partial<SessionScope> = {}): SessionScope => ({
  secrets_allowlist: ['MAIL_TOKEN', 'ISSUE_TOKEN'],
  required_connectors: null,
  connector_bindings: {
    'mail-read': { connection_id: 'connection-mail-1' },
    issues: { connection_id: 'connection-issues-1' },
  },
  dropped_secrets: [],
  added_secrets: [],
  dropped_bindings: [],
  retroactive: true,
  connector_bindings_configured: false,
  connector_bindings_inherit_unbound: true,
  detail: 'Current session scope.',
  ...overrides,
});

const secret = (identifier: string, overrides: Partial<WorkspaceSecret> = {}): WorkspaceSecret => ({
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
  ...overrides,
});

const connector = (
  slug: string,
  authorizationStrategy: WorkspaceAdminConnector['authorizationStrategy'],
  overrides: Partial<WorkspaceAdminConnector> = {},
): WorkspaceAdminConnector => ({
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

const connection = (
  connectionId: string,
  connectorAlias: string,
  ownerType: Connection['owner_type'],
  overrides: Partial<Connection> = {},
): Connection => ({
  connection_id: connectionId,
  connector_alias: connectorAlias,
  owner_type: ownerType,
  owner_id: ownerType === 'workspace' ? null : 'user-1',
  label: connectionId,
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

  test('copies authoritative connector bindings with canonical connection IDs', () => {
    expect(createSessionScopeDraft(scope()).connector_bindings).toEqual({
      'mail-read': { connection_id: 'connection-mail-1' },
      issues: { connection_id: 'connection-issues-1' },
    });
  });

  test('omits an axis whose catalog is unavailable', () => {
    const catalog = buildSessionScopeSelectionCatalog({
      secrets: unavailable(),
      connectors: ready([]),
      connections: unavailable(),
      grants: { secrets: 'all', connectors: 'all' },
    });

    expect(createSessionScopeDraft(scope(), catalog)).toEqual({});
  });

  test('keeps axes for loaded empty catalogs', () => {
    const catalog = buildSessionScopeSelectionCatalog({
      secrets: ready([]),
      connectors: ready([]),
      connections: ready([]),
      grants: { secrets: 'all', connectors: 'all' },
    });

    expect(createSessionScopeDraft(scope({ secrets_allowlist: [] }), catalog)).toEqual({
      secrets: [],
      connector_bindings: {
        'mail-read': { connection_id: 'connection-mail-1' },
        issues: { connection_id: 'connection-issues-1' },
      },
      connector_bindings_inherited: true,
      require_connectors: [],
    });
  });

  test('marks connectors inherited when the session holds no override', () => {
    // The scope read-back returns SERVER-RESOLVED bindings, which look the same
    // for an inherited session and an overridden one. Without this marker the
    // draft treated the preview as a user selection and posted it back, so an
    // untouched Save wrote an override nobody asked for.
    expect(
      createSessionScopeDraft(scope({ connector_bindings_configured: false }))
        .connector_bindings_inherited,
    ).toBe(true);
  });

  test('leaves a configured override as an explicit selection', () => {
    expect(
      createSessionScopeDraft(scope({ connector_bindings_configured: true }))
        .connector_bindings_inherited,
    ).toBe(false);
  });
});

describe('session scope summaries', () => {
  test('names an inherited axis the workspace default, never "none"', () => {
    expect(sessionSecretsSummary({ secrets: null })).toBe('Workspace default');
    expect(
      sessionConnectorsSummary({
        connector_bindings: { mail: { connection_id: 'connection-mail-1' } },
        connector_bindings_inherited: true,
      }),
    ).toBe('Workspace default');
  });

  test('names an explicit empty override honestly', () => {
    // Opposite of the line above: the user deliberately deselected everything.
    expect(sessionSecretsSummary({ secrets: [] })).toBe('None allowed');
    expect(
      sessionConnectorsSummary({ connector_bindings: {}, connector_bindings_inherited: false }),
    ).toBe('None allowed');
  });

  test('counts explicit selections, including a required unconnected alias', () => {
    expect(sessionSecretsSummary({ secrets: ['MAIL_TOKEN', 'ISSUE_TOKEN'] })).toBe('2 selected');
    expect(
      sessionConnectorsSummary({
        connector_bindings: { mail: { connection_id: 'connection-mail-1' } },
        connector_bindings_inherited: false,
        require_connectors: ['issues'],
      }),
    ).toBe('2 selected');
  });
});

describe('resetting an axis to the workspace default', () => {
  const catalog = () =>
    buildSessionScopeSelectionCatalog({
      secrets: ready([secret('MAIL_TOKEN')]),
      connectors: ready([connector('mail-read', 'workspace')]),
      connections: ready([
        connection('connection-mail-default', 'mail-read', 'workspace', { is_default: true }),
      ]),
      grants: { secrets: 'all', connectors: 'all' },
    });

  test('secrets go back to inheriting the agent grant', () => {
    expect(resetSessionSecrets({ secrets: ['MAIL_TOKEN'] })).toEqual({ secrets: null });
  });

  test('connectors go back to inherited, previewing the workspace defaults', () => {
    expect(
      resetSessionConnectorBindings(
        {
          connector_bindings: { 'mail-read': { connection_id: 'hand-picked' } },
          connector_bindings_inherited: false,
          require_connectors: ['issues'],
        },
        catalog(),
      ),
    ).toEqual({
      connector_bindings: { 'mail-read': { connection_id: 'connection-mail-default' } },
      connector_bindings_inherited: true,
      require_connectors: [],
    });
  });

  test('a reset on a configured session sends the null clear verb', () => {
    // An override the user cannot switch off is a trap. `null` is the only
    // request that removes one; omitting the key would leave it in place.
    expect(
      buildSessionScopeReplacement(
        resetSessionConnectorBindings({ connector_bindings: {} }, catalog()),
        scope({ connector_bindings_configured: true }),
      ),
    ).toEqual({
      secrets: ['MAIL_TOKEN', 'ISSUE_TOKEN'],
      connector_bindings: null,
      require_connectors: [],
    });
  });
});

describe('createNewSessionScopeDraft', () => {
  test('starts with unrestricted secrets and every available default connection', () => {
    // `null` is the no-override state — "inherit everything the agent's grant
    // allows", identical to how a server-created session starts. `[]` would be an
    // explicit "inject zero workspace secrets", which silently denied every
    // browser-created session its grant. A user who deliberately wants zero can
    // still get `[]` via `setAllSessionSecrets(draft, false)`; the two are
    // opposite and must not be conflated.
    const catalog = buildSessionScopeSelectionCatalog({
      secrets: ready([secret('MAIL_TOKEN')]),
      connectors: ready([connector('mail-read', 'workspace'), connector('issues', 'user')]),
      connections: ready([
        connection('connection-mail-secondary', 'mail-read', 'workspace'),
        connection('connection-mail-default', 'mail-read', 'workspace', {
          is_default: true,
        }),
        connection('connection-issues-only', 'issues', 'member'),
      ]),
    });

    expect(createNewSessionScopeDraft(catalog)).toEqual({
      secrets: null,
      connector_bindings: {
        'mail-read': { connection_id: 'connection-mail-default' },
        issues: { connection_id: 'connection-issues-only' },
      },
      connector_bindings_inherited: true,
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
      connections: ready([]),
      grants: { secrets: 'all', connectors: 'all' },
    });

    expect(createNewSessionScopeDraft(catalog)).toEqual({
      secrets: null,
      connector_bindings: {},
      connector_bindings_inherited: true,
      require_connectors: [],
    });
  });

  test('omits axes whose catalogs are unavailable', () => {
    expect(
      createNewSessionScopeDraft({
        secrets: { status: 'unavailable' },
        connector_connections: { status: 'unavailable' },
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
          issues: { connection_id: 'connection-issues-2' },
        },
        require_connectors: [],
      }),
    ).toEqual({
      secrets: ['ISSUE_TOKEN'],
      connector_bindings: {
        issues: { connection_id: 'connection-issues-2' },
      },
      require_connectors: [],
    });
  });

  test('uses connection_id without deprecated binding fields', () => {
    const replacement = buildSessionScopeReplacement({
      connector_bindings: {
        'mail-read': { connection_id: 'connection-mail-2' },
      },
      require_connectors: [],
    });

    expect(replacement.connector_bindings).toEqual({
      'mail-read': { connection_id: 'connection-mail-2' },
    });
    expect(JSON.stringify(replacement)).not.toContain('authorization_id');
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
    // grant" — not `[]` ("inject zero workspace secrets"). The two are opposite, and
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

  test('keeps untouched connector defaults on server-side inheritance', () => {
    expect(
      buildSessionScopeReplacement({
        secrets: null,
        connector_bindings: {
          mail: { connection_id: 'stale-client-default' },
        },
        connector_bindings_inherited: true,
        require_connectors: [],
      }),
    ).toEqual({
      secrets: null,
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
        'mail-read': { connection_id: 'connection-mail-1' },
        issues: { connection_id: 'connection-issues-1' },
      },
      require_connectors: [],
    });
  });

  test('an untouched save on an unconfigured session sends no connector key', () => {
    // THE regression. An existing session that never overrode its connectors
    // read back server-resolved bindings, and Save posted them as an explicit
    // replacement — turning "inherit the workspace defaults" into a frozen
    // override, and an empty resolve into an explicit zero-connector session.
    const previous = scope({ connector_bindings_configured: false });

    const replacement = buildSessionScopeReplacement(createSessionScopeDraft(previous), previous);

    expect(Object.hasOwn(replacement, 'connector_bindings')).toBe(false);
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
  test('filters secrets and connectors to explicit agent grants', () => {
    const result = buildSessionScopeSelectionCatalog({
      secrets: ready([secret('MAIL_TOKEN'), secret('ISSUE_TOKEN'), secret('UNUSED_TOKEN')]),
      connectors: ready([
        connector('mail-read', 'workspace'),
        connector('issues', 'user'),
        connector('storage', 'workspace'),
      ]),
      connections: ready([
        connection('connection-mail-1', 'mail-read', 'workspace'),
        connection('connection-issues-1', 'issues', 'member'),
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
      result.connector_connections.status === 'ready'
        ? result.connector_connections.items.map((item) => item.slug)
        : [],
    ).toEqual(['mail-read', 'issues']);
  });

  test('treats an ungoverned grant as all and none as empty', () => {
    const inputs = {
      secrets: ready([secret('MAIL_TOKEN')]),
      connectors: ready([connector('mail-read', 'workspace')]),
      connections: ready([connection('connection-mail-1', 'mail-read', 'workspace')]),
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
      ungoverned.connector_connections.status === 'ready'
        ? ungoverned.connector_connections.items
        : [],
    ).toHaveLength(1);
    expect(none.secrets).toEqual({ status: 'ready', items: [] });
    expect(none.connector_connections).toEqual({ status: 'ready', items: [] });
  });

  test('offers only workspace connections for workspace strategy connectors', () => {
    const result = buildSessionScopeSelectionCatalog({
      secrets: ready([]),
      connectors: ready([connector('mail-read', 'workspace')]),
      connections: ready([
        connection('workspace-active', 'mail-read', 'workspace', { is_default: true }),
        connection('member-active', 'mail-read', 'member'),
        connection('workspace-revoked', 'mail-read', 'workspace', { status: 'revoked' }),
        connection('other-workspace', 'issues', 'workspace'),
      ]),
      grants: { connectors: 'all' },
    });

    expect(result.connector_connections).toEqual({
      status: 'ready',
      items: [
        {
          slug: 'mail-read',
          name: 'mail-read',
          authorization_strategy: 'workspace',
          connections: [
            {
              connection_id: 'workspace-active',
              label: 'workspace-active',
              is_default: true,
            },
          ],
        },
      ],
    });
  });

  test('offers only current-user connections for user strategy connectors', () => {
    const result = buildSessionScopeSelectionCatalog({
      secrets: ready([]),
      connectors: ready([connector('issues', 'user')]),
      connections: ready([
        connection('member-active', 'issues', 'member'),
        connection('workspace-active', 'issues', 'workspace'),
        connection('member-error', 'issues', 'member', { status: 'error' }),
      ]),
      grants: { connectors: 'all' },
    });

    expect(result.connector_connections).toEqual({
      status: 'ready',
      items: [
        {
          slug: 'issues',
          name: 'issues',
          authorization_strategy: 'user',
          connections: [
            {
              connection_id: 'member-active',
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
      connections: ready([]),
      grants: {},
    });
    const connectionsUnavailable = buildSessionScopeSelectionCatalog({
      secrets: ready([]),
      connectors: ready([connector('mail-read', 'workspace')]),
      connections: unavailable(),
      grants: {},
    });

    expect(secretsUnavailable.secrets).toEqual({ status: 'unavailable' });
    expect(connectionsUnavailable.connector_connections).toEqual({ status: 'unavailable' });
  });
});
