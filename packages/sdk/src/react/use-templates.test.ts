import { describe, expect, mock, test } from 'bun:test';

// Same harness as `./use-project-triggers.test.ts` — `useQuery`/`useMutation`
// mocked to identity so each hook can be called as a plain function and its
// `queryKey` / `enabled` wiring asserted without a render tree.

mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
  useMutation: (config: Record<string, unknown>) => config,
}));

const { useTemplateCatalog, useTemplate, templateCatalogKey } = await import(
  './use-templates'
);
const { qk } = await import('./query-keys');

describe('useTemplateCatalog — the catalog', () => {
  test('keys on the search term, so two searches are two cache entries', () => {
    const a = useTemplateCatalog({ q: 'seo' }) as any;
    const b = useTemplateCatalog({ q: 'standup' }) as any;
    expect(a.queryKey).not.toEqual(b.queryKey);
    expect(a.queryKey).toEqual(templateCatalogKey({ q: 'seo' }));
    expect(a.queryKey).toEqual(qk.templates.list({ q: 'seo' }));
  });

  test('an absent option and an explicit undefined produce the SAME key', () => {
    // Otherwise the first render and the first "clear the search" render would
    // read two different cache entries and the list would flicker.
    expect(templateCatalogKey()).toEqual(templateCatalogKey({ q: undefined }));
  });

  test('is always enabled — the catalog needs no project and no token', () => {
    expect((useTemplateCatalog() as any).enabled).not.toBe(false);
  });
});

describe('useTemplate — one card', () => {
  test('is disabled without a slug', () => {
    expect((useTemplate(undefined) as any).enabled).toBe(false);
    expect((useTemplate(null) as any).enabled).toBe(false);
    expect((useTemplate('seo-watch') as any).enabled).toBe(true);
    expect((useTemplate('seo-watch') as any).queryKey).toEqual(
      qk.templates.detail('seo-watch'),
    );
  });
});
