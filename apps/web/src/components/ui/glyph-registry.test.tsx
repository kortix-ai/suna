import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { WORKSPACE_GLYPH_NAMES } from '@kortix/shared';
import { GLYPH_COMPONENTS, GLYPH_SEARCH, glyphComponent } from './glyph-registry';

describe('the glyph registry', () => {
  test('every catalogue name resolves to a real component', () => {
    // This is the test that stops a typo in the shared catalogue shipping as a
    // blank tile. A name with no component is unrenderable, and the API
    // allowlists the same list — so it would be storable AND invisible.
    const missing = WORKSPACE_GLYPH_NAMES.filter((name) => !GLYPH_COMPONENTS[name]);
    expect(missing).toEqual([]);
  });

  test('every component actually renders an svg', () => {
    // Resolving to a truthy value is not the same as rendering. A bad import
    // could land `undefined` behind a defined key, or a non-component.
    for (const name of WORKSPACE_GLYPH_NAMES) {
      const Glyph = glyphComponent(name);
      expect(Glyph).not.toBeNull();
      // Bun's TSX parser rejects `<Glyph! className="…" />` (non-null assertion
      // is not valid JSX tag-name grammar) — bind the asserted value first.
      const Component = Glyph!;
      const html = renderToStaticMarkup(<Component className="size-4" />);
      expect(html).toContain('<svg');
    }
  });

  test('the registry holds no names outside the catalogue', () => {
    // An extra component is dead weight in the bundle and, worse, a glyph the
    // grid might render but the API would reject on save.
    expect(Object.keys(GLYPH_COMPONENTS).sort()).toEqual([...WORKSPACE_GLYPH_NAMES].sort());
  });

  test('glyphComponent returns null for an unknown name', () => {
    expect(glyphComponent('Skull')).toBeNull();
    expect(glyphComponent('')).toBeNull();
  });

  test('every glyph has search keywords, including its own name lowercased', () => {
    for (const name of WORKSPACE_GLYPH_NAMES) {
      const keywords = GLYPH_SEARCH[name];
      expect(keywords).toBeDefined();
      expect(keywords!.length).toBeGreaterThan(0);
      expect(keywords).toContain(name.toLowerCase());
    }
  });
});

describe('glyphComponent — prototype keys', () => {
  test('inherited Object.prototype members are not treated as glyphs', () => {
    // A bare `GLYPH_COMPONENTS[name]` returns a truthy FUNCTION for these,
    // which React then throws on when it tries to render it. The API's
    // allowlist already rejects them on write and on read, so this is
    // defence-in-depth for callers that are not the API.
    for (const name of ['toString', 'valueOf', 'constructor', 'hasOwnProperty', '__proto__']) {
      expect(glyphComponent(name)).toBeNull();
    }
  });
});
