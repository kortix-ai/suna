/**
 * Writes src/components/ui/glyph-paths.generated.ts: the path data of every
 * catalogue glyph in the app's icon weight (DEFAULT_ICON_WEIGHT).
 *
 * Why: EntityAvatar drew each glyph through its Phosphor component, and each
 * component carries every shipped weight. The avatar is on every app page, so
 * the 202-glyph registry was the largest client chunk (345 KB decoded on the
 * project home, measured 2026-09-27) for 84 KB of path data it ever draws.
 *
 * Run after changing DEFAULT_ICON_WEIGHT or the glyph catalogue:
 *   bun apps/web/scripts/generate-glyph-paths.tsx
 * glyph-face.test.tsx fails while the file is stale.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderGlyphPathsModule } from '../src/components/ui/glyph-paths-source';

const target = join(import.meta.dir, '..', 'src', 'components', 'ui', 'glyph-paths.generated.ts');
writeFileSync(target, renderGlyphPathsModule());
console.log(`wrote ${target}`);
