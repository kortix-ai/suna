import { describe, expect, test } from 'bun:test';
import { buildAdminConnectorViews } from './connector-list';

describe('buildAdminConnectorViews', () => {
  test('maps preloaded credential state without connector-local reads', () => {
    const candidates = ['one', 'two'].map((slug) => ({
      slug,
      name: slug,
      provider: 'pipedream',
      platform: null,
      iconUrl: null,
      status: 'active',
      authorizationStrategy: slug === 'one' ? ('project' as const) : ('user' as const),
      sensitive: false,
      actions: [],
      requiresAuth: true,
      requestAuthType: slug === 'one' ? ('hmac' as const) : ('bearer' as const),
      secretIdentifier: slug === 'one' ? 'SIGNING_KEY' : null,
      credentialSource: slug === 'one' ? ('project_secret' as const) : ('stored' as const),
    }));

    const result = buildAdminConnectorViews(candidates, new Set(['two']));

    expect(result.map((connector) => connector.secretSet)).toEqual([false, true]);
    expect(result.map((connector) => connector.authorizationStrategy)).toEqual(['project', 'user']);
    expect(result.map((connector) => connector.requestAuthType)).toEqual(['hmac', 'bearer']);
    expect(result.map((connector) => connector.secretIdentifier)).toEqual(['SIGNING_KEY', null]);
    expect(result.map((connector) => connector.credentialSource)).toEqual([
      'project_secret',
      'stored',
    ]);
  });
});
