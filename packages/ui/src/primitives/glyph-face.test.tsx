import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IconContext } from '@phosphor-icons/react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { glyphFace, glyphPathData, loadGlyphPaths } from './glyph-face';
import { GLYPH_PATHS, GLYPH_PATHS_WEIGHT } from './glyph-paths.generated';
import { GLYPH_WEIGHT, renderGlyphPathsModule } from './glyph-paths-source';
import { GLYPH_COMPONENTS, glyphComponent } from './glyph-registry';
import { DEFAULT_ICON_SIZE } from './icon-provider';
import { KORTIX_GLYPH_COMPONENTS } from './kortix-glyphs';

const APP_ICON_CONTEXT = { weight: GLYPH_WEIGHT, size: DEFAULT_ICON_SIZE };
const PHOSPHOR_NAMES = Object.keys(GLYPH_COMPONENTS).filter((name) => !Object.hasOwn(KORTIX_GLYPH_COMPONENTS, name));

function markup(component: React.ComponentType<Record<string, unknown>>, props: Record<string, unknown>) {
  return renderToStaticMarkup(
    createElement(IconContext.Provider, { value: APP_ICON_CONTEXT }, createElement(component, props)),
  );
}

describe('glyphFace', () => {
  test('after loading, every Phosphor glyph draws exactly the path its component draws solid', async () => {
    await loadGlyphPaths();
    expect(PHOSPHOR_NAMES.length).toBeGreaterThan(900);
    for (const name of PHOSPHOR_NAMES) {
      const d = markup(glyphComponent(name)!, {}).match(/<path d="([^"]+)"/)?.[1];
      expect(glyphPathData(name), name).toBe(d);
    }
  });

  test('the server renders the same svg shell as the component, with the path left empty', () => {
    // The path module loads on the client; the server never inlines it, so
    // server and client markup agree at hydration.
    const props = { size: 20, color: 'red', mirrored: true, className: 'size-4' };
    const face = markup(glyphFace('Rocket')!, props);
    const component = markup(glyphComponent('Rocket')!, props);
    expect(face).toBe(component.replace(/<path d="[^"]+"><\/path>/, '<path d=""></path>'));
  });

  test('the path module is loaded on demand, never imported statically', () => {
    const source = readFileSync(join(import.meta.dir, 'glyph-face.tsx'), 'utf8');
    expect(source).toContain("import('./glyph-paths.generated')");
    expect(source).not.toMatch(/^import [^;]*glyph-paths\.generated/m);
  });

  test('the three Kortix marks resolve to their own components', () => {
    for (const name of Object.keys(KORTIX_GLYPH_COMPONENTS)) {
      expect(glyphFace(name)).toBe(glyphComponent(name));
      expect(renderToStaticMarkup(createElement(glyphFace(name)!, {}))).toContain('fill="currentColor"');
    }
  });

  test('an unknown name resolves to null, like the registry', () => {
    expect(glyphFace('NoSuchGlyph')).toBeNull();
    expect(glyphComponent('NoSuchGlyph')).toBeNull();
  });

  test('the generated paths are current: regenerate with bun packages/ui/scripts/generate-glyph-paths.tsx', () => {
    expect(GLYPH_PATHS_WEIGHT).toBe(GLYPH_WEIGHT);
    expect(Object.keys(GLYPH_PATHS).sort()).toEqual([...PHOSPHOR_NAMES].sort());
    const onDisk = readFileSync(join(import.meta.dir, 'glyph-paths.generated.ts'), 'utf8');
    expect(onDisk).toBe(renderGlyphPathsModule());
  });

  test('entity-avatar, rendered on every app page, does not import the full glyph registry', () => {
    // The registry ships every Phosphor weight of 202 glyphs; importing it from
    // an always-loaded component puts it back in the shared client chunk.
    const source = readFileSync(join(import.meta.dir, 'entity-avatar.tsx'), 'utf8');
    expect(source).not.toContain('glyph-registry');
  });
});
