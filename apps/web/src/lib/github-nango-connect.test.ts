import { describe, expect, test } from 'bun:test';

import type { GitHubInstallationStatus } from '@kortix/sdk';

import {
  runGitHubNangoConnect,
  type GitHubNangoConnectDependencies,
  type GitHubNangoConnectEvent,
} from './github-nango-connect';

function installation(
  overrides: Partial<GitHubInstallationStatus> = {},
): GitHubInstallationStatus {
  return {
    account_id: 'account-1',
    installation_row_id: 'row-1',
    installed: true,
    configured: true,
    requires_installation: false,
    install_url: null,
    installation_id: '123',
    owner_login: 'octocat',
    owner_type: 'User',
    repository_selection: 'all',
    permissions: { contents: 'write' },
    installation_url: 'https://github.com/settings/installations/123',
    updated_at: '2026-07-27T12:00:00.000Z',
    connection_id: 'connection-1',
    connection_provider: 'nango',
    connection_status: 'connected',
    reconnect_required: false,
    ...overrides,
  };
}

function dependencies(
  event: GitHubNangoConnectEvent,
  overrides: Partial<GitHubNangoConnectDependencies> = {},
) {
  const calls = {
    connectAccounts: [] as string[],
    reconnect: [] as Array<{ accountId: string; installationId: string }>,
    openedTokens: [] as string[],
    closes: 0,
    lists: 0,
    refreshes: [] as Array<{ accountId: string; installationId: string }>,
  };
  const deps: GitHubNangoConnectDependencies = {
    createConnectSession: async ({ accountId }) => {
      calls.connectAccounts.push(accountId);
      return {
        token: 'connect-session-token',
        expires_at: '2026-07-27T12:05:00.000Z',
        connect_link: 'https://connect.nango.dev/session',
      };
    },
    createReconnectSession: async (input) => {
      calls.reconnect.push(input);
      return {
        token: 'reconnect-session-token',
        expires_at: '2026-07-27T12:05:00.000Z',
        connect_link: 'https://connect.nango.dev/session',
      };
    },
    openConnectUi: (token, onEvent) => {
      calls.openedTokens.push(token);
      queueMicrotask(() => void onEvent(event));
      return {
        close: () => {
          calls.closes += 1;
        },
      };
    },
    listInstallations: async () => {
      calls.lists += 1;
      const current = installation();
      return { ...current, installations: [current] };
    },
    refreshConnection: async (input) => {
      calls.refreshes.push(input);
      return installation({ installation_id: input.installationId });
    },
    sleep: async () => {},
    ...overrides,
  };
  return { calls, deps };
}

describe('runGitHubNangoConnect', () => {
  test('creates an account-scoped session and reconciles the connected installation', async () => {
    const { calls, deps } = dependencies({
      type: 'connect',
      payload: {
        connectionId: 'connection-1',
        providerConfigKey: 'github-app-oauth',
      },
    });

    const result = await runGitHubNangoConnect(
      { accountId: 'account-1', reconcileDelayMs: 0 },
      deps,
    );

    expect(result).toEqual({
      status: 'connected',
      installation: installation(),
    });
    expect(calls.connectAccounts).toEqual(['account-1']);
    expect(calls.openedTokens).toEqual(['connect-session-token']);
    expect(calls.refreshes).toEqual([{ accountId: 'account-1', installationId: '123' }]);
    expect(calls.closes).toBe(1);
  });

  test('uses the reconnect session and preserves the GitHub installation ID', async () => {
    const { calls, deps } = dependencies({
      type: 'connect',
      payload: {
        connectionId: 'connection-1',
        providerConfigKey: 'github-app-oauth',
      },
    });

    const result = await runGitHubNangoConnect(
      {
        accountId: 'account-1',
        installationId: '123',
        reconcileDelayMs: 0,
      },
      deps,
    );

    expect(result.status).toBe('connected');
    expect(calls.connectAccounts).toEqual([]);
    expect(calls.reconnect).toEqual([{ accountId: 'account-1', installationId: '123' }]);
    expect(calls.openedTokens).toEqual(['reconnect-session-token']);
    expect(calls.refreshes).toEqual([{ accountId: 'account-1', installationId: '123' }]);
  });

  test('refreshes visible state after close without authorizing a connection', async () => {
    const { calls, deps } = dependencies({ type: 'close' });

    const result = await runGitHubNangoConnect({ accountId: 'account-1' }, deps);

    expect(result).toEqual({ status: 'cancelled' });
    expect(calls.lists).toBe(1);
    expect(calls.refreshes).toEqual([]);
  });

  test('maps a blocked GitHub authorization window to a visible retry error', async () => {
    const { calls, deps } = dependencies({
      type: 'error',
      payload: {
        errorType: 'blocked_by_browser',
        errorMessage: 'Popup blocked',
      },
    });

    const result = await runGitHubNangoConnect({ accountId: 'account-1' }, deps);

    expect(result).toEqual({
      status: 'error',
      code: 'popup_blocked',
      message: 'Your browser blocked the GitHub authorization window. Allow pop-ups and try again.',
    });
    expect(calls.closes).toBe(1);
  });

  test('reports a reconciliation timeout without exposing session credentials', async () => {
    const { deps } = dependencies(
      {
        type: 'connect',
        payload: {
          connectionId: 'connection-missing',
          providerConfigKey: 'github-app-oauth',
        },
      },
      {
        listInstallations: async () => {
          const current = installation({ connection_id: 'another-connection' });
          return { ...current, installations: [current] };
        },
      },
    );

    const result = await runGitHubNangoConnect(
      {
        accountId: 'account-1',
        reconcileAttempts: 2,
        reconcileDelayMs: 0,
      },
      deps,
    );

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('Expected an error outcome');
    expect(result.code).toBe('reconciliation_timeout');
    expect(result.message).not.toContain('connect-session-token');
  });
});
