import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IconContext } from '@phosphor-icons/react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { glyphFace } from './glyph-face';
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
  test('draws every Phosphor catalogue glyph exactly as its component does in the solid weight', () => {
    const names = PHOSPHOR_NAMES;
    expect(names.length).toBeGreaterThan(200);
    for (const name of names) {
      const props = { className: 'size-4 text-glyph-blue' };
      expect(markup(glyphFace(name)!, props), name).toBe(markup(glyphComponent(name)!, props));
    }
  });

  test('honours an explicit size, colour and mirroring like the component', () => {
    const props = { size: 20, color: 'red', mirrored: true };
    expect(markup(glyphFace('Rocket')!, props)).toBe(markup(glyphComponent('Rocket')!, props));
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
