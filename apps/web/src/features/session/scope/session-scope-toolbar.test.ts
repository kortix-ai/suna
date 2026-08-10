import type { SessionScope, SessionScopeInput } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import {
  createSessionScopeDraft,
  resetSessionConnectorBindings,
  type SessionScopeSelectionCatalog,
} from './session-scope-model';
import {
  commitSessionScopeDraft,
  createNewSessionScopeInitialization,
  getSessionScopeAvailability,
} from './session-scope-toolbar';

const scope = (overrides: Partial<SessionScope> = {}): SessionScope => ({
  secrets_allowlist: ['MAIL_TOKEN'],
  required_connectors: null,
  connector_bindings: {
    mail: { connection_id: 'connection-mail' },
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

const catalog = (
  overrides: Partial<SessionScopeSelectionCatalog> = {},
): SessionScopeSelectionCatalog => ({
  secrets: {
    status: 'ready',
    items: [{ identifier: 'MAIL_TOKEN', name: 'Mail token' }],
  },
  connector_connections: {
    status: 'ready',
    items: [
      {
        slug: 'mail',
        name: 'Mail',
        authorization_strategy: 'workspace',
        connections: [
          {
            connection_id: 'connection-mail',
            label: 'Project mail',
            is_default: true,
          },
        ],
      },
    ],
  },
  ...overrides,
});

describe('getSessionScopeAvailability', () => {
  test('keeps failed catalog axes unavailable', () => {
    expect(
      getSessionScopeAvailability(
        catalog({
          secrets: { status: 'unavailable' },
        }),
      ),
    ).toEqual({
      secrets: false,
      connector_bindings: true,
    });
  });
});

describe('createNewSessionScopeInitialization', () => {
  test('commits an unrestricted (null) secrets scope before the first prompt', () => {
    // `null` is the no-override state — the session inherits the agent's grant,
    // exactly like a server-created session. `[]` would be an explicit "inject
    // zero workspace secrets", which silently denied every browser-created session
    // its grant. Connector access previews every visible default connection.
    // Untouched defaults remain server-resolved until the user changes them.
    expect(createNewSessionScopeInitialization(catalog())).toEqual({
      draft: {
        secrets: null,
        connector_bindings: {
          mail: { connection_id: 'connection-mail' },
        },
        connector_bindings_inherited: true,
        require_connectors: [],
      },
      commit: {
        draft: {
          secrets: null,
          connector_bindings: {
            mail: { connection_id: 'connection-mail' },
          },
          connector_bindings_inherited: true,
          require_connectors: [],
        },
        availability: {
          secrets: true,
          connector_bindings: true,
        },
      },
    });
  });

  test('commits only catalog axes that are available', () => {
    expect(
      createNewSessionScopeInitialization(
        catalog({
          secrets: { status: 'unavailable' },
        }),
      ),
    ).toEqual({
      draft: {
        connector_bindings: {
          mail: { connection_id: 'connection-mail' },
        },
        connector_bindings_inherited: true,
        require_connectors: [],
      },
      commit: {
        draft: {
          connector_bindings: {
            mail: { connection_id: 'connection-mail' },
          },
          connector_bindings_inherited: true,
          require_connectors: [],
        },
        availability: {
          secrets: false,
          connector_bindings: true,
        },
      },
    });
  });
});

describe('commitSessionScopeDraft', () => {
  test('saves a complete active-session replacement from authoritative read-back', async () => {
    // The session already HOLDS a connector override, so its bindings are a
    // user selection and the save must resend them in full — a partial map
    // would silently drop whatever it left out.
    let replacement: SessionScopeInput | undefined;
    const previous = scope({ connector_bindings_configured: true });
    const response = scope({
      secrets_allowlist: ['ISSUE_TOKEN'],
      connector_bindings_configured: true,
      retroactive: false,
    });

    const result = await commitSessionScopeDraft({
      sessionId: 'session-1',
      draft: { secrets: ['ISSUE_TOKEN'] },
      catalog: catalog(),
      previousScope: previous,
      replaceScope: async (input) => {
        replacement = input;
        return response;
      },
    });

    expect(replacement).toEqual({
      secrets: ['ISSUE_TOKEN'],
      connector_bindings: {
        mail: { connection_id: 'connection-mail' },
      },
      require_connectors: [],
    });
    expect(result?.retroactive).toBeFalse();
  });

  test('an untouched save on an inheriting session writes no connector override', async () => {
    // The bug this replaced: opening the panel on an existing session and
    // pressing Save posted the server-resolved bindings back as an explicit
    // override, so `connector_bindings_configured` flipped to true and every
    // unbound alias started failing closed — with nothing in the UI asking for
    // it.
    let replacement: SessionScopeInput | undefined;
    const previous = scope({ connector_bindings_configured: false });

    await commitSessionScopeDraft({
      sessionId: 'session-1',
      draft: createSessionScopeDraft(previous, catalog()),
      catalog: catalog(),
      previousScope: previous,
      replaceScope: async (input) => {
        replacement = input;
        return previous;
      },
    });

    expect(replacement).toBeDefined();
    expect(Object.hasOwn(replacement as SessionScopeInput, 'connector_bindings')).toBe(false);
  });

  test('a reset on an overridden session sends the null clear verb', async () => {
    let replacement: SessionScopeInput | undefined;
    const previous = scope({ connector_bindings_configured: true });

    await commitSessionScopeDraft({
      sessionId: 'session-1',
      draft: resetSessionConnectorBindings(
        createSessionScopeDraft(previous, catalog()),
        catalog(),
      ),
      catalog: catalog(),
      previousScope: previous,
      replaceScope: async (input) => {
        replacement = input;
        return scope({ connector_bindings_configured: false });
      },
    });

    expect(replacement?.connector_bindings).toBeNull();
  });

  test('omits an unavailable catalog axis from active-session replacement', async () => {
    let replacement: SessionScopeInput | undefined;

    await commitSessionScopeDraft({
      sessionId: 'session-1',
      draft: {
        connector_bindings: {
          mail: { connection_id: 'connection-mail-2' },
        },
        require_connectors: [],
      },
      catalog: catalog({
        secrets: { status: 'unavailable' },
      }),
      previousScope: scope(),
      replaceScope: async (input) => {
        replacement = input;
        return scope();
      },
    });

    expect(replacement).toEqual({
      connector_bindings: {
        mail: { connection_id: 'connection-mail-2' },
      },
      require_connectors: [],
    });
  });

  test('commits a new-session draft without calling session replacement', async () => {
    const committed: unknown[] = [];
    let replacements = 0;

    await commitSessionScopeDraft({
      draft: {
        secrets: null,
        connector_bindings: {
          mail: { connection_id: 'connection-mail' },
        },
        require_connectors: [],
      },
      catalog: catalog(),
      replaceScope: async () => {
        replacements += 1;
        return scope();
      },
      onCommittedDraft: (commit) => committed.push(commit),
    });

    expect(replacements).toBe(0);
    expect(committed).toEqual([
      {
        draft: {
          secrets: null,
          connector_bindings: {
            mail: { connection_id: 'connection-mail' },
          },
          require_connectors: [],
        },
        availability: {
          secrets: true,
          connector_bindings: true,
        },
      },
    ]);
  });

  test('does not commit when every catalog axis is unavailable', async () => {
    const committed: unknown[] = [];

    const result = await commitSessionScopeDraft({
      draft: {},
      catalog: {
        secrets: { status: 'unavailable' },
        connector_connections: { status: 'unavailable' },
      },
      replaceScope: async () => scope(),
      onCommittedDraft: (commit) => committed.push(commit),
    });

    expect(result).toBeUndefined();
    expect(committed).toEqual([]);
  });

  test('rejects an active replacement without authoritative scope', async () => {
    await expect(
      commitSessionScopeDraft({
        sessionId: 'session-1',
        draft: { secrets: [] },
        catalog: catalog(),
        replaceScope: async () => scope(),
      }),
    ).rejects.toThrow('The current session scope is required before replacement.');
  });
});
