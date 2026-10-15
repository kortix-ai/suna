import { INTERFACE_THEME_OPTIONS } from '@/features/layout/interface-theme';
import { TERMINAL_THEMES } from '@/lib/interface-themes';
import { WALLPAPERS } from '@/lib/wallpapers';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppearanceTabView, DEFAULT_APPEARANCE_TAB_COPY } from './appearance-tab';

/** A row's expected trigger label: the catalog entry for a Kortix row, the
 *  terminal theme's own name verbatim otherwise — mirrors `nameFor` in
 *  `appearance-tab.tsx`, which is not exported. */
const labelFor = (option: (typeof INTERFACE_THEME_OPTIONS)[number]): string =>
  option.kind === 'labelled' ? DEFAULT_APPEARANCE_TAB_COPY.themes[option.labelKey] : option.name;

/** Every heading in document order, as `h<level>:<text>` — the LEVEL is the
 *  point: the pane title is the one `h2`, every section an `h3` under it. */
const headings = (html: string): string[] =>
  [...html.matchAll(/<(h[23])[^>]*>([^<]*)<\/\1>/g)].map((m) => `${m[1]}:${m[2]}`);

const html = () => renderToStaticMarkup(<AppearanceTabView />);

const EXPECTED_HEADINGS = [
  'h2:Appearance',
  'h3:Theme',
  'h3:Conversation density',
  'h3:Rich answers',
  'h3:Wallpaper',
];

describe('AppearanceTabView', () => {
  test('renders injected locale copy instead of fixed English labels', () => {
    const out = renderToStaticMarkup(
      <AppearanceTabView
        copy={{
          theme: 'Тема',
          themeDescription: 'Изаберите изглед.',
          conversationDensity: 'Густина разговора',
          conversationDensityDescription: 'Колико детаља се приказује.',
          richAnswers: 'Богати одговори',
          richAnswersDescription: 'Прикажи поређења као визуелне приказе.',
          wallpaper: 'Позадина',
          wallpaperDescription: 'Позадина радног простора.',
          themes: {
            system: 'Системска',
            light: 'Светла',
            pureLight: 'Чиста светла',
            dark: 'Тамна',
            pureDark: 'Чиста тамна',
          },
          themeGroups: {
            kortix: 'Kortix',
            lightThemes: 'Светле теме',
            darkThemes: 'Тамне теме',
          },
          themeSearch: { placeholder: 'Претражи теме…', empty: 'Нема пронађених тема' },
          densities: {
            normal: { label: 'Нормално', description: 'Пуни приказ' },
            minimal: { label: 'Минимално', description: 'Сажети приказ' },
          },
          wallpapers: {
            dither: 'Дитеринг',
            brandmark: 'Знак бренда',
            nebula: 'Пикселски зраци',
            silk: 'Свила',
            grain: 'Зрно',
            neuro: 'Неуро',
            blank: 'Празно',
          },
          defaultWallpaper: 'Подразумевано',
        }}
      />,
    );
    expect(out).toContain('Тема');
    expect(out).toContain('Густина разговора');
    expect(out).toContain('Богати одговори');
    expect(out).toContain('Системска');
    expect(out).toContain('Пикселски зраци');
    expect(out).not.toContain('>Theme<');
  });

  test('theme leads, then density, rich answers, wallpaper — one h2, the rest h3', () => {
    expect(headings(html())).toEqual(EXPECTED_HEADINGS);
  });

  // The Select's own option list renders in a Radix portal, which static
  // markup cannot reach — `INTERFACE_THEME_OPTIONS` is locked in
  // user-menu.test.tsx. What IS reachable is the trigger: it names and
  // previews the selection, for every one of the 117 rows (System, the 4
  // Kortix palettes, and all 39 terminal themes).
  test('the theme trigger names and previews every selectable theme', () => {
    expect(INTERFACE_THEME_OPTIONS.length).toBe(1 + 4 + TERMINAL_THEMES.length);
    for (const option of INTERFACE_THEME_OPTIONS) {
      const out = renderToStaticMarkup(<AppearanceTabView theme={option.value} />);
      expect(out).toContain(`>${labelFor(option)}<`);
      expect(out).toContain('id="appearance-theme"');
    }
  });

  // Every terminal theme's label is its own proper noun, sourced from the
  // generated JSON, never a translated `settings.appearance.themes` entry —
  // "Iceberg Dark" must never be looked up as a catalog key. (Sample ids avoid
  // names that are also Shiki code-theme ids; see code-theme.test.ts.)
  test('a terminal theme shows its own name, not a translation lookup', () => {
    const iceberg = INTERFACE_THEME_OPTIONS.find((o) => o.value === 'iceberg-dark');
    expect(iceberg?.kind).toBe('named');
    const out = renderToStaticMarkup(<AppearanceTabView theme="iceberg-dark" />);
    expect(out).toContain('>Iceberg Dark<');
  });

  test('each swatch previews its own palette scope', () => {
    const blue = renderToStaticMarkup(<AppearanceTabView theme="pure-dark" />);
    expect(blue).toContain('data-theme-preview="pure-dark"');
    // System previews both sides at the chosen palettes.
    const system = renderToStaticMarkup(
      <AppearanceTabView theme="system" themeChoice={{ light: 'light', dark: 'dark' }} />,
    );
    expect(system).toContain('data-theme-preview="light"');
    expect(system).toContain('data-theme-preview="dark"');
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
