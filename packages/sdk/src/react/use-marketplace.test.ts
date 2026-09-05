import { describe, expect, mock, test } from 'bun:test';

// Same harness as `./use-project-triggers.test.ts` — `useQuery`/`useMutation`
// mocked to identity so each hook can be called as a plain function and its
// `queryKey` / `enabled` wiring asserted without a render tree.

mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
  useMutation: (config: Record<string, unknown>) => config,
}));

const { useMarketplaceTemplates, useMarketplaceTemplate, marketplaceTemplatesKey } = await import(
  './use-marketplace'
);
const { qk } = await import('./query-keys');

describe('useMarketplaceTemplates — the catalog', () => {
  test('keys on the search term, so two searches are two cache entries', () => {
    const a = useMarketplaceTemplates({ q: 'seo' }) as any;
    const b = useMarketplaceTemplates({ q: 'standup' }) as any;
    expect(a.queryKey).not.toEqual(b.queryKey);
    expect(a.queryKey).toEqual(marketplaceTemplatesKey({ q: 'seo' }));
    expect(a.queryKey).toEqual(qk.marketplace.list({ q: 'seo' }));
  });

  test('an absent option and an explicit undefined produce the SAME key', () => {
    // Otherwise the first render and the first "clear the search" render would
    // read two different cache entries and the list would flicker.
    expect(marketplaceTemplatesKey()).toEqual(marketplaceTemplatesKey({ q: undefined }));
  });

  test('is always enabled — the catalog needs no project and no token', () => {
    expect((useMarketplaceTemplates() as any).enabled).not.toBe(false);
  });
});

describe('useMarketplaceTemplate — one card', () => {
  test('is disabled without a slug', () => {
    expect((useMarketplaceTemplate(undefined) as any).enabled).toBe(false);
    expect((useMarketplaceTemplate(null) as any).enabled).toBe(false);
    expect((useMarketplaceTemplate('seo-watch') as any).enabled).toBe(true);
    expect((useMarketplaceTemplate('seo-watch') as any).queryKey).toEqual(
      qk.marketplace.detail('seo-watch'),
    );
  });
});
