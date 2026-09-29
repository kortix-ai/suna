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

  // The helpers moved from index.ts to lite.ts (index.ts re-exports them), so
  // the slim-file import is asserted where it now lives.
  test('lite.ts (the helpers index.ts re-exports) imports only the slim provider/env file', () => {
    const lite = readFileSync(new URL('./lite.ts', import.meta.url), 'utf8');
    expect(lite).toContain("from './provider-env.generated.json'");
  });
});

// Metro (React Native) does not tree-shake: importing `index.ts` bundles the
// snapshot even when `CATALOG` is never read. `./lite` is the same surface
// minus the two snapshot readers, for bundlers that keep every import.
describe('the ./lite entry', () => {
  test('never imports catalog-data or the snapshot', () => {
    const lite = readFileSync(new URL('./lite.ts', import.meta.url), 'utf8');
    expect(lite).not.toMatch(IMPORTS_SNAPSHOT);
    expect(lite).not.toMatch(/from\s+['"]\.\/catalog-data['"]/);
  });

  test('exports every index name except CATALOG and catalogModelForWireModel', async () => {
    const index = Object.keys(await import('./index')).sort();
    const lite = Object.keys(await import('./lite')).sort();
    expect(lite).toEqual(
      index.filter((name) => name !== 'CATALOG' && name !== 'catalogModelForWireModel'),
    );
  });
});
