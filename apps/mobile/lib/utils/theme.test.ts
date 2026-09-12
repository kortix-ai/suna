import { beforeAll, describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

/**
 * `theme.ts` imports `DarkTheme`/`DefaultTheme`/`Theme` from
 * '@react-navigation/native'. That package's barrel re-exports
 * NavigationContainer/Link/etc., which import the real 'react-native'
 * package. react-native's runtime entry (index.js) contains Flow-only
 * syntax (`import typeof * as X from './index.js.flow'`) that Bun's
 * transpiler cannot parse — `bun test` crashes with "Unexpected typeof"
 * before any assertion runs, independent of anything in this test.
 *
 * Mock '@react-navigation/native' with the exact DefaultTheme/DarkTheme
 * values React Navigation ships (verified against
 * node_modules/@react-navigation/native/lib/module/theming/{Default,Dark}Theme.js)
 * so theme.ts's `...DefaultTheme` / `...DarkTheme` spreads see real data,
 * without ever loading the unparsable 'react-native' module graph. This
 * only affects this test process; production code is untouched.
 */
mock.module('@react-navigation/native', () => ({
  DefaultTheme: {
    dark: false,
    colors: {
      primary: 'rgb(0, 122, 255)',
      background: 'rgb(242, 242, 242)',
      card: 'rgb(255, 255, 255)',
      text: 'rgb(28, 28, 30)',
      border: 'rgb(216, 216, 216)',
      notification: 'rgb(255, 59, 48)',
    },
    fonts: {},
  },
  DarkTheme: {
    dark: true,
    colors: {
      primary: 'rgb(10, 132, 255)',
      background: 'rgb(1, 1, 1)',
      card: 'rgb(18, 18, 18)',
      text: 'rgb(229, 229, 231)',
      border: 'rgb(39, 39, 41)',
      notification: 'rgb(255, 69, 58)',
    },
    fonts: {},
  },
}));

let THEME: (typeof import('./theme'))['THEME'];
let NAV_THEME: (typeof import('./theme'))['NAV_THEME'];
let withAlpha: (typeof import('./theme'))['withAlpha'];

beforeAll(async () => {
  const mod = await import('./theme');
  THEME = mod.THEME;
  NAV_THEME = mod.NAV_THEME;
  withAlpha = mod.withAlpha;
});

const css = readFileSync(join(__dirname, '../../global.css'), 'utf8');

/**
 * React Native's real color parser. Resolved THROUGH react-native rather than
 * declared as our own dependency, so this always exercises the exact copy the
 * installed React Native uses — a separately-versioned devDependency could
 * drift and quietly stop testing the real thing.
 *
 * `normalizeColor` returns null for any string React Native cannot parse. RN
 * then drops the style silently: no error, no warning, nothing rendered.
 */
const normalizeColor = createRequire(
  createRequire(import.meta.url).resolve('react-native/package.json')
)('@react-native/normalize-colors') as (c: string) => number | null;

/**
 * Compare two color strings by PARSED VALUE, not by text. `hsl(0 0% 0% / .045)`
 * and `hsla(0, 0%, 0%, 0.045)` are the same color; only one of them is a color
 * React Native can actually render, so global.css and THEME legitimately spell
 * alpha colors differently.
 */
function sameColor(actual: string, expected: string): void {
  // The expected side comes from global.css, which legitimately uses the CSS
  // Color Level 4 slash form. Rewrite it to the comma form purely so the
  // parser can read it — this is a test-side translation, never what ships.
  const parseable = expected.replace(
    /^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\/\s*([\d.]+)\s*\)$/,
    (_m, h, sat, l, a) => `hsla(${h}, ${sat}%, ${l}%, ${a})`
  );
  // THEME's own value must be renderable by React Native as written.
  expect(`${actual} -> ${normalizeColor(actual)}`).not.toContain('null');
  expect(normalizeColor(actual)).toBe(normalizeColor(parseable));
}

