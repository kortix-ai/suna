import { describe, expect, test } from 'bun:test';

import {
  confirmCommitted,
  errorCode,
  getRequiredConnectorConnections,
  isAmbiguousCreateFailure,
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

  test('request deadlines stay silent because the server can complete after the client stops waiting', () => {
    expect(resolveCreateFailure('TIMEOUT')).toBe('silent');
    expect(resolveCreateFailure('request_deadline')).toBe('silent');
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

  test('other failures surface a toast, never a redirect', () => {
    expect(resolveCreateFailure(undefined)).toBe('toast');
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
          connector_connections: [
            { ...connectorConnections[0], authorization_strategy: 'workspace' },
          ],
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

describe('isAmbiguousCreateFailure', () => {
  test('a client timeout and a server deadline leave the outcome unknown', () => {
    expect(isAmbiguousCreateFailure('TIMEOUT')).toBe(true);
    expect(isAmbiguousCreateFailure('request_deadline')).toBe(true);
  });

  test('a definite refusal is not ambiguous', () => {
    expect(isAmbiguousCreateFailure('subscription_required')).toBe(false);
    expect(isAmbiguousCreateFailure('WARM_SESSION_ALREADY_CLAIMED')).toBe(false);
    expect(isAmbiguousCreateFailure('CONNECTOR_CONNECTION_REQUIRED')).toBe(false);
    expect(isAmbiguousCreateFailure(undefined)).toBe(false);
  });
});

describe('errorCode', () => {
  test('reads a string code off an error-like value', () => {
    expect(errorCode({ code: 'TIMEOUT' })).toBe('TIMEOUT');
    expect(errorCode(Object.assign(new Error('x'), { code: 'request_deadline' }))).toBe(
      'request_deadline',
    );
  });

  test('anything else has no code', () => {
    expect(errorCode(new Error('x'))).toBeUndefined();
    expect(errorCode({ code: 503 })).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
    expect(errorCode('TIMEOUT')).toBeUndefined();
  });
});

describe('confirmCommitted — ask the server before calling an ambiguous create a failure', () => {
  const noSleep = async () => {};

  test('true on the first probe that sees the commit, without probing again', async () => {
    let probes = 0;
    const committed = await confirmCommitted(
      async () => {
        probes += 1;
        return probes === 2;
      },
      { attempts: 5, delayMs: 1, sleep: noSleep },
    );
    expect(committed).toBe(true);
    expect(probes).toBe(2);
  });

  test('a probe that throws (404 while the commit lands) counts as not yet', async () => {
    let probes = 0;
    const committed = await confirmCommitted(
      async () => {
        probes += 1;
        if (probes < 3) throw new Error('Not found');
        return true;
      },
      { attempts: 5, delayMs: 1, sleep: noSleep },
    );
    expect(committed).toBe(true);
    expect(probes).toBe(3);
  });

  test('false after the last attempt, with a sleep between attempts only', async () => {
    let probes = 0;
    const sleeps: number[] = [];
    const committed = await confirmCommitted(
      async () => {
        probes += 1;
        return false;
      },
      { attempts: 3, delayMs: 7, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(committed).toBe(false);
    expect(probes).toBe(3);
    expect(sleeps).toEqual([7, 7]);
  });
});
