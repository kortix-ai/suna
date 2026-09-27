import { beforeAll, describe, expect, it, mock } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

/**
 * `theme.ts` imports `DarkTheme`/`DefaultTheme`/`Theme` from
 * 'expo-router/react-navigation' (SDK 56: expo-router vendors React
 * Navigation). That barrel re-exports NavigationContainer/Link/etc., which
 * import the real 'react-native' package. react-native's runtime entry
 * (index.js) contains Flow-only syntax (`import typeof * as X from
 * './index.js.flow'`) that Bun's transpiler cannot parse — `bun test`
 * crashes with "Unexpected typeof" before any assertion runs, independent of
 * anything in this test.
 *
 * Mock 'expo-router/react-navigation' with the exact DefaultTheme/DarkTheme
 * values it ships (verified against
 * node_modules/expo-router/build/react-navigation/native/theming/{Default,Dark}Theme.js)
 * so theme.ts's `...DefaultTheme` / `...DarkTheme` spreads see real data,
 * without ever loading the unparsable 'react-native' module graph. This
 * only affects this test process; production code is untouched.
 */
mock.module('expo-router/react-navigation', () => ({
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
let toHexColor: (typeof import('./theme'))['toHexColor'];
let MOTION: (typeof import('./theme'))['MOTION'];

beforeAll(async () => {
  const mod = await import('./theme');
  THEME = mod.THEME;
  NAV_THEME = mod.NAV_THEME;
  withAlpha = mod.withAlpha;
  toHexColor = mod.toHexColor;
  MOTION = mod.MOTION;
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
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    // --sidebar-border differs between light (0 0% 88.6%) and dark
    // (0 0% 10.2%); if the parser bled into the dark block the light
    // block would contain the dark value instead of its own.
    expect(lightBlock).toContain('--sidebar-border: 0 0% 88.6%');
    expect(lightBlock).not.toContain('--sidebar-border: 0 0% 10.2%');
  });

  it('dark block does not include :root (light) declarations', () => {
    const darkBlock = extractBlock('.dark:root');
    expect(darkBlock).toContain('--sidebar-border: 0 0% 10.2%');
    expect(darkBlock).not.toContain('--sidebar-border: 0 0% 88.6%');
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
      chromeBackground: 'chrome-background',
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
      chromeBackground: 'chrome-background',
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

/**
 * `toHexColor` feeds native renderers that only read hex (`@expo/ui` SwiftUI
 * modifiers). It must produce the SAME colour the real React Native parser
 * produces for the hsl token — checked channel by channel against
 * `normalizeColor`, allowing ±1 for rounding.
 */
describe('toHexColor matches the real parser for every THEME colour', () => {
  const channels = (int: number) => [(int >>> 24) & 255, (int >>> 16) & 255, (int >>> 8) & 255];
  const plainHsl = /^hsl\(\s*[\d.]+\s+[\d.]+%\s+[\d.]+%\s*\)$/;

  it('converts known values exactly', () => {
    expect(toHexColor('hsl(0 0% 96.1%)')).toBe('#f5f5f5');
    expect(toHexColor('hsl(0 0% 14.9%)')).toBe('#262626');
    expect(toHexColor('hsl(0 100% 50%)')).toBe('#ff0000');
    expect(toHexColor('hsl(120 100% 25%)')).toBe('#008000');
  });

  it('agrees with normalizeColor on every plain-hsl token (±1 per channel)', () => {
    const mismatched: string[] = [];
    const scopes = [THEME.light, THEME.dark, THEME.accent] as Record<string, string>[];
    for (const scope of scopes) {
      for (const [name, value] of Object.entries(scope)) {
        if (typeof value !== 'string' || !plainHsl.test(value)) continue;
        const expected = channels(normalizeColor(value) as number);
        const actual = channels(normalizeColor(toHexColor(value)) as number);
        if (expected.some((c, i) => Math.abs(c - actual[i]) > 1)) {
          mismatched.push(`${name} = ${value} → ${toHexColor(value)}`);
        }
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('throws on input that is not a THEME hsl string', () => {
    expect(() => toHexColor('#ff0000')).toThrow();
    expect(() => toHexColor('hsla(0, 0%, 50%, 1)')).toThrow();
  });

  it('appends an alpha byte (#rrggbbaa) when alpha is given', () => {
    expect(toHexColor('hsl(0 0% 11%)', 0.3)).toBe('#1c1c1c4d');
    expect(toHexColor('hsl(0 100% 50%)', 1)).toBe('#ff0000ff');
    expect(toHexColor('hsl(0 100% 50%)', 0)).toBe('#ff000000');
  });

  it('matches withAlpha under normalizeColor for every plain-hsl token (±1 per channel)', () => {
    const rgba = (int: number) => [...channels(int), int & 255];
    const mismatched: string[] = [];
    const scopes = [THEME.light, THEME.dark, THEME.accent] as Record<string, string>[];
    for (const scope of scopes) {
      for (const [name, value] of Object.entries(scope)) {
        if (typeof value !== 'string' || !plainHsl.test(value)) continue;
        const expected = rgba(normalizeColor(withAlpha(value, 0.3)) as number);
        const actual = rgba(normalizeColor(toHexColor(value, 0.3)) as number);
        if (expected.some((c, i) => Math.abs(c - actual[i]) > 1)) {
          mismatched.push(`${name} = ${value} → ${toHexColor(value, 0.3)}`);
        }
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('throws on alpha outside 0–1', () => {
    expect(() => toHexColor('hsl(0 0% 50%)', -0.1)).toThrow();
    expect(() => toHexColor('hsl(0 0% 50%)', 1.1)).toThrow();
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Web parity: global.css ↔ apps/web/src/app/globals.css
 *
 * Everything above pins THEME to global.css. Nothing pinned global.css to web,
 * so the mobile palette drifted from web for months with every test green.
 * This block reads web's globals.css at runtime, converts each oklch / hex /
 * rgb value to HSL, and requires the mobile transcription to agree within
 * HSL_TOLERANCE in every component.
 * ──────────────────────────────────────────────────────────────────────────── */

const WEB_CSS_PATH = join(__dirname, '../../../web/src/app/globals.css');
const webCss = readFileSync(WEB_CSS_PATH, 'utf8');

/** Max allowed difference per HSL component (degrees for H, points for S/L). */
const HSL_TOLERANCE = 0.2;

type Hsla = { h: number; s: number; l: number; a: number };

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Collect `--name: value;` declarations from every block whose selector is
 * exactly `selector` (at the start of a line, followed by `{`), merged in
 * source order so a later declaration wins — the CSS cascade for same-
 * specificity rules. web declares `--sidebar-*` twice (a legacy hsl block at
 * the top of the file and the oklch block later); the later one must win.
 */
function webDeclarations(selector: ':root' | '.dark'): Map<string, string> {
  const css = stripComments(webCss);
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const selectorRegex = new RegExp(`(^|\\n)[ \\t]*${escaped}[ \\t]*\\{`, 'g');
  const out = new Map<string, string>();
  for (let m = selectorRegex.exec(css); m; m = selectorRegex.exec(css)) {
    const open = css.indexOf('{', m.index);
    const close = css.indexOf('}', open);
    const body = css.slice(open + 1, close);
    for (const d of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      out.set(d[1], d[2].trim());
    }
  }
  return out;
}

const webRoot = webDeclarations(':root');
// `.dark` sits on the same element as `:root`, so every token `.dark` does not
// re-declare (e.g. `--terminal-*`) inherits the `:root` value.
const webDark = new Map([...webRoot, ...webDeclarations('.dark')]);

/**
 * Resolve `var(--x)` chains. `var(--color-x)` is a Tailwind `@theme inline`
 * alias (`--color-ring: var(--ring)`); follow the alias declared in web's
 * globals.css.
 */
function resolveWeb(scope: Map<string, string>, name: string, depth = 0): string {
  if (depth > 8) throw new Error(`var() cycle resolving --${name}`);
  let raw = scope.get(name);
  if (raw === undefined) {
    const alias = stripComments(webCss).match(
      new RegExp(`--${name}:\\s*var\\(--([a-z0-9-]+)\\)`)
    );
    if (!alias) throw new Error(`web token --${name} not found`);
    raw = `var(--${alias[1]})`;
  }
  const ref = raw.match(/^var\(--([a-z0-9-]+)\)$/);
  return ref ? resolveWeb(scope, ref[1], depth + 1) : raw;
}

function srgbToHsla(r: number, g: number, b: number, a: number): Hsla {
  const clip = (v: number) => Math.min(1, Math.max(0, v));
  const [R, G, B] = [clip(r), clip(g), clip(b)];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d > 1e-9) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: s * 100, l: l * 100, a };
}

/**
 * CSS Color 4 oklch → sRGB (Björn Ottosson's OKLab matrices), clipped to the
 * sRGB gamut. Out-of-gamut values clip per channel, which is what an sRGB
 * display renders.
 */
function oklchToHsla(L: number, C: number, H: number, a: number): Hsla {
  const hr = (H * Math.PI) / 180;
  const A = C * Math.cos(hr);
  const B = C * Math.sin(hr);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const gamma = (v: number) =>
    v <= 0.0031308 ? 12.92 * v : 1.055 * Math.sign(v) * Math.abs(v) ** (1 / 2.4) - 0.055;
  return srgbToHsla(
    gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a
  );
}

/** Parse a web CSS color: oklch(), #rrggbb, rgb(), or hsl(). */
function parseWebColor(value: string): Hsla {
  const num = (v: string) => (v.endsWith('%') ? Number(v.slice(0, -1)) / 100 : Number(v));
  let m = value.match(/^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+))?\s*\)$/);
  if (m) return oklchToHsla(num(m[1]), Number(m[2]), Number(m[3]), m[4] ? Number(m[4]) : 1);
  m = value.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (m) return srgbToHsla(...(m.slice(1, 4).map((x) => parseInt(x, 16) / 255) as [number, number, number]), 1);
  m = value.match(/^rgb\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+))?\s*\)$/);
  if (m) return srgbToHsla(Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255, m[4] ? Number(m[4]) : 1);
  m = value.match(/^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/);
  if (m) return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]), a: 1 };
  throw new Error(`unparseable web color: ${value}`);
}

/** Parse a mobile global.css value: `H S% L%` or `H S% L% / A`. */
function parseMobileColor(value: string): Hsla {
  const m = value.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*(?:\/\s*([\d.]+))?$/);
  if (!m) throw new Error(`unparseable mobile color: ${value}`);
  return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]), a: m[4] ? Number(m[4]) : 1 };
}

const fmt = (n: number) => String(Number(n.toFixed(1)));
const fmtHsla = (c: Hsla) =>
  `${c.s < 0.05 ? 0 : fmt(c.h)} ${fmt(c.s)}% ${fmt(c.l)}%${c.a === 1 ? '' : ` / ${c.a}`}`;

/** Hue is compared only for chromatic colors: an achromatic hue is meaningless. */
function hslaDrift(mobile: Hsla, web: Hsla): string | null {
  const hueDiff = Math.min(Math.abs(mobile.h - web.h), 360 - Math.abs(mobile.h - web.h));
  const chromatic = web.s >= 1 || mobile.s >= 1;
  const bad =
    (chromatic && hueDiff > HSL_TOLERANCE) ||
    Math.abs(mobile.s - web.s) > HSL_TOLERANCE ||
    Math.abs(mobile.l - web.l) > HSL_TOLERANCE ||
    Math.abs(mobile.a - web.a) > 0.001;
  return bad ? fmtHsla(web) : null;
}

/**
 * Mobile token → web token. Same name unless listed otherwise.
 *
 *   mobile              web
 *   chrome-background   sidebar  (mobile's name for the drawer/nav surface)
 *   kortix-base         kortix-base = var(--color-ring) = var(--ring)
 *
 * Deliberately NOT in the set:
 *   border-width        a length, mobile-only (hairline stroke)
 *   radius              a length; compared separately below
 *   success / warning   web has no CSS variable; compared against the
 *                       Tailwind palette classes status.tsx uses (below)
 */
const WEB_PARITY_TOKENS: Record<string, string> = {
  background: 'background',
  foreground: 'foreground',
  card: 'card',
  'card-foreground': 'card-foreground',
  popover: 'popover',
  'popover-foreground': 'popover-foreground',
  primary: 'primary',
  'primary-foreground': 'primary-foreground',
  secondary: 'secondary',
  'secondary-foreground': 'secondary-foreground',
  muted: 'muted',
  'muted-foreground': 'muted-foreground',
  accent: 'accent',
  'accent-foreground': 'accent-foreground',
  destructive: 'destructive',
  'destructive-foreground': 'destructive-foreground',
  border: 'border',
  input: 'input',
  ring: 'ring',
  'chart-1': 'chart-1',
  'chart-2': 'chart-2',
  'chart-3': 'chart-3',
  'chart-4': 'chart-4',
  'chart-5': 'chart-5',
  sidebar: 'sidebar',
  'sidebar-foreground': 'sidebar-foreground',
  'sidebar-primary': 'sidebar-primary',
  'sidebar-primary-foreground': 'sidebar-primary-foreground',
  'sidebar-accent': 'sidebar-accent',
  'sidebar-accent-foreground': 'sidebar-accent-foreground',
  'sidebar-border': 'sidebar-border',
  'sidebar-ring': 'sidebar-ring',
  'chrome-background': 'sidebar',
  'kortix-base': 'kortix-base',
  'kortix-blue': 'kortix-blue',
  'kortix-yellow': 'kortix-yellow',
  'kortix-orange': 'kortix-orange',
  'kortix-green': 'kortix-green',
  'kortix-purple': 'kortix-purple',
  'kortix-red': 'kortix-red',
  pane: 'pane',
  surface: 'surface',
  hover: 'hover',
  active: 'active',
  'focus-ring': 'focus-ring',
  'foreground-strong': 'foreground-strong',
  'foreground-weak': 'foreground-weak',
  'terminal-surface': 'terminal-surface',
  'terminal-fg': 'terminal-fg',
  'terminal-border': 'terminal-border',
};

/**
 * web's status palette is not a CSS variable: status.tsx STATUS_TEXT uses
 * Tailwind classes (`text-emerald-600 dark:text-emerald-400`). Tailwind 4
 * resolves those from `tailwindcss/theme.css`. The oklch values are pinned
 * here (tailwindcss 4.3.3) so this test does not depend on web's
 * node_modules; a separate test re-reads theme.css when it is installed.
 */
const TAILWIND_PALETTE: Record<string, string> = {
  'emerald-400': 'oklch(76.5% 0.177 163.223)',
  'emerald-600': 'oklch(59.6% 0.145 163.225)',
  'amber-400': 'oklch(82.8% 0.189 84.429)',
  'amber-600': 'oklch(66.6% 0.179 58.318)',
};
const STATUS_TSX_PATH = join(__dirname, '../../../web/src/components/ui/status.tsx');
const TAILWIND_THEME_PATH = join(__dirname, '../../../web/node_modules/tailwindcss/theme.css');

/** Read `tone: 'text-<light> dark:text-<dark>'` from web's STATUS_TEXT. */
function webStatusShades(tone: 'success' | 'warning'): { light: string; dark: string } {
  const src = readFileSync(STATUS_TSX_PATH, 'utf8');
  const m = src.match(
    new RegExp(`${tone}:\\s*'text-([a-z]+-\\d+)\\s+dark:text-([a-z]+-\\d+)'`)
  );
  if (!m) throw new Error(`status.tsx STATUS_TEXT.${tone} not in 'text-X dark:text-Y' form`);
  return { light: m[1], dark: m[2] };
}

function paletteColor(shade: string): Hsla {
  const value = TAILWIND_PALETTE[shade];
  if (!value) throw new Error(`Tailwind shade ${shade} not pinned in TAILWIND_PALETTE`);
  return parseWebColor(value);
}

describe('color conversion helpers are correct', () => {
  it('converts known oklch values to the sRGB hex they render as', () => {
    // oklch(0.669 0.1837 248.8066) is web's accent-blue, commented #0099ff.
    expect(toHexColor(`hsl(${fmtHsla(parseWebColor('oklch(0.669 0.1837 248.8066)'))})`)).toBe(
      '#0099ff'
    );
    expect(toHexColor(`hsl(${fmtHsla(parseWebColor('oklch(15% 0 0)'))})`)).toBe('#0b0b0b');
    expect(toHexColor(`hsl(${fmtHsla(parseWebColor('oklch(0.1913 0 0)'))})`)).toBe('#141414');
    expect(toHexColor(`hsl(${fmtHsla(parseWebColor('oklch(1 0 0)'))})`)).toBe('#ffffff');
    expect(toHexColor(`hsl(${fmtHsla(parseWebColor('#0f0f0f'))})`)).toBe('#0f0f0f');
  });

  it('the later web --sidebar block wins over the legacy hsl block', () => {
    expect(webRoot.get('sidebar')).toBe('oklch(0.9672 0 0)');
    expect(webDark.get('sidebar-border')).toBe('oklch(0.2178 0 0)');
  });

  it('resolves web --kortix-base through the @theme alias to --ring', () => {
    expect(resolveWeb(webRoot, 'kortix-base')).toBe(resolveWeb(webRoot, 'ring'));
  });
});

describe('global.css matches apps/web globals.css', () => {
  for (const [scope, mobileScope, web] of [
    ['light', ':root', webRoot],
    ['dark', '.dark:root', webDark],
  ] as const) {
    it(`every shared ${scope} token matches web within ±${HSL_TOLERANCE}`, () => {
      const drift: string[] = [];
      for (const [mobileName, webName] of Object.entries(WEB_PARITY_TOKENS)) {
        const mobileValue = resolveTokenValue(mobileScope, mobileName);
        const webValue = resolveWeb(web, webName);
        const expected = hslaDrift(parseMobileColor(mobileValue), parseWebColor(webValue));
        if (expected) {
          drift.push(`--${mobileName}: ${mobileValue} → ${expected}  /* web ${webValue} */`);
        }
      }
      expect(drift).toEqual([]);
    });
  }

  it('--radius matches web', () => {
    expect(rawTokenValue(':root', 'radius')).toBe(resolveWeb(webRoot, 'radius'));
    expect(rawTokenValue('.dark:root', 'radius')).toBe(resolveWeb(webDark, 'radius'));
  });

  it('--success / --warning match the Tailwind shades web status.tsx uses', () => {
    const drift: string[] = [];
    for (const tone of ['success', 'warning'] as const) {
      const shades = webStatusShades(tone);
      for (const [mobileScope, shade] of [
        [':root', shades.light],
        ['.dark:root', shades.dark],
      ] as const) {
        let mobileValue: string;
        try {
          mobileValue = resolveTokenValue(mobileScope, tone);
        } catch {
          drift.push(`--${tone} missing in ${mobileScope} → ${fmtHsla(paletteColor(shade))}`);
          continue;
        }
        const expected = hslaDrift(parseMobileColor(mobileValue), paletteColor(shade));
        if (expected) drift.push(`--${tone} (${mobileScope}): ${mobileValue} → ${expected}`);
      }
    }
    expect(drift).toEqual([]);
  });

  it.skipIf(!existsSync(TAILWIND_THEME_PATH))(
    'pinned TAILWIND_PALETTE equals the installed tailwindcss/theme.css',
    () => {
      const themeCss = readFileSync(TAILWIND_THEME_PATH, 'utf8');
      for (const [shade, value] of Object.entries(TAILWIND_PALETTE)) {
        expect(themeCss).toContain(`--color-${shade}: ${value};`);
      }
    }
  );
});

describe('THEME carries the web-parity tokens', () => {
  const keyToToken: Record<string, string> = {
    destructiveForeground: 'destructive-foreground',
    sidebar: 'sidebar',
    sidebarForeground: 'sidebar-foreground',
    sidebarPrimary: 'sidebar-primary',
    sidebarPrimaryForeground: 'sidebar-primary-foreground',
    sidebarAccent: 'sidebar-accent',
    sidebarAccentForeground: 'sidebar-accent-foreground',
    sidebarBorder: 'sidebar-border',
    sidebarRing: 'sidebar-ring',
    success: 'success',
    warning: 'warning',
  };
  for (const [scope, mobileScope] of [
    ['light', ':root'],
    ['dark', '.dark:root'],
  ] as const) {
    it(`${scope}: every key matches its global.css token`, () => {
      const missing: string[] = [];
      for (const [themeKey, cssName] of Object.entries(keyToToken)) {
        const value = (THEME[scope] as Record<string, string>)[themeKey];
        if (value === undefined) {
          missing.push(themeKey);
          continue;
        }
        sameColor(value, token(mobileScope, cssName));
      }
      expect(missing).toEqual([]);
    });
  }
});

/**
 * React Native cannot read CSS variables for animation timing, so MOTION
 * transcribes web's `--duration-*` / `--ease-*` tokens as numbers.
 */
describe('MOTION matches web motion tokens', () => {
  it('durations equal web --duration-* in ms', () => {
    for (const [key, cssName] of [
      ['fast', 'duration-fast'],
      ['normal', 'duration-normal'],
      ['moderate', 'duration-moderate'],
      ['slow', 'duration-slow'],
      ['slower', 'duration-slower'],
    ] as const) {
      expect(`${key}=${MOTION.duration[key]}ms`).toBe(`${key}=${resolveWeb(webRoot, cssName)}`);
    }
  });

  it('easings equal web --ease-* cubic-bezier control points', () => {
    for (const [key, cssName] of [
      ['default', 'ease-default'],
      ['in', 'ease-in'],
      ['out', 'ease-out'],
      ['inOut', 'ease-in-out'],
    ] as const) {
      const m = resolveWeb(webRoot, cssName).match(/^cubic-bezier\(([^)]+)\)$/);
      if (!m) throw new Error(`--${cssName} is not a cubic-bezier`);
      expect([...MOTION.easing[key]] as number[]).toEqual(m[1].split(',').map((n) => Number(n.trim())));
    }
  });
});

describe('tailwind.config.js colors resolve to declared global.css tokens', () => {
  it('every hsl(var(--x)) in theme.extend.colors is declared in :root and .dark:root', () => {
    const config = readFileSync(join(__dirname, '../../tailwind.config.js'), 'utf8');
    const referenced = [...config.matchAll(/hsl\(var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]);
    expect(referenced).toContain('success');
    expect(referenced).toContain('sidebar-border');
    const missing: string[] = [];
    for (const name of new Set(referenced)) {
      for (const scope of [':root', '.dark:root'] as const) {
        try {
          resolveTokenValue(scope, name);
        } catch {
          missing.push(`--${name} in ${scope}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