/**
 * Extract the declaration block for a top-level selector.
 *
 * The naive `css.split(':root')[1]` approach breaks on this file: the
 * literal substring ':root' also appears inside comments BEFORE the real
 * `:root {` selector (e.g. line 10, a comment ending "...globals.css :root",
 * closed by a comment-close marker) and INSIDE the light block itself
 * (line 60, line 71), and `.dark:root` also contains the substring
 * ':root'. Splitting on the bare string therefore does not reliably land
 * on the real selector's block.
 *
 * Instead, anchor the match to a selector that starts a line (only
 * whitespace before it) and is immediately followed by '{'. That rules out
 * mid-comment occurrences of ':root' and disambiguates ':root' from
 * '.dark:root' (the '.' before "dark:root" blocks the ':root'-only match).
 */
function extractBlock(selector: ':root' | '.dark:root'): string {
  const escaped = selector.replace(/\./g, '\\.');
  const selectorRegex = new RegExp(`(^|\\n)[ \\t]*${escaped}[ \\t]*\\{`);
  const m = selectorRegex.exec(css);
  if (!m) throw new Error(`selector not found: ${selector}`);
  const braceOpen = css.indexOf('{', m.index);
  const braceClose = css.indexOf('}', braceOpen);
  if (braceOpen === -1 || braceClose === -1) {
    throw new Error(`could not find braces for selector: ${selector}`);
  }
  return css.slice(braceOpen + 1, braceClose);
}

/**
 * Read the raw declared value of `--name` in `scope`, up to the terminating
 * `;` (comments live after the `;`, so this is safe to include slash-alpha
 * values like `0 0% 0% / 0.045`, which a `[^;/]+` capture would truncate at
 * the `/`).
 */
function rawTokenValue(scope: ':root' | '.dark:root', name: string): string {
  const block = extractBlock(scope);
  const m = block.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`token --${name} not found in ${scope}`);
  return m[1].trim();
}

/**
 * Resolve `--name` in `scope` to a concrete value, following one level (or
 * more) of `var(--other)` indirection within the same scope. `--focus-ring`,
 * `--foreground-strong`, and `--foreground-weak` are declared in global.css
 * as `var(--ring)` / `var(--foreground)` / `var(--muted-foreground)` rather
 * than a literal — JavaScript cannot dereference a CSS variable, so THEME
 * transcribes the referenced token's concrete value instead. This resolves
 * the same reference so the test compares like with like.
 */
function resolveTokenValue(scope: ':root' | '.dark:root', name: string): string {
  const raw = rawTokenValue(scope, name);
  const varMatch = raw.match(/^var\(--([a-z0-9-]+)\)$/);
  if (varMatch) return resolveTokenValue(scope, varMatch[1]);
  return raw;
}

function token(scope: ':root' | '.dark:root', name: string): string {
  return `hsl(${resolveTokenValue(scope, name)})`;
}

// Print what the parser actually extracted so a silent "same block twice"
// bug (which would make the light/dark assertions vacuous) is visible in
// the test output, not just assumed correct.
const lightBackground = token(':root', 'background');
const darkBackground = token('.dark:root', 'background');
console.log('[theme.test] :root --background      ->', lightBackground);
console.log('[theme.test] .dark:root --background  ->', darkBackground);

describe('extractBlock parses distinct light/dark blocks', () => {
  it('light and dark --background genuinely differ', () => {
    expect(lightBackground).not.toBe(darkBackground);
  });

  it('light block does not include .dark:root declarations', () => {
    const lightBlock = extractBlock(':root');
    // --sidebar-primary differs between light (180 0% 9%) and dark
    // (225.4 84% 49%); if the parser bled into the dark block the light
    // block would contain the dark value instead of its own.
    expect(lightBlock).toContain('--sidebar-primary: 180 0% 9%');
    expect(lightBlock).not.toContain('225.4 84% 49%');
  });

  it('dark block does not include :root (light) declarations', () => {
    const darkBlock = extractBlock('.dark:root');
    expect(darkBlock).toContain('--sidebar-primary: 225.4 84% 49%');
    expect(darkBlock).not.toContain('--sidebar-primary: 180 0% 9%');
  });
});

