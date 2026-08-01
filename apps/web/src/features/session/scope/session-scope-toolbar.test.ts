import type { SessionScope, SessionScopeInput } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import type { SessionScopeSelectionCatalog } from './session-scope-model';
import {
  commitSessionScopeDraft,
  createNewSessionScopeInitialization,
  getSessionScopeAvailability,
} from './session-scope-toolbar';

const scope = (overrides: Partial<SessionScope> = {}): SessionScope => ({
  secrets_allowlist: ['MAIL_TOKEN'],
  required_connectors: null,
  connector_bindings: {
    mail: { authorization_id: 'authorization-mail' },
  },
  dropped_secrets: [],
  added_secrets: [],
  dropped_bindings: [],
  retroactive: true,
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
  connector_profiles: {
    status: 'ready',
    items: [
      {
        slug: 'mail',
        name: 'Mail',
        authorization_strategy: 'project',
        authorizations: [
          {
            authorization_id: 'authorization-mail',
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
  test('commits default-deny scope before the first prompt', () => {
    expect(createNewSessionScopeInitialization(catalog())).toEqual({
      draft: {
        secrets: [],
        connector_bindings: {},
        require_connectors: [],
      },
      commit: {
        draft: {
          secrets: [],
          connector_bindings: {},
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
        connector_bindings: {},
        require_connectors: [],
      },
      commit: {
        draft: {
          connector_bindings: {},
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
    let replacement: SessionScopeInput | undefined;
    const response = scope({
      secrets_allowlist: ['ISSUE_TOKEN'],
      retroactive: false,
    });

    const result = await commitSessionScopeDraft({
      sessionId: 'session-1',
      draft: { secrets: ['ISSUE_TOKEN'] },
      catalog: catalog(),
      previousScope: scope(),
      replaceScope: async (input) => {
        replacement = input;
        return response;
      },
    });

    expect(replacement).toEqual({
      secrets: ['ISSUE_TOKEN'],
      connector_bindings: {
        mail: { authorization_id: 'authorization-mail' },
      },
      require_connectors: [],
    });
    expect(result?.retroactive).toBeFalse();
  });

  test('omits an unavailable catalog axis from active-session replacement', async () => {
    let replacement: SessionScopeInput | undefined;

    await commitSessionScopeDraft({
      sessionId: 'session-1',
      draft: {
        connector_bindings: {
          mail: { authorization_id: 'authorization-mail-2' },
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
        mail: { authorization_id: 'authorization-mail-2' },
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
          mail: { authorization_id: 'authorization-mail' },
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
            mail: { authorization_id: 'authorization-mail' },
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
        connector_profiles: { status: 'unavailable' },
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
