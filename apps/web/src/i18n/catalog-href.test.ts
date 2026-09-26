import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  catalogVersion,
  PUBLIC_CATALOG_DIR,
  writePublicCatalogs,
} from '../../scripts/i18n-public-catalogs.mjs';
import de from '../../translations/de.json';
import { catalogHref } from './catalog-href';

test('the catalog URL names the locale', () => {
  // Tests run without next.config, so no version is inlined.
  expect(catalogHref('de')).toMatch(/^\/i18n\/de(?:\.[0-9a-f]{12})?\.json$/);
});

test('public catalogs are content-addressed, minified, and complete', () => {
  const versions = writePublicCatalogs();
  expect(Object.keys(versions)).toHaveLength(9);
  expect(new Set(Object.values(versions)).size).toBe(9);
  const file = join(PUBLIC_CATALOG_DIR, `de.${versions.de}.json`);
  expect(existsSync(file)).toBe(true);
  const content = readFileSync(file, 'utf8');
  expect(catalogVersion(content)).toBe(versions.de);
  expect(content.includes('\n')).toBe(false);
  expect(JSON.parse(content)).toEqual(de);
  // Idempotent: the same bytes give the same names.
  expect(writePublicCatalogs()).toEqual(versions);
});