describe('THEME derives from global.css', () => {
  it('light background matches --background', () => {
    expect(THEME.light.background as string).toBe(token(':root', 'background'));
  });

  it('light primary matches --primary', () => {
    expect(THEME.light.primary as string).toBe(token(':root', 'primary'));
  });

  it('dark background matches --background', () => {
    expect(THEME.dark.background as string).toBe(token('.dark:root', 'background'));
  });

  it('dark primary matches --primary', () => {
    expect(THEME.dark.primary as string).toBe(token('.dark:root', 'primary'));
  });

  it('every light color key matches its global.css token', () => {
    const keyToToken: Record<string, string> = {
      background: 'background',
      foreground: 'foreground',
      card: 'card',
      cardForeground: 'card-foreground',
      popover: 'popover',
      popoverForeground: 'popover-foreground',
      primary: 'primary',
      primaryForeground: 'primary-foreground',
      secondary: 'secondary',
      secondaryForeground: 'secondary-foreground',
      muted: 'muted',
      mutedForeground: 'muted-foreground',
      accent: 'accent',
      accentForeground: 'accent-foreground',
      destructive: 'destructive',
      border: 'border',
      input: 'input',
      ring: 'ring',
      pane: 'pane',
      surface: 'surface',
      hover: 'hover',
      active: 'active',
      focusRing: 'focus-ring',
      foregroundStrong: 'foreground-strong',
      foregroundWeak: 'foreground-weak',
    };
    for (const [themeKey, cssName] of Object.entries(keyToToken)) {
      sameColor(
        THEME.light[themeKey as keyof typeof THEME.light] as string,
        token(':root', cssName)
      );
    }
  });

  it('every dark color key matches its global.css token', () => {
    const keyToToken: Record<string, string> = {
      background: 'background',
      foreground: 'foreground',
      card: 'card',
      cardForeground: 'card-foreground',
      popover: 'popover',
      popoverForeground: 'popover-foreground',
      primary: 'primary',
      primaryForeground: 'primary-foreground',
      secondary: 'secondary',
      secondaryForeground: 'secondary-foreground',
      muted: 'muted',
      mutedForeground: 'muted-foreground',
      accent: 'accent',
      accentForeground: 'accent-foreground',
      destructive: 'destructive',
      border: 'border',
      input: 'input',
      ring: 'ring',
      pane: 'pane',
      surface: 'surface',
      hover: 'hover',
      active: 'active',
      focusRing: 'focus-ring',
      foregroundStrong: 'foreground-strong',
      foregroundWeak: 'foreground-weak',
    };
    for (const [themeKey, cssName] of Object.entries(keyToToken)) {
      sameColor(
        THEME.dark[themeKey as keyof typeof THEME.dark] as string,
        token('.dark:root', cssName)
      );
    }
  });
});

/**
 * Task 7 (M2) ported --pane/--surface/--hover/--active/--focus-ring/
 * --foreground-strong/--foreground-weak into global.css but Task 8 built
 * THEME from the key list that predates that port, so these tokens existed
 * in CSS with no JS counterpart. Task 10 adds them to THEME; one dedicated
 * test per key (rather than folding them into the loops above) keeps each
 * key's drift protection independently reportable in `bun test` output.
 */
