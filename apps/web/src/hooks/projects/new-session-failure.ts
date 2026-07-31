import type { ConnectorGateProfile } from '@/stores/connector-gate-store';

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
  if (code === 'CONNECTOR_AUTHORIZATION_REQUIRED' || code === 'CONNECTOR_CONNECTION_REQUIRED') {
    return 'connect';
  }
  return 'toast';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isConnectorGateProfile(value: unknown): value is ConnectorGateProfile {
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

export function getConnectorAuthorizationRequiredProfiles(
  error: unknown,
): ConnectorGateProfile[] | null {
  if (!isRecord(error)) return null;

  const rootCode = error.code;
  const payloads = [error.data, error.details, error].filter(isRecord);
  for (const payload of payloads) {
    if (
      rootCode !== 'CONNECTOR_AUTHORIZATION_REQUIRED' &&
      payload.code !== 'CONNECTOR_AUTHORIZATION_REQUIRED'
    ) {
      continue;
    }

    const profiles = payload.connector_profiles;
    if (Array.isArray(profiles) && profiles.length > 0 && profiles.every(isConnectorGateProfile)) {
      return profiles;
    }
  }

  return null;
}
