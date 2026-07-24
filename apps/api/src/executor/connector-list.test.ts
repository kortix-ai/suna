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
      sensitive: false,
      actions: [],
      requiresAuth: true,
    }));

    const result = buildAdminConnectorViews(candidates, new Set(['two']));

    expect(result.map((connector) => connector.secretSet)).toEqual([false, true]);
  });
});
