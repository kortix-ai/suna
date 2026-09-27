import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { locales } from '../src/i18n/catalog.mjs';

// The browser loads the full message catalog of the page's locale from
// `public/i18n/<locale>.<hash>.json` (see src/components/i18n-provider.tsx).
//
// Why a public file, not a Route Handler or a bundler chunk:
// - the page head can preload it: the URL is known on the server;
// - `next start` / the standalone server gzip public files (a Route Handler's
//   response is sent uncompressed: 1.3 MB instead of ~460 KB);
// - the content hash in the name lets it be cached immutably, across deploys
//   that do not change the catalog.
//
// next.config.ts runs this for `next build` and `next dev` and inlines the
// returned hashes as NEXT_PUBLIC_KORTIX_I18N_VERSIONS. public/i18n/ is
// gitignored.

const webRoot = new URL('..', import.meta.url).pathname;
const translationsDir = path.join(webRoot, 'translations');
export const PUBLIC_CATALOG_DIR = path.join(webRoot, 'public', 'i18n');

/** Minified catalog bytes of one locale. */
function minified(locale) {
  const source = readFileSync(path.join(translationsDir, `${locale}.json`), 'utf8');
  return JSON.stringify(JSON.parse(source));
}

export function catalogVersion(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}

/**
 * Write every locale catalog; remove stale hashes.
 * @returns {Record<string, string>} content hash per locale
 */
export function writePublicCatalogs() {
  mkdirSync(PUBLIC_CATALOG_DIR, { recursive: true });
  /** @type {Record<string, string>} */
  const versions = {};
  const keep = new Set();
  for (const locale of locales) {
    const content = minified(locale);
    const version = catalogVersion(content);
    const file = `${locale}.${version}.json`;
    writeFileSync(path.join(PUBLIC_CATALOG_DIR, file), content);
    versions[locale] = version;
    keep.add(file);
  }
  for (const file of readdirSync(PUBLIC_CATALOG_DIR)) {
    if (!keep.has(file)) rmSync(path.join(PUBLIC_CATALOG_DIR, file));
  }
  return versions;
}