describe('THEME carries the Task 7 (M2) tokens Task 8 missed', () => {
  it('pane: light and dark match their global.css tokens and differ from each other', () => {
    expect(THEME.light.pane as string).toBe(token(':root', 'pane'));
    expect(THEME.dark.pane as string).toBe(token('.dark:root', 'pane'));
    expect(THEME.light.pane as string).not.toBe(THEME.dark.pane as string);
  });

  it('surface: light and dark match their global.css tokens and differ from each other', () => {
    expect(THEME.light.surface as string).toBe(token(':root', 'surface'));
    expect(THEME.dark.surface as string).toBe(token('.dark:root', 'surface'));
    expect(THEME.light.surface as string).not.toBe(THEME.dark.surface as string);
  });

  it('hover: light and dark match their global.css slash-alpha tokens and differ from each other', () => {
    sameColor(THEME.light.hover as string, token(':root', 'hover'));
    sameColor(THEME.dark.hover as string, token('.dark:root', 'hover'));
    expect(THEME.light.hover as string).not.toBe(THEME.dark.hover as string);
    // Alpha is load-bearing: catches a truncated-at-'/' capture regression.
    // Spelled hsla() because React Native rejects the slash form outright.
    expect(THEME.light.hover as string).toBe('hsla(0, 0%, 0%, 0.045)');
    expect(THEME.dark.hover as string).toBe('hsla(0, 0%, 100%, 0.06)');
  });

  it('active: light and dark match their global.css slash-alpha tokens and differ from each other', () => {
    sameColor(THEME.light.active as string, token(':root', 'active'));
    sameColor(THEME.dark.active as string, token('.dark:root', 'active'));
    expect(THEME.light.active as string).not.toBe(THEME.dark.active as string);
    expect(THEME.light.active as string).toBe('hsla(0, 0%, 0%, 0.075)');
    expect(THEME.dark.active as string).toBe('hsla(0, 0%, 100%, 0.1)');
  });

  it('focusRing: resolves var(--ring) to the concrete --ring value in each scope', () => {
    expect(THEME.light.focusRing as string).toBe(token(':root', 'focus-ring'));
    expect(THEME.light.focusRing as string).toBe(THEME.light.ring as string);
    expect(THEME.dark.focusRing as string).toBe(token('.dark:root', 'focus-ring'));
    expect(THEME.dark.focusRing as string).toBe(THEME.dark.ring as string);
  });

  it('foregroundStrong: resolves var(--foreground) to the concrete --foreground value in each scope', () => {
    expect(THEME.light.foregroundStrong as string).toBe(token(':root', 'foreground-strong'));
    expect(THEME.light.foregroundStrong as string).toBe(THEME.light.foreground as string);
    expect(THEME.dark.foregroundStrong as string).toBe(token('.dark:root', 'foreground-strong'));
    expect(THEME.dark.foregroundStrong as string).toBe(THEME.dark.foreground as string);
  });

  it('foregroundWeak: resolves var(--muted-foreground) to the concrete --muted-foreground value in each scope', () => {
    expect(THEME.light.foregroundWeak as string).toBe(token(':root', 'foreground-weak'));
    expect(THEME.light.foregroundWeak as string).toBe(THEME.light.mutedForeground as string);
    expect(THEME.dark.foregroundWeak as string).toBe(token('.dark:root', 'foreground-weak'));
    expect(THEME.dark.foregroundWeak as string).toBe(THEME.dark.mutedForeground as string);
  });
});

/**
 * The 6 brand accents (`--kortix-*`) are declared byte-identical in
 * `:root` and `.dark:root` — THEME.accent carries them as one
 * theme-invariant group (see lib/utils/theme.ts). Pin each one against
 * both scopes so a change to either scope's token — or a drift between
 * the two scopes themselves — is caught here.
 */
describe('THEME.accent carries the 6 brand accents, theme-invariant', () => {
  const keyToToken: Record<string, string> = {
    blue: 'kortix-blue',
    yellow: 'kortix-yellow',
    orange: 'kortix-orange',
    green: 'kortix-green',
    purple: 'kortix-purple',
    red: 'kortix-red',
  };

  for (const [themeKey, cssName] of Object.entries(keyToToken)) {
    it(`${themeKey}: matches --${cssName} in both :root and .dark:root, which are identical`, () => {
      const light = token(':root', cssName);
      const dark = token('.dark:root', cssName);
      expect(light).toBe(dark);
      expect(THEME.accent[themeKey as keyof typeof THEME.accent] as string).toBe(light);
      expect(THEME.accent[themeKey as keyof typeof THEME.accent] as string).toBe(dark);
    });
  }
});

