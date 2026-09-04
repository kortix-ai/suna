import { THEME_OPTIONS } from '@/features/layout/user-menu';
import { WALLPAPERS } from '@/lib/wallpapers';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppearanceTabView } from './appearance-tab';

/** Every heading in document order, as `h<level>:<text>` — the LEVEL is the
 *  point: the pane title is the one `h2`, every section an `h3` under it. */
const headings = (html: string): string[] =>
  [...html.matchAll(/<(h[23])[^>]*>([^<]*)<\/\1>/g)].map((m) => `${m[1]}:${m[2]}`);

const html = () => renderToStaticMarkup(<AppearanceTabView />);

const EXPECTED_HEADINGS = ['h2:Appearance', 'h3:Theme', 'h3:Conversation density', 'h3:Wallpaper'];

describe('AppearanceTabView', () => {
  test('theme leads, then density, then wallpaper — one h2, the rest h3', () => {
    expect(headings(html())).toEqual(EXPECTED_HEADINGS);
  });

  test('offers exactly the themes the user menu offers, in the same order', () => {
    const out = html();
    for (const { label } of THEME_OPTIONS) expect(out).toContain(label);
    const positions = THEME_OPTIONS.map((o) => out.indexOf(o.label));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test('renders every wallpaper option', () => {
    const out = html();
    for (const wp of WALLPAPERS) expect(out).toContain(wp.name);
  });

  test('a separator sits between every consecutive section', () => {
    const out = html();
    const sectionStarts = EXPECTED_HEADINGS.filter((h) => h.startsWith('h3:')).map((h) =>
      out.indexOf(`>${h.slice(3)}<`),
    );
    expect(sectionStarts.every((i) => i >= 0)).toBe(true);
    const separators = [...out.matchAll(/data-slot="separator"/g)].map((m) => m.index ?? -1);
    expect(separators).toHaveLength(sectionStarts.length - 1);
    for (let i = 0; i < separators.length; i++) {
      expect(separators[i]).toBeGreaterThan(sectionStarts[i]);
      expect(separators[i]).toBeLessThan(sectionStarts[i + 1]);
    }
  });

  /**
   * `data-density` scopes these assertions to the density cards — a bare
   * `role="radio"` match would also catch other radio groups on the pane.
   */
  const densityChecks = (out: string): Record<string, string> =>
    Object.fromEntries(
      [...out.matchAll(/aria-checked="(true|false)" data-density="(normal|minimal)"/g)].map((m) => [
        m[2],
        m[1],
      ]),
    );

  test('conversation density offers both modes as an exclusive radio pair, Normal selected by default', () => {
    const out = html();
    expect(densityChecks(out)).toEqual({ normal: 'true', minimal: 'false' });
    expect(out).toContain('>Normal</span>');
    expect(out).toContain('>Minimal</span>');
  });

  test('conversation density marks the selected card', () => {
    const minimal = renderToStaticMarkup(<AppearanceTabView conversationDensity="minimal" />);
    expect(densityChecks(minimal)).toEqual({ normal: 'false', minimal: 'true' });
  });
});
