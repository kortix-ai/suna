import { describe, expect, test } from 'bun:test';

import {
  connectorProviderLabel,
  connectorSetupStatus,
  connectorStatusTone,
  connectorUsable,
  isManagedConnectorProvider,
} from './connector-status';

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

describe('connectorProviderLabel', () => {
  test('names the computer provider plainly', () => {
    expect(connectorProviderLabel('computer')).toBe('Computer');
  });

  test('names a direct API the way the catalogue does', () => {
    expect(connectorProviderLabel('openapi')).toBe('REST API');
    expect(connectorProviderLabel('graphql')).toBe('GraphQL');
    expect(connectorProviderLabel('http')).toBe('HTTP API');
    expect(connectorProviderLabel('mcp')).toBe('MCP');
  });

  test('normalizes managed connector providers behind one product label', () => {
    expect(connectorProviderLabel('composio')).toBe('Composio');
    expect(connectorProviderLabel('pipedream')).toBe('Pipedream');
    expect(isManagedConnectorProvider('composio')).toBe(true);
    expect(isManagedConnectorProvider('pipedream')).toBe(true);
    expect(isManagedConnectorProvider('openapi')).toBe(false);
  });
});

describe('connector setup status', () => {
  const connector = {
    status: 'active' as const,
    authSecret: 'TOKEN',
    secretSet: false,
    authorizationStrategy: 'project' as const,
  };

  test('uses the shared secret state only for project authorization', () => {
    expect(connectorSetupStatus(connector)).toBe('needs_setup');
    expect(connectorSetupStatus({ ...connector, secretSet: true })).toBe('connected');
  });

  // The list's `status` is computed for the caller: a per-person connector
  // reads `active` only when the caller's own account holds a credential, and
  // `needs_auth` when it does not. It used to show "User-managed" either way.
  test('a per-person connector is connected when the caller is, never "user managed"', () => {
    expect(connectorSetupStatus({ ...connector, authorizationStrategy: 'user' })).toBe(
      'connected',
    );
    expect(
      connectorSetupStatus({ ...connector, authorizationStrategy: 'user', status: 'needs_auth' }),
    ).toBe('needs_setup');
  });

  // Prod 2026-08-28: 6 of 6 GitHub connections had a null `connected_account_id`
  // — authorization was never completed — and no GitHub tool call had ever run,
  // yet the connector grid showed a checkmark. `needs_auth` used to fall
  // through to the secretSet branch and read as `connected`.
  test('an authorization that never completed is setup that never finished', () => {
    expect(connectorSetupStatus({ ...connector, status: 'needs_auth' })).toBe('needs_setup');
    // Even with a credential present it is NOT connected — the credential is
    // not the thing that is missing.
    expect(connectorSetupStatus({ ...connector, status: 'needs_auth', secretSet: true })).toBe(
      'needs_setup',
    );
  });

  test('error still outranks needs_auth', () => {
    expect(connectorSetupStatus({ ...connector, status: 'error' })).toBe('error');
  });

  test('keeps error and no-auth states independent of credential ownership', () => {
    expect(connectorSetupStatus({ ...connector, status: 'error' })).toBe('error');
    expect(connectorSetupStatus({ ...connector, authSecret: null })).toBe('no_auth');
  });
});


describe('connectorSetupStatus: MCP sign-in still to do', () => {
  const failing = {
    authorizationStrategy: 'project' as const,
    authSecret: null,
    secretSet: false,
    status: 'error' as const,
    provider: 'mcp' as const,
  };

  test('an MCP server asking for sign-in is pending, not an error', () => {
    expect(
      connectorSetupStatus({ ...failing, lastError: 'MCP tools/list failed: HTTP 401' }),
    ).toBe('pending');
  });

  test('any other MCP failure stays an error', () => {
    expect(connectorSetupStatus({ ...failing, lastError: 'MCP tools/list failed: HTTP 500' })).toBe(
      'error',
    );
  });
});
