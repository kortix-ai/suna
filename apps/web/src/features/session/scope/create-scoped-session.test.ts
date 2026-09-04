import type { SessionScope, SessionScopeInput } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import { createScopedSession } from './create-scoped-session';

const scope: SessionScope = {
  secrets_allowlist: null,
  required_connectors: null,
  connector_bindings: {
    mail: { connection_id: 'connection-mail-default' },
  },
  dropped_secrets: [],
  added_secrets: [],
  dropped_bindings: [],
  retroactive: true,
  connector_bindings_configured: false,
  connector_bindings_inherit_unbound: true,
  detail: 'Current session scope.',
};

describe('createScopedSession', () => {
  test('creates, reads, replaces, then exposes the session for startup', async () => {
    const calls: string[] = [];
    let replacement: SessionScopeInput | undefined;

    const sessionId = await createScopedSession({
      create: async () => {
        calls.push('create');
        return 'session-1';
      },
      draft: { secrets: ['MAIL_TOKEN'] },
      availability: { secrets: true, connector_bindings: true },
      readScope: async (id) => {
        calls.push(`read:${id}`);
        return scope;
      },
      replaceScope: async (id, input) => {
        calls.push(`replace:${id}`);
        replacement = input;
      },
      onReady: (id) => {
        calls.push(`ready:${id}`);
      },
    });

    expect(sessionId).toBe('session-1');
    expect(calls).toEqual(['create', 'read:session-1', 'replace:session-1', 'ready:session-1']);
    expect(replacement).toEqual({
      secrets: ['MAIL_TOKEN'],
      connector_bindings: {
        mail: { connection_id: 'connection-mail-default' },
      },
      require_connectors: [],
    });
  });

  test('exposes an unmodified session without scope requests', async () => {
    const calls: string[] = [];

    await createScopedSession({
      create: async () => {
        calls.push('create');
        return 'session-2';
      },
      readScope: async () => {
        calls.push('read');
        return scope;
      },
      replaceScope: async () => {
        calls.push('replace');
      },
      onReady: (id) => {
        calls.push(`ready:${id}`);
      },
    });

    expect(calls).toEqual(['create', 'ready:session-2']);
  });

  test('does not expose a session when replacement fails', async () => {
    const calls: string[] = [];

    await expect(
      createScopedSession({
        create: async () => 'session-3',
        draft: { connector_bindings: {} },
        availability: { secrets: false, connector_bindings: true },
        readScope: async () => scope,
        replaceScope: async () => {
          calls.push('replace');
          throw new Error('scope rejected');
        },
        onReady: () => {
          calls.push('ready');
        },
      }),
    ).rejects.toThrow('scope rejected');

    expect(calls).toEqual(['replace']);
  });

  test('a new-session draft with null secrets PUTs null, not an explicit zero', async () => {
    // Regression: a browser-created session starts with no user override, which
    // is `secrets: null` — "inherit everything the agent's grant allows". The
    // scope replacement MUST carry `null`, because `[]` is the opposite ("inject
    // zero project secrets") and silently denied every browser session its grant.
    let replacement: SessionScopeInput | undefined;

    await createScopedSession({
      create: async () => 'session-4',
      draft: { secrets: null, connector_bindings: {}, require_connectors: [] },
      availability: { secrets: true, connector_bindings: true },
      readScope: async () => scope,
      replaceScope: async (_id, input) => {
        replacement = input;
      },
      onReady: () => {},
    });

    expect(replacement).toEqual({
      secrets: null,
      connector_bindings: {},
      require_connectors: [],
    });
    expect(replacement?.secrets).toBeNull();
  });

  test('does not replace untouched inherited connector defaults', async () => {
    // Since the fresh-default skip, this draft — inherit secrets, inherited
    // connector preview, nothing required — makes NO scope requests at all:
    // its replacement only restates what a just-created session already is.
    let replacement: SessionScopeInput | undefined;
    let read = false;

    await createScopedSession({
      create: async () => 'session-inherited',
      draft: {
        secrets: null,
        connector_bindings: {
          mail: { connection_id: 'stale-client-default' },
        },
        connector_bindings_inherited: true,
        require_connectors: [],
      },
      availability: { secrets: true, connector_bindings: true },
      readScope: async () => {
        read = true;
        return scope;
      },
      replaceScope: async (_id, input) => {
        replacement = input;
      },
      onReady: () => {},
    });

    expect(read).toBe(false);
    expect(replacement).toBeUndefined();
  });

  test('an explicit zero-secrets draft still PUTs [] (deliberate deselect is preserved)', async () => {
    // The flip side of the regression: a user who deliberately deselected every
    // secret MUST still get `[]` — that is a real, explicit "inject zero project
    // secrets", not a no-op. Conflating it with null would silently re-grant a
    // secret the user meant to withhold.
    let replacement: SessionScopeInput | undefined;

    await createScopedSession({
      create: async () => 'session-5',
      draft: { secrets: [], connector_bindings: {}, require_connectors: [] },
      availability: { secrets: true, connector_bindings: true },
      readScope: async () => scope,
      replaceScope: async (_id, input) => {
        replacement = input;
      },
      onReady: () => {},
    });

    expect(replacement).toEqual({
      secrets: [],
      connector_bindings: {},
      require_connectors: [],
    });
    expect(replacement?.secrets).toEqual([]);
  });
});

