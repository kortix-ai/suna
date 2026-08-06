import { describe, expect, test } from 'bun:test';

import {
  getRequiredConnectorConnections,
  resolveCreateFailure,
} from './new-session-failure';

const connectorConnections = [
  {
    id: '653ca2f1-fe4c-4df4-932a-dc3045885ddb',
    slug: 'gmail-read',
    name: 'Gmail read only',
    authorization_strategy: 'user' as const,
  },
  {
    id: '79d15f28-e955-4f09-a08b-52e96fe97e3b',
    slug: 'slack-project',
    name: 'Slack project',
    authorization_strategy: 'project' as const,
  },
];

describe('resolveCreateFailure', () => {
  test('billing rejections open the upgrade dialog and stay on the page', () => {
    expect(resolveCreateFailure('subscription_required')).toBe('upgrade');
    expect(resolveCreateFailure('no_account')).toBe('upgrade');
  });

  test('the concurrent-session cap stays silent (global 429 handler owns it)', () => {
    expect(resolveCreateFailure('concurrent_session_limit')).toBe('silent');
  });

  test('a missing connection opens the connect-to-start gate', () => {
    expect(resolveCreateFailure('CONNECTOR_CONNECTION_REQUIRED')).toBe('connect');
  });

  test('an unconfigured connector does NOT open the gate — nothing to connect to', () => {
    // REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE means the project has no such
    // connector. Opening the gate would ask the user to connect an account to
    // a connector that does not exist, and no amount of connecting clears it.
    expect(resolveCreateFailure('REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE')).toBe('toast');
  });

  test('everything else — including codeless network failures — surfaces a toast, never a redirect', () => {
    expect(resolveCreateFailure(undefined)).toBe('toast');
    expect(resolveCreateFailure('TIMEOUT')).toBe('toast');
    expect(resolveCreateFailure('internal_error')).toBe('toast');
  });
});

describe('getRequiredConnectorConnections', () => {
  test('preserves every structured connection in response order', () => {
    expect(
      getRequiredConnectorConnections({
        code: 'CONNECTOR_CONNECTION_REQUIRED',
        data: {
          code: 'CONNECTOR_CONNECTION_REQUIRED',
          message: 'Create the required connections before starting this session.',
          connector_connections: connectorConnections,
        },
      }),
    ).toEqual(connectorConnections);
  });

  test('accepts the structured body from the SDK details alias', () => {
    expect(
      getRequiredConnectorConnections({
        code: 'CONNECTOR_CONNECTION_REQUIRED',
        details: {
          code: 'CONNECTOR_CONNECTION_REQUIRED',
          message: 'Create the required connections before starting this session.',
          connector_connections: connectorConnections,
        },
      }),
    ).toEqual(connectorConnections);
  });

  test('rejects empty or malformed connection payloads', () => {
    expect(
      getRequiredConnectorConnections({
        code: 'CONNECTOR_CONNECTION_REQUIRED',
        data: { connector_connections: [] },
      }),
    ).toBeNull();
    expect(
      getRequiredConnectorConnections({
        code: 'CONNECTOR_CONNECTION_REQUIRED',
        data: {
          connector_connections: [{ ...connectorConnections[0], authorization_strategy: 'workspace' }],
        },
      }),
    ).toBeNull();
    // A real adjacent refusal that carries `connectors`, never
    // `connector_connections` — reading a gate roster out of it would be inventing
    // one. (This case used to be written with the phantom
    // CONNECTOR_CONNECTION_REQUIRED, which proved nothing: an unreachable code
    // is rejected whatever the reader does.)
    expect(
      getRequiredConnectorConnections({
        code: 'REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE',
        data: { connectors: ['gmail-read'] },
      }),
    ).toBeNull();
  });
});
