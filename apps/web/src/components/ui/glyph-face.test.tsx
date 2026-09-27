import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IconContext } from '@phosphor-icons/react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { glyphFace } from '@/components/ui/glyph-face';
import { GLYPH_PATHS, GLYPH_PATHS_WEIGHT } from '@/components/ui/glyph-paths.generated';
import { renderGlyphPathsModule } from '@/components/ui/glyph-paths-source';
import { GLYPH_COMPONENTS, glyphComponent } from '@/components/ui/glyph-registry';
import { DEFAULT_ICON_SIZE } from '@/components/ui/icon-provider';
import { DEFAULT_ICON_WEIGHT } from '@/lib/icons/icon-config';

const APP_ICON_CONTEXT = { weight: DEFAULT_ICON_WEIGHT, size: DEFAULT_ICON_SIZE };

function markup(component: React.ComponentType<Record<string, unknown>>, props: Record<string, unknown>) {
  return renderToStaticMarkup(
    createElement(IconContext.Provider, { value: APP_ICON_CONTEXT }, createElement(component, props)),
  );
}

describe('glyphFace', () => {
  test('draws every catalogue glyph exactly as its Phosphor component does in the app weight', () => {
    const names = Object.keys(GLYPH_COMPONENTS);
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

  test('an unknown name resolves to null, like the registry', () => {
    expect(glyphFace('NoSuchGlyph')).toBeNull();
    expect(glyphComponent('NoSuchGlyph')).toBeNull();
  });

  test('the generated paths are current: regenerate with bun apps/web/scripts/generate-glyph-paths.tsx', () => {
    expect(GLYPH_PATHS_WEIGHT).toBe(DEFAULT_ICON_WEIGHT);
    expect(Object.keys(GLYPH_PATHS).sort()).toEqual(Object.keys(GLYPH_COMPONENTS).sort());
    const onDisk = readFileSync(join(import.meta.dir, 'glyph-paths.generated.ts'), 'utf8');
    expect(onDisk).toBe(renderGlyphPathsModule());
  });

  test('components rendered on every app page do not import the full glyph registry', () => {
    // The registry ships every Phosphor weight of 202 glyphs; importing it from
    // an always-loaded component puts it back in the shared client chunk.
    for (const file of ['entity-avatar.tsx', 'identity-confetti.tsx']) {
      const source = readFileSync(join(import.meta.dir, file), 'utf8');
      expect(source, file).not.toContain('glyph-registry');
    }
  });
});