describe('createScopedSession — the untouched draft skips the round-trip', () => {
  test('the auto-initialized new-session draft makes no scope requests at all', async () => {
    const calls: string[] = [];
    await createScopedSession({
      create: async () => {
        calls.push('create');
        return 'session-3';
      },
      // Exactly what createNewSessionScopeDraft produces for an untouched send:
      // inherit secrets, inherited connector preview, nothing required.
      draft: {
        secrets: null,
        connector_bindings: { mail: { connection_id: 'connection-mail-default' } },
        connector_bindings_inherited: true,
        require_connectors: [],
      },
      availability: { secrets: true, connector_bindings: true },
      readScope: async (id) => {
        calls.push(`read:${id}`);
        return scope;
      },
      replaceScope: async (id) => {
        calls.push(`replace:${id}`);
      },
      onReady: (id) => {
        calls.push(`ready:${id}`);
      },
    });
    expect(calls).toEqual(['create', 'ready:session-3']);
  });

  test('a real secrets selection still reads and replaces', async () => {
    const calls: string[] = [];
    await createScopedSession({
      create: async () => {
        calls.push('create');
        return 'session-4';
      },
      draft: { secrets: ['ONLY_THIS'] },
      availability: { secrets: true, connector_bindings: true },
      readScope: async (id) => {
        calls.push(`read:${id}`);
        return scope;
      },
      replaceScope: async (id) => {
        calls.push(`replace:${id}`);
      },
      onReady: (id) => {
        calls.push(`ready:${id}`);
      },
    });
    expect(calls).toEqual(['create', 'read:session-4', 'replace:session-4', 'ready:session-4']);
  });

  test('an explicit zero-secrets selection ([]) is NOT the default and still replaces', async () => {
    const calls: string[] = [];
    await createScopedSession({
      create: async () => {
        calls.push('create');
        return 'session-5';
      },
      draft: { secrets: [] },
      availability: { secrets: true, connector_bindings: true },
      readScope: async (id) => {
        calls.push(`read:${id}`);
        return scope;
      },
      replaceScope: async (id) => {
        calls.push(`replace:${id}`);
      },
      onReady: (id) => {
        calls.push(`ready:${id}`);
      },
    });
    expect(calls).toEqual(['create', 'read:session-5', 'replace:session-5', 'ready:session-5']);
  });

  test('a required connector still replaces', async () => {
    const calls: string[] = [];
    await createScopedSession({
      create: async () => {
        calls.push('create');
        return 'session-6';
      },
      draft: {
        secrets: null,
        connector_bindings: {},
        connector_bindings_inherited: true,
        require_connectors: ['mail'],
      },
      availability: { secrets: true, connector_bindings: true },
      readScope: async (id) => {
        calls.push(`read:${id}`);
        return scope;
      },
      replaceScope: async (id) => {
        calls.push(`replace:${id}`);
      },
      onReady: (id) => {
        calls.push(`ready:${id}`);
      },
    });
    expect(calls).toEqual(['create', 'read:session-6', 'replace:session-6', 'ready:session-6']);
  });

  test('a user-chosen connector binding (not inherited) still replaces', async () => {
    const calls: string[] = [];
    await createScopedSession({
      create: async () => {
        calls.push('create');
        return 'session-7';
      },
      draft: {
        secrets: null,
        connector_bindings: { mail: { connection_id: 'connection-mail-two' } },
        connector_bindings_inherited: false,
        require_connectors: [],
      },
      availability: { secrets: true, connector_bindings: true },
      readScope: async (id) => {
        calls.push(`read:${id}`);
        return scope;
      },
      replaceScope: async (id) => {
        calls.push(`replace:${id}`);
      },
      onReady: (id) => {
        calls.push(`ready:${id}`);
      },
    });
    expect(calls).toEqual(['create', 'read:session-7', 'replace:session-7', 'ready:session-7']);
  });
});
