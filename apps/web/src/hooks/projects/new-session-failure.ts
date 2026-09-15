import type { ConnectorGateConnection } from '@/stores/connector-gate-store';

/**
 * How a failed session create resolves, keyed by the server's error code.
 *
 * - `upgrade`  → open the Team-plan dialog (billing said no); stay put.
 * - `silent`   → the global 429 handler already surfaced it; stay put.
 * - `connect`  → a required connector isn't connected — open the connect-to-start
 *               gate so the user connects their own account and retries; stay put.
 * - `toast`    → terminal failure the user must see; stay put.
 *
 * Every branch stays on the current page: `useNewProjectSession` only navigates
 * AFTER a successful create, so there is no optimistic route to unwind. (The
 * old navigate-first flow bounced `router.replace` back to the index on ANY
 * rejection — including client-side timeouts where the server had actually
 * committed the row, which read as "the session appeared in the sidebar but I
 * never left the index page".)
 */
export function resolveCreateFailure(
  code: string | undefined,
): 'upgrade' | 'silent' | 'connect' | 'toast' {
  if (code === 'subscription_required' || code === 'no_account') return 'upgrade';
  if (code === 'concurrent_session_limit') return 'silent';
  if (code === 'TIMEOUT' || code === 'request_deadline') return 'silent';
  // One code, not two. `CONNECTOR_CONNECTION_REQUIRED` was also listed here and
  // the API has never emitted it — a dead branch that cost nothing only because
  // the live code sits beside it.
  //
  // `REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE` deliberately does NOT open the gate.
  // It means the project has no such connector at all, so the gate would ask
  // someone to connect an account to something that does not exist; the toast is
  // the honest outcome until a project owner adds it.
  if (code === 'CONNECTOR_CONNECTION_REQUIRED') return 'connect';
  return 'toast';
}

/**
 * Failures that say nothing about whether the server committed.
 *
 * `TIMEOUT` is the SDK's 30 s client abort and `request_deadline` is the API's
 * 25 s 503. Neither stops the handler: the create or claim transaction still
 * commits after the client gave up. A first prompt with attachments rides as
 * data: URLs, so a slow uplink reaches both limits. Measured on dev with a
 * 6 MiB PNG at 300 KiB/s up: the claim and the fallback create both aborted at
 * 30 s, both sessions were created, and the agent answered in both — while the
 * home composer unlocked with the prompt still in it.
 */
export function isAmbiguousCreateFailure(code: string | undefined): boolean {
  return code === 'TIMEOUT' || code === 'request_deadline';
}

/** The string `code` an SDK `ApiError` (or any error-like value) carries. */
export function errorCode(error: unknown): string | undefined {
  const code = isRecord(error) ? error.code : undefined;
  return typeof code === 'string' ? code : undefined;
}

export const COMMIT_CONFIRM_ATTEMPTS = 5;
export const COMMIT_CONFIRM_DELAY_MS = 2_000;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Ask the server, up to `attempts` times, whether an ambiguous write landed.
 *
 * Polls because the commit can land AFTER the client's abort. A probe that
 * throws (a 404 before the row is visible) counts as "not yet".
 */
export async function confirmCommitted(
  probe: () => Promise<boolean>,
  {
    attempts = COMMIT_CONFIRM_ATTEMPTS,
    delayMs = COMMIT_CONFIRM_DELAY_MS,
    sleep = wait,
  }: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(delayMs);
    try {
      if (await probe()) return true;
    } catch {
      // Not visible yet.
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isConnectorGateConnection(value: unknown): value is ConnectorGateConnection {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.slug === 'string' &&
    value.slug.length > 0 &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    (value.authorization_strategy === 'project' || value.authorization_strategy === 'user')
  );
}

export function getRequiredConnectorConnections(error: unknown): ConnectorGateConnection[] | null {
  if (!isRecord(error)) return null;

  const rootCode = error.code;
  const payloads = [error.data, error.details, error].filter(isRecord);
  for (const payload of payloads) {
    if (
      rootCode !== 'CONNECTOR_CONNECTION_REQUIRED' &&
      payload.code !== 'CONNECTOR_CONNECTION_REQUIRED'
    ) {
      continue;
    }

    const connections = payload.connector_connections;
    if (
      Array.isArray(connections) &&
      connections.length > 0 &&
      connections.every(isConnectorGateConnection)
    ) {
      return connections;
    }
  }

  return null;
}
