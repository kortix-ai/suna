import { describe, expect, test } from 'bun:test';
import { getBlumeDocsOutputPaths } from './blume-docs.mjs';

describe('getBlumeDocsOutputPaths', () => {
  test('names the two files that prove the docs build landed', () => {
    const paths = getBlumeDocsOutputPaths();
    expect(paths.some((p) => p.endsWith('public/docs/index.html'))).toBe(true);
    expect(paths.some((p) => p.endsWith('public/docs/audit-actions/index.html'))).toBe(true);
  });
});

// Assert the generated document, not a copy of Blume's title-template logic.
describe('built docs document titles', () => {
  test('names the home page once and preserves the inner-page suffix', async () => {
    const { buildBlumeDocs } = await import('./blume-docs.mjs');
    buildBlumeDocs();
    const home = await Bun.file(new URL('../public/docs/index.html', import.meta.url)).text();
    const inner = await Bun.file(new URL('../public/docs/audit-actions/index.html', import.meta.url)).text();
    expect(home.match(/<title>(.*?)<\/title>/)?.[1]).toBe('Docs - Kortix');
    expect(inner.match(/<title>(.*?)<\/title>/)?.[1]).toBe('Audit actions - Kortix');
  }, 120_000);
});
