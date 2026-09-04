import { describe, expect, test } from 'bun:test';

import {
  composioConnectionIsAuthorized,
  isManagedConnectorProvider,
  providerLabel,
} from './provider-label';

describe('providerLabel', () => {
  test('uses the transport-specific Computer Tunnel provider name', () => {
    expect(providerLabel('computer')).toBe('Computer Tunnel');
  });

  test('normalizes managed connector providers behind one product label', () => {
    expect(providerLabel('composio')).toBe('App');
    expect(providerLabel('pipedream')).toBe('App');
    expect(isManagedConnectorProvider('composio')).toBe(true);
    expect(isManagedConnectorProvider('pipedream')).toBe(true);
    expect(isManagedConnectorProvider('openapi')).toBe(false);
  });

  test('requires a real Composio session plus no-auth or a connected account', () => {
    expect(composioConnectionIsAuthorized({ provider: 'composio', toolkit: 'search' })).toBe(false);
    expect(
      composioConnectionIsAuthorized({
        provider: 'composio',
        session_id: 'trs_1',
        is_no_auth: true,
      }),
    ).toBe(true);
    expect(
      composioConnectionIsAuthorized({
        provider: 'composio',
        session_id: 'trs_1',
        connected_account_id: 'ca_1',
      }),
    ).toBe(true);
    expect(
      composioConnectionIsAuthorized({
        provider: 'pipedream',
        session_id: 'trs_1',
        is_no_auth: true,
      }),
    ).toBe(false);
  });
});
