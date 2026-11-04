import { describe, expect, test } from 'bun:test';

import { connectorStatusTone, connectorUsable } from './connector-status';

// KRTX-2185: an MCP server with no sign-in (DeepWiki) loaded its tools and
// agents used them, but its page said "needs a credential — Agents cannot use
// it until you set one". `no_auth` was not counted as usable.
describe('connectorUsable', () => {
  test('a connector with no sign-in is usable once it has an account to run as', () => {
    expect(connectorUsable('no_auth', 1)).toBe(true);
    expect(connectorUsable('no_auth', 0)).toBe(false);
  });
  test('signed in is usable', () => {
    expect(connectorUsable('connected', 1)).toBe(true);
  });
  test('setup still to do is not usable', () => {
    expect(connectorUsable('needs_setup', 1)).toBe(false);
    expect(connectorUsable('pending', 1)).toBe(false);
    expect(connectorUsable('error', 1)).toBe(false);
  });
});

// A connector with no account said "Working" while agents had nothing to run as.
describe('connectorStatusTone', () => {
  const noAuth = { authorizationStrategy: 'project', authSecret: null, secretSet: false, status: 'active', provider: 'mcp' } as const;
  test('zero accounts is Needs account, not Working', () => {
    expect(connectorStatusTone(noAuth, 0)).toBe('account');
    expect(connectorStatusTone(noAuth, 1)).toBe('connected');
    expect(connectorStatusTone(noAuth)).toBe('connected');
  });
  test('a channel has no accounts to count', () => {
    expect(connectorStatusTone({ ...noAuth, provider: 'channel' }, 0)).toBe('connected');
  });
  test('a sign-in still to finish is Needs account, never Pending', () => {
    expect(
      connectorStatusTone({ ...noAuth, status: 'error', authSecret: 'T', lastError: 'HTTP 401' }),
    ).toBe('account');
  });
  test('the server state wins when it is sent', () => {
    expect(connectorStatusTone({ ...noAuth, state: 'connected' } as never, 1)).toBe('connected');
    // Zero loaded accounts is Needs account even when the server says connected.
    expect(connectorStatusTone({ ...noAuth, state: 'connected' } as never, 0)).toBe('account');
    expect(connectorStatusTone({ ...noAuth, state: 'disabled' } as never)).toBe('error');
    expect(connectorStatusTone({ ...noAuth, state: 'needs_account' } as never, 3)).toBe('account');
    expect(connectorStatusTone({ ...noAuth, state: 'error' } as never, 3)).toBe('error');
  });
});