describe('NAV_THEME carries no untokened color', () => {
  it('contains no #rrggbb hex literals', () => {
    const all = JSON.stringify(NAV_THEME);
    expect(all).not.toMatch(/#[0-9a-fA-F]{6}/);
  });

  it('light primary is the tokened THEME.light.primary', () => {
    expect(NAV_THEME.light.colors.primary).toBe(THEME.light.primary);
  });

  it('dark primary is the tokened THEME.dark.primary', () => {
    expect(NAV_THEME.dark.colors.primary).toBe(THEME.dark.primary);
  });

  it('background/border/card/text/notification derive from THEME', () => {
    expect(NAV_THEME.light.colors.background).toBe(THEME.light.background);
    expect(NAV_THEME.light.colors.border).toBe(THEME.light.border);
    expect(NAV_THEME.light.colors.card).toBe(THEME.light.card);
    expect(NAV_THEME.light.colors.text).toBe(THEME.light.foreground);
    expect(NAV_THEME.light.colors.notification).toBe(THEME.light.destructive);

    expect(NAV_THEME.dark.colors.background).toBe(THEME.dark.background);
    expect(NAV_THEME.dark.colors.border).toBe(THEME.dark.border);
    expect(NAV_THEME.dark.colors.card).toBe(THEME.dark.card);
    expect(NAV_THEME.dark.colors.text).toBe(THEME.dark.foreground);
    expect(NAV_THEME.dark.colors.notification).toBe(THEME.dark.destructive);
  });
});


/**
 * `withAlpha` must emit a string React Native can actually parse.
 *
 * This asserts against the REAL parser — `@react-native/normalize-colors`,
 * the module React Native uses to turn a style color into an int — not
 * against a string this test expects. A previous implementation emitted the
 * CSS Color Level 4 slash form `hsl(H S% L% / A)`, which `normalizeColor`
 * rejects by returning null. React Native then drops the style silently: no
 * error, no warning, no failing test. 890 translucent surfaces across 92
 * files rendered fully transparent, and every static gate passed.
 *
 * A test that compared `withAlpha(...)` to an expected string would have
 * passed too. Only the parser knows.
 */
describe('withAlpha emits a color React Native can parse', () => {
  // `radius` is a length, not a color. Everything else in THEME.light /
  // THEME.dark is a color and must parse.
  const NON_COLOR_KEYS = new Set(['radius']);
  const colorEntries = (scope: 'light' | 'dark') =>
    Object.entries(THEME[scope]).filter(([k]) => !NON_COLOR_KEYS.has(k)) as [string, string][];

  it('the real parser accepts every THEME color as-is', () => {
    const rejected: string[] = [];
    for (const scope of ['light', 'dark'] as const) {
      for (const [name, value] of colorEntries(scope)) {
        if (normalizeColor(value) == null) rejected.push(`${scope}.${name} = ${value}`);
      }
    }
    for (const [name, value] of Object.entries(THEME.accent)) {
      if (normalizeColor(value) == null) rejected.push(`accent.${name} = ${value}`);
    }
    expect(rejected).toEqual([]);
  });

  it('the real parser accepts withAlpha output for every plain-hsl token', () => {
    // `hover` / `active` already carry an alpha channel, so withAlpha rejects
    // them by design — re-alpha-ing a translucent color is ambiguous. They are
    // covered by the as-is test above.
    const rejected: string[] = [];
    for (const scope of ['light', 'dark'] as const) {
      for (const [name, value] of colorEntries(scope)) {
        if (value.startsWith('hsla(')) continue;
        const out = withAlpha(value, 0.14);
        if (normalizeColor(out) == null) rejected.push(`${scope}.${name} -> ${out}`);
      }
    }
    for (const [name, value] of Object.entries(THEME.accent)) {
      const out = withAlpha(value, 0.2);
      if (normalizeColor(out) == null) rejected.push(`accent.${name} -> ${out}`);
    }
    expect(rejected).toEqual([]);
  });

  it('rejects the slash-alpha form that broke this before', () => {
    // Guards the regression directly: if anyone reverts withAlpha to the
    // `hsl(H S% L% / A)` form, the parser returns null and this documents why.
    expect(normalizeColor('hsl(357.2 100% 45.3% / 0.14)')).toBeNull();
    expect(normalizeColor('hsla(357.2, 100%, 45.3%, 0.14)')).not.toBeNull();
  });

  it('produces the alpha actually requested', () => {
    // normalizeColor returns 0xRRGGBBAA; the low byte is alpha.
    const packed = normalizeColor(withAlpha(THEME.light.destructive, 0.5))!;
    expect(packed & 0xff).toBe(128); // 0.5 * 255, rounded
  });

  it('throws on input that is not a THEME hsl string, instead of returning garbage', () => {
    expect(() => withAlpha('#ff0000', 0.5)).toThrow();
    expect(() => withAlpha('rgb(1,2,3)', 0.5)).toThrow();
  });
});
