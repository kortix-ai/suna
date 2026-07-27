'use client';

import Nango, { type ConnectUIEvent } from '@nangohq/frontend';
import {
  createGitHubConnectSession,
  createGitHubReconnectSession,
  listGitHubInstallations,
  refreshGitHubConnection,
  type GitHubConnectSessionResponse,
  type GitHubInstallationStatus,
  type GitHubInstallationsResponse,
} from '@kortix/sdk';

export type GitHubNangoConnectEvent = ConnectUIEvent;
export type GitHubNangoConnectPhase = 'requesting' | 'authorizing' | 'reconciling';

export type GitHubNangoConnectOutcome =
  | { status: 'connected'; installation: GitHubInstallationStatus }
  | { status: 'cancelled' }
  | {
      status: 'error';
      code:
        | 'popup_blocked'
        | 'authorization_failed'
        | 'session_failed'
        | 'reconciliation_timeout';
      message: string;
    };

export interface GitHubNangoConnectInput {
  accountId: string;
  installationId?: string;
  signal?: AbortSignal;
  onPhaseChange?: (phase: GitHubNangoConnectPhase) => void;
  reconcileAttempts?: number;
  reconcileDelayMs?: number;
}

export interface GitHubNangoConnectDependencies {
  createConnectSession(input: { accountId: string }): Promise<GitHubConnectSessionResponse>;
  createReconnectSession(input: {
    accountId: string;
    installationId: string;
  }): Promise<GitHubConnectSessionResponse>;
  openConnectUi(
    token: string,
    onEvent: (event: GitHubNangoConnectEvent) => void | Promise<void>,
  ): { close(): void };
  listInstallations(accountId: string): Promise<GitHubInstallationsResponse>;
  refreshConnection(input: {
    accountId: string;
    installationId: string;
  }): Promise<GitHubInstallationStatus>;
  sleep(ms: number): Promise<void>;
}

const productionDependencies: GitHubNangoConnectDependencies = {
  createConnectSession: createGitHubConnectSession,
  createReconnectSession: createGitHubReconnectSession,
  openConnectUi: (token, onEvent) => {
    const nango = new Nango({ connectSessionToken: token });
    return nango.openConnectUI({
      detectClosedAuthWindow: true,
      onEvent,
    });
  },
  listInstallations: listGitHubInstallations,
  refreshConnection: refreshGitHubConnection,
  sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isPendingReconciliation(error: unknown): boolean {
  const candidate = error as { status?: number; code?: string };
  return (
    candidate?.status === 404 ||
    candidate?.status === 409 ||
    (typeof candidate?.status === 'number' && candidate.status >= 500) ||
    candidate?.code === 'github_connection_required' ||
    candidate?.code === 'github_reconnect_required'
  );
}

async function reconcileConnection(
  input: GitHubNangoConnectInput,
  connectionId: string,
  dependencies: GitHubNangoConnectDependencies,
): Promise<GitHubInstallationStatus> {
  const attempts = input.reconcileAttempts ?? 20;
  const delayMs = input.reconcileDelayMs ?? 500;
  let installationId = input.installationId;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (input.signal?.aborted) {
      throw new DOMException('GitHub connection was cancelled.', 'AbortError');
    }

    if (!installationId) {
      try {
        const status = await dependencies.listInstallations(input.accountId);
        installationId =
          status.installations.find(
            (installation) => installation.connection_id === connectionId,
          )?.installation_id ?? undefined;
      } catch (error) {
        if (!isPendingReconciliation(error)) throw error;
      }
    }

    if (installationId) {
      try {
        const installation = await dependencies.refreshConnection({
          accountId: input.accountId,
          installationId,
        });
        if (
          installation.connection_status === 'connected' ||
          (installation.installed && installation.reconnect_required !== true)
        ) {
          return installation;
        }
      } catch (error) {
        if (!isPendingReconciliation(error)) throw error;
      }
    }

    if (attempt < attempts - 1) await dependencies.sleep(delayMs);
  }

  throw new Error(
    'GitHub authorized the connection, but Kortix has not finished syncing it. Try again in a few seconds.',
  );
}

function authorizationError(event: Extract<GitHubNangoConnectEvent, { type: 'error' }>) {
  if (event.payload.errorType === 'blocked_by_browser') {
    return {
      status: 'error' as const,
      code: 'popup_blocked' as const,
      message:
        'Your browser blocked the GitHub authorization window. Allow pop-ups and try again.',
    };
  }

  return {
    status: 'error' as const,
    code: 'authorization_failed' as const,
    message:
      event.payload.errorMessage ||
      'GitHub authorization failed. Organization access may require approval from a GitHub owner.',
  };
}

export async function runGitHubNangoConnect(
  input: GitHubNangoConnectInput,
  dependencies: GitHubNangoConnectDependencies = productionDependencies,
): Promise<GitHubNangoConnectOutcome> {
  if (input.signal?.aborted) return { status: 'cancelled' };
  input.onPhaseChange?.('requesting');

  let session: GitHubConnectSessionResponse;
  try {
    session = input.installationId
      ? await dependencies.createReconnectSession({
          accountId: input.accountId,
          installationId: input.installationId,
        })
      : await dependencies.createConnectSession({ accountId: input.accountId });
  } catch (error) {
    return {
      status: 'error',
      code: 'session_failed',
      message: errorMessage(error, 'Kortix could not start GitHub authorization. Try again.'),
    };
  }

  if (input.signal?.aborted) return { status: 'cancelled' };
  input.onPhaseChange?.('authorizing');

  return new Promise<GitHubNangoConnectOutcome>((resolve) => {
    let terminal = false;
    let connectUi: { close(): void } | null = null;

    const finish = (outcome: GitHubNangoConnectOutcome) => {
      if (terminal) return;
      terminal = true;
      input.signal?.removeEventListener('abort', handleAbort);
      resolve(outcome);
    };

    const handleAbort = () => {
      connectUi?.close();
      finish({ status: 'cancelled' });
    };

    const handleEvent = async (event: GitHubNangoConnectEvent) => {
      if (terminal) return;

      if (event.type === 'close') {
        try {
          await dependencies.listInstallations(input.accountId);
        } catch {
          // Closing without authorization must not turn into a connection error.
        }
        finish({ status: 'cancelled' });
        return;
      }

      if (event.type === 'error') {
        connectUi?.close();
        finish(authorizationError(event));
        return;
      }

      if (event.type !== 'connect') return;

      terminal = true;
      input.signal?.removeEventListener('abort', handleAbort);
      connectUi?.close();
      input.onPhaseChange?.('reconciling');
      try {
        const installation = await reconcileConnection(
          input,
          event.payload.connectionId,
          dependencies,
        );
        resolve({ status: 'connected', installation });
      } catch (error) {
        if (input.signal?.aborted) {
          resolve({ status: 'cancelled' });
          return;
        }
        resolve({
          status: 'error',
          code: 'reconciliation_timeout',
          message: errorMessage(
            error,
            'GitHub authorized the connection, but Kortix has not finished syncing it.',
          ),
        });
      }
    };

    input.signal?.addEventListener('abort', handleAbort, { once: true });
    try {
      connectUi = dependencies.openConnectUi(session.token, handleEvent);
    } catch (error) {
      finish({
        status: 'error',
        code: 'authorization_failed',
        message: errorMessage(error, 'Kortix could not open GitHub authorization. Try again.'),
      });
    }
  });
}
