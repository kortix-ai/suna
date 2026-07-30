import { describe, expect, test } from 'bun:test';

import {
  getConnectorAuthorizationRequiredProfiles,
  resolveCreateFailure,
} from './new-session-failure';

const connectorProfiles = [
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

  test('a missing connector authorization opens the connect-to-start gate', () => {
    expect(resolveCreateFailure('CONNECTOR_AUTHORIZATION_REQUIRED')).toBe('connect');
    expect(resolveCreateFailure('CONNECTOR_CONNECTION_REQUIRED')).toBe('connect');
  });

  test('everything else — including codeless network failures — surfaces a toast, never a redirect', () => {
    expect(resolveCreateFailure(undefined)).toBe('toast');
    expect(resolveCreateFailure('TIMEOUT')).toBe('toast');
    expect(resolveCreateFailure('internal_error')).toBe('toast');
  });
});

describe('getConnectorAuthorizationRequiredProfiles', () => {
  test('preserves every structured connector profile in response order', () => {
    expect(
      getConnectorAuthorizationRequiredProfiles({
        code: 'CONNECTOR_AUTHORIZATION_REQUIRED',
        data: {
          code: 'CONNECTOR_AUTHORIZATION_REQUIRED',
          message: 'Connect the required connector profiles before starting this session.',
          connector_profiles: connectorProfiles,
        },
      }),
    ).toEqual(connectorProfiles);
  });

  test('accepts the structured body from the SDK details alias', () => {
    expect(
      getConnectorAuthorizationRequiredProfiles({
        code: 'CONNECTOR_AUTHORIZATION_REQUIRED',
        details: {
          code: 'CONNECTOR_AUTHORIZATION_REQUIRED',
          message: 'Connect the required connector profiles before starting this session.',
          connector_profiles: connectorProfiles,
        },
      }),
    ).toEqual(connectorProfiles);
  });

  test('rejects empty or malformed connector profile payloads', () => {
    expect(
      getConnectorAuthorizationRequiredProfiles({
        code: 'CONNECTOR_AUTHORIZATION_REQUIRED',
        data: { connector_profiles: [] },
      }),
    ).toBeNull();
    expect(
      getConnectorAuthorizationRequiredProfiles({
        code: 'CONNECTOR_AUTHORIZATION_REQUIRED',
        data: {
          connector_profiles: [{ ...connectorProfiles[0], authorization_strategy: 'workspace' }],
        },
      }),
    ).toBeNull();
    expect(
      getConnectorAuthorizationRequiredProfiles({
        code: 'CONNECTOR_CONNECTION_REQUIRED',
        data: { connector: 'gmail-read' },
      }),
    ).toBeNull();
  });
});
