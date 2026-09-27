import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// Browser bundles import this package for small helpers (labels, managed ids,
// enablement rules). The bundled models.dev snapshot is ~7.6 MB of JSON. Only
// a module that USES the snapshot may import it, so a bundler can drop it for
// every consumer that never touches `CATALOG`/`catalogModelForWireModel`.
const IMPORTS_SNAPSHOT = /from\s+['"]\.\/catalog\.generated\.json['"]/;

describe('catalog snapshot isolation', () => {
  test('index.ts re-exports the snapshot but does not import it', () => {
    const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(index).not.toMatch(IMPORTS_SNAPSHOT);
  });

  test('enablement.ts does not import the snapshot', () => {
    const enablement = readFileSync(new URL('./enablement.ts', import.meta.url), 'utf8');
    expect(enablement).not.toMatch(IMPORTS_SNAPSHOT);
  });

  test('CATALOG and catalogModelForWireModel stay on the public surface', async () => {
    const mod = await import('./index');
    expect(mod.CATALOG.providers.length).toBeGreaterThan(0);
    expect(mod.catalogModelForWireModel('deepseek-v4.1-flash')?.id).toBeDefined();
  });

  test('CATALOG_PROVIDER_ENV is the id/env projection of the snapshot', async () => {
    // The slim file is regenerated with the snapshot
    // (apps/web/scripts/enrich-llm-catalog-capabilities.ts). This catches drift.
    const mod = await import('./index');
    expect(mod.CATALOG_PROVIDER_ENV).toEqual(
      mod.CATALOG.providers.map((provider) => ({ id: provider.id, env: provider.env ?? [] })),
    );
  });

  test('index.ts imports only the slim provider/env file', () => {
    const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(index).toContain("from './provider-env.generated.json'");
  });
});
