/**
 * Generates src/lib/seo/markdown-routes.json — the htmlPath -> markdownPath map
 * that middleware uses for `Accept: text/markdown` negotiation.
 *
 * Middleware runs on the Edge runtime and cannot import public-content.ts,
 * which reads MDX sources with node:fs. Rather than reimplement the mapping in
 * an Edge-safe module (a second copy that would drift), the map is generated
 * here, committed, and pinned by src/lib/seo/markdown-routes.test.ts.
 *
 * Run with: bun run markdown-routes:build
 */
import fs from 'node:fs';
import path from 'node:path';

import { getPublicContentRecords } from '../src/lib/seo/public-content';

const OUTPUT = path.join(import.meta.dir, '..', 'src', 'lib', 'seo', 'markdown-routes.json');

// includeUseCases: false — areUseCasesPublic() reads an env var at runtime, and
// a committed static map cannot track that. Use-case markdown stays reachable
// at its direct /markdown/use-cases/*.md path.
const routes: Record<string, string> = {};
for (const record of getPublicContentRecords({ includeUseCases: false })) {
  if (record.markdownPath) routes[record.htmlPath] = record.markdownPath;
}

const sorted = Object.fromEntries(Object.entries(routes).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(OUTPUT, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`Wrote ${Object.keys(sorted).length} markdown routes to ${OUTPUT}`);
