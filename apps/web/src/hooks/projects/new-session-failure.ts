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
