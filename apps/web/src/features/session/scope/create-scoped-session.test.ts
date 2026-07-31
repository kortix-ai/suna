import type { SessionScope, SessionScopeInput } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import { createScopedSession } from './create-scoped-session';

const scope: SessionScope = {
  secrets_allowlist: null,
  connector_bindings: {
    mail: { authorization_id: 'authorization-mail-default' },
  },
  dropped_secrets: [],
  added_secrets: [],
  dropped_bindings: [],
  retroactive: true,
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
        mail: { authorization_id: 'authorization-mail-default' },
      },
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
});
