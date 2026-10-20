import { describe, expect, test } from 'bun:test';
import { sessionCreateFailure } from '../../src/lib/session-create-failure';

/**
 * The connector create-time pre-flight is gone. `connector-required.ts` and
 * `ConnectRequiredCard` were deleted with it: `CONNECTOR_CONNECTION_REQUIRED`
 * and `REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE` can no longer be returned by
 * session create or scope — `require_connectors` is accepted and ignored on
 * the wire (`SessionCreateInputSchema` / `SessionScopeInputSchema` in
 * `packages/api-contract`). The gate moved to the connector CALL, which denies
 * `connector_not_connected` with a `connect_url` the agent's own turn
 * surfaces — this app renders that inside the transcript (`SetupLinkButton`),
 * not as a session-create refusal.
 *
 * This file used to pin the deleted classifier's behavior for both codes. It
 * now pins the opposite: neither code is special-cased any more, so a server
 * that somehow still sent one would fall through to the generic, retryable
 * "Could not start a session" arm rather than resurrect dead remedy UI for it.
 */

const apiError = (body: Record<string, unknown>) =>
  Object.assign(
    new Error(
      typeof body.message === 'string'
        ? body.message
        : typeof body.error === 'string'
          ? body.error
          : 'HTTP 409',
    ),
    { status: 409, code: body.code, data: body },
  );

describe('sessionCreateFailure — the connector pre-flight codes are unreachable', () => {
  test('CONNECTOR_CONNECTION_REQUIRED is no longer classified', () => {
    const failure = sessionCreateFailure(
      apiError({
        code: 'CONNECTOR_CONNECTION_REQUIRED',
        message: 'Connect the required connectors before starting this session.',
        connector_connections: [
          { id: '0f2f2c2e-0000-4000-8000-000000000001', slug: 'gmail', name: 'Gmail' },
        ],
      }),
    );
    expect(failure.title).toBe('Could not start a session');
    // Unclassified failures are assumed transient — this one is not the
    // permanent, do-nothing-until-someone-connects-an-account refusal it used
    // to be, because it can no longer occur.
    expect(failure.retryable).toBe(true);
  });

  test('REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE is no longer classified', () => {
    const failure = sessionCreateFailure(
      apiError({
        code: 'REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE',
        error: 'Required connector "gmail" is unavailable',
      }),
    );
    expect(failure.title).toBe('Could not start a session');
    expect(failure.retryable).toBe(true);
  });
});
