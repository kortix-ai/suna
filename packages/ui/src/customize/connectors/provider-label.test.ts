import { describe, expect, test } from 'bun:test';

import { composioConnectionIsAuthorized } from './provider-label';

describe('composioConnectionIsAuthorized', () => {
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
