/**
 * Why a session refused to start, in terms a wrapper's user can act on.
 *
 * Two Kortix-as-a-Backend outcomes matter and look nothing alike:
 *
 * - `409 CONNECTOR_CONNECTION_REQUIRED` — this end-user has not connected their
 *   own account for a connector the session needs. Actionable BY THEM: connect
 *   it and retry. This is the flow that makes per-end-user connectors work.
 *
 * - `403 REQUIRE_CONNECTORS_INTERACTIVE_ONLY` — the caller asked for
 *   `require_connectors` from a BACKEND origin. A wrapper key acts for no single
 *   person, so "the current user's own connection" has no meaning. Not
 *   actionable by the end-user at all; the wrapper must bind an explicit
 *   `authorization_id` via `connector_bindings` instead.
 *
 * Collapsing these into one "couldn't start a session" toast — which is what the
 * demo did — tells the user to fix something they cannot fix, and hides an
 * integration mistake from the developer.
 */

export type SessionStartFailure =
  | {
      kind: 'connector_connection_required';
      connector: string;
      message: string;
    }
  | { kind: 'require_connectors_backend_origin'; message: string }
  | { kind: 'unknown'; message: string };

interface UpstreamError {
  status?: number;
  code?: unknown;
  error?: unknown;
  connector?: unknown;
}

const asText = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim().length > 0 ? value : fallback;

export function classifySessionStartFailure(
  body: UpstreamError | null,
): SessionStartFailure {
  const code = typeof body?.code === 'string' ? body.code : '';

  if (code === 'CONNECTOR_CONNECTION_REQUIRED') {
    return {
      kind: 'connector_connection_required',
      // The server names the connector so the UI can say WHICH one; without it
      // the prompt is "connect something", which is not a call to action.
      connector: asText(body?.connector, 'a connector'),
      message: asText(
        body?.error,
        'Connect your account to start this session.',
      ),
    };
  }

  if (code === 'REQUIRE_CONNECTORS_INTERACTIVE_ONLY') {
    return {
      kind: 'require_connectors_backend_origin',
      message: asText(
        body?.error,
        'require_connectors is interactive-only — bind an explicit connection with connector_bindings instead.',
      ),
    };
  }

  return {
    kind: 'unknown',
    message: asText(body?.error, 'Could not start a session'),
  };
}
