import { describe, expect, test } from 'bun:test';
import { buildAdminConnectorViews } from './connector-list';

describe('buildAdminConnectorViews', () => {
  test('resolves independent credential states concurrently', async () => {
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const pending = (slug: string) =>
      new Promise<boolean>((resolve) => {
        started.push(slug);
        releases.set(slug, () => resolve(true));
      });
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

    const result = buildAdminConnectorViews(candidates, (candidate) => pending(candidate.slug));
    await Promise.resolve();
    expect(started).toEqual(['one', 'two']);
    releases.get('one')?.();
    releases.get('two')?.();
    expect((await result).map((connector) => connector.secretSet)).toEqual([true, true]);
  });
});
