import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  DARK_THEME_IDS,
  DEFAULT_THEME_CHOICE,
  INTERFACE_THEME_IDS,
  INTERFACE_THEME_INIT_SCRIPT,
  KORTIX_DARK_THEME_IDS,
  KORTIX_LIGHT_THEME_IDS,
  LIGHT_THEME_IDS,
  TERMINAL_THEMES,
  applyInterfaceThemes,
  clearInterfaceThemes,
  interfaceThemeFor,
  isThemedPath,
  isThemedSurface,
  normalizeDarkTheme,
  normalizeLightTheme,
  resolveInterfaceTheme,
  syncInterfaceThemes,
  type TerminalTheme,
  type ThemeChoice,
} from './interface-themes';

const TERMINAL_LIGHT_COUNT = 14;
const TERMINAL_DARK_COUNT = 26;
const TERMINAL_TOTAL = TERMINAL_LIGHT_COUNT + TERMINAL_DARK_COUNT;
const EXPECTED_TOKEN_COUNT = 39;

const generatedCss = readFileSync(
  join(import.meta.dir, '../app/kortix-themes.generated.css'),
  'utf8',
);

/** The exact selector block a generated terminal theme must produce. */
function selectorFor(theme: TerminalTheme): string {
  return theme.mode === 'light'
    ? `:root:not(.dark)[data-light-theme='${theme.id}'],\n[data-theme-preview='${theme.id}'] {`
    : `:root.dark[data-dark-theme='${theme.id}'],\n[data-theme-preview='${theme.id}'] {`;
}

/** Extracts the single declaration block that follows a theme's selector. */
function blockFor(theme: TerminalTheme): string {
  const selector = selectorFor(theme);
  const occurrences = generatedCss.split(selector).length - 1;
  expect(occurrences).toBe(1);
  const start = generatedCss.indexOf(selector) + selector.length;
  const end = generatedCss.indexOf('}', start);
  expect(end).toBeGreaterThan(start);
  return generatedCss.slice(start, end);
}

describe('terminal theme catalog', () => {
  test('has 14 light and 26 dark curated themes', () => {
    expect(TERMINAL_THEMES).toHaveLength(TERMINAL_TOTAL);
    expect(TERMINAL_THEMES.filter((t) => t.mode === 'light')).toHaveLength(TERMINAL_LIGHT_COUNT);
    expect(TERMINAL_THEMES.filter((t) => t.mode === 'dark')).toHaveLength(TERMINAL_DARK_COUNT);
  });

  test('every id is unique', () => {
    const ids = TERMINAL_THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every theme has exactly one CSS block, correctly scoped, with 39 tokens', () => {
    for (const theme of TERMINAL_THEMES) {
      const block = blockFor(theme);
      const declarations = block.match(/^\s*--[\w-]+:/gm) ?? [];
      expect(declarations).toHaveLength(EXPECTED_TOKEN_COUNT);
      expect(block).toContain(`color-scheme: ${theme.mode};`);
    }
  });

  test("every block's --background matches the JSON background", () => {
    for (const theme of TERMINAL_THEMES) {
      const block = blockFor(theme);
      const match = block.match(/--background:\s*([^;]+);/);
      expect(match?.[1]).toBe(theme.background);
    }
  });
});

describe('interface theme model', () => {
  test('counts: 2 + 32 light, 2 + 80 dark, 1 + 116 total', () => {
    expect(LIGHT_THEME_IDS).toHaveLength(2 + TERMINAL_LIGHT_COUNT);
    expect(DARK_THEME_IDS).toHaveLength(2 + TERMINAL_DARK_COUNT);
    expect(INTERFACE_THEME_IDS).toHaveLength(1 + 2 + 2 + TERMINAL_TOTAL);
  });

  test('the Kortix ids come first, in order, on each side', () => {
    expect(LIGHT_THEME_IDS.slice(0, 2)).toEqual([...KORTIX_LIGHT_THEME_IDS]);
    expect(DARK_THEME_IDS.slice(0, 2)).toEqual([...KORTIX_DARK_THEME_IDS]);
    expect(INTERFACE_THEME_IDS[0]).toBe('system');
    expect(INTERFACE_THEME_IDS.slice(1, 3)).toEqual([...KORTIX_LIGHT_THEME_IDS]);
    const darkStart = 1 + LIGHT_THEME_IDS.length;
    expect(INTERFACE_THEME_IDS.slice(darkStart, darkStart + 2)).toEqual([...KORTIX_DARK_THEME_IDS]);
  });

  test('every id is unique across the whole picker', () => {
    expect(new Set(INTERFACE_THEME_IDS).size).toBe(INTERFACE_THEME_IDS.length);
  });

  test('with nothing chosen, System resolves to Pure light and Pure dark', () => {
    expect(DEFAULT_THEME_CHOICE).toEqual({ light: 'pure-light', dark: 'pure-dark' });
  });

  test('every picker row round-trips through mode + palette', () => {
    for (const id of INTERFACE_THEME_IDS) {
      const next = resolveInterfaceTheme(id);
      const choice: ThemeChoice = { ...DEFAULT_THEME_CHOICE };
      if (next.mode === 'light') choice.light = next.light;
      if (next.mode === 'dark') choice.dark = next.dark;
      expect(interfaceThemeFor(next.mode, choice)).toBe(id);
    }
  });

  test('a sample of terminal ids round-trips too', () => {
    const sample = [
      TERMINAL_THEMES.find((t) => t.id === 'gruvbox-light')!,
      TERMINAL_THEMES.find((t) => t.id === 'iceberg-light')!,
      TERMINAL_THEMES.find((t) => t.id === 'tokyo-night-storm')!,
      TERMINAL_THEMES.find((t) => t.id === 'dracula-default')!,
      TERMINAL_THEMES.find((t) => t.id === 'jellybeans-default')!,
    ];
    for (const theme of sample) {
      expect(resolveInterfaceTheme(theme.id) as unknown).toEqual({
        mode: theme.mode,
        [theme.mode]: theme.id,
      });
      const choice: ThemeChoice = { ...DEFAULT_THEME_CHOICE, [theme.mode]: theme.id };
      expect(interfaceThemeFor(theme.mode, choice)).toBe(theme.id);
    }
  });

  test('System changes only the mode, so both chosen palettes survive it', () => {
    expect(resolveInterfaceTheme('system')).toEqual({ mode: 'system' });
    const choice: ThemeChoice = { light: 'light', dark: 'dark' };
    expect(interfaceThemeFor('system', choice)).toBe('system');
    expect(interfaceThemeFor('dark', choice)).toBe('dark');
    expect(interfaceThemeFor('light', choice)).toBe('light');
  });

  test('an unknown or missing mode selects System', () => {
    expect(interfaceThemeFor(undefined, DEFAULT_THEME_CHOICE)).toBe('system');
    expect(interfaceThemeFor('sepia', DEFAULT_THEME_CHOICE)).toBe('system');
  });

  test('legacy or unknown stored palettes read as the defaults', () => {
    expect(normalizeLightTheme(undefined)).toBe('pure-light');
    expect(normalizeLightTheme('soft')).toBe('pure-light');
    expect(normalizeLightTheme('dark')).toBe('pure-light');
    expect(normalizeLightTheme('light')).toBe('light');
    expect(normalizeDarkTheme('pure')).toBe('pure-dark');
    expect(normalizeDarkTheme('light')).toBe('pure-dark');
    expect(normalizeDarkTheme('dark')).toBe('dark');
    // The pre-generated `jellybean` id now aliases to its terminal-theme id.
    expect(normalizeDarkTheme('jellybean')).toBe('jellybeans-default');
    expect(normalizeDarkTheme('iceberg-dark')).toBe('iceberg-dark');
    expect(normalizeLightTheme('iceberg-light')).toBe('iceberg-light');
    // A light palette is never a dark one, and vice versa.
    expect(normalizeDarkTheme('iceberg-light')).toBe('pure-dark');
    expect(normalizeDarkTheme('dark-blue')).toBe('pure-dark');
    // Palettes that were removed, or never existed, read as the default.
    expect(normalizeLightTheme('light-blue')).toBe('pure-light');
    expect(normalizeDarkTheme('midnight')).toBe('pure-dark');
    expect(normalizeDarkTheme('graphite-blue')).toBe('pure-dark');
  });
});

/** Runs the inline `<head>` script against a fake document and storage. */
function runInitScript(
  stored: string | null,
  throwOnRead = false,
  pathname = '/projects',
): Record<string, string> {
  const attributes: Record<string, string> = {};
  const document = {
    documentElement: {
      setAttribute: (name: string, value: string) => {
        attributes[name] = value;
      },
    },
  };
  const localStorage = {
    getItem: () => {
      if (throwOnRead) throw new Error('SecurityError');
      return stored;
    },
  };
  new Function('document', 'localStorage', 'location', INTERFACE_THEME_INIT_SCRIPT)(
    document,
    localStorage,
    { pathname },
  );
  return attributes;
}

const blob = (preferences: Record<string, unknown>) =>
  JSON.stringify({ state: { preferences }, version: 0 });

describe('INTERFACE_THEME_INIT_SCRIPT', () => {
  test('applies the persisted Kortix palettes before first paint', () => {
    expect(runInitScript(blob({ lightTheme: 'light', darkTheme: 'dark' }))).toEqual({
      'data-light-theme': 'light',
      'data-dark-theme': 'dark',
    });
  });

  test('applies a persisted terminal theme id before first paint', () => {
    expect(
      runInitScript(blob({ lightTheme: 'gruvbox-light', darkTheme: 'dracula-default' })),
    ).toEqual({
      'data-light-theme': 'gruvbox-light',
      'data-dark-theme': 'dracula-default',
    });
  });

  test('a first visit, a legacy blob or an unknown id gets the defaults', () => {
    const defaults = { 'data-light-theme': 'pure-light', 'data-dark-theme': 'pure-dark' };
    expect(runInitScript(null)).toEqual(defaults);
    expect(runInitScript(blob({ lightTone: 'soft', darkTone: 'soft' }))).toEqual(defaults);
    expect(runInitScript(blob({ lightTheme: 'dark', darkTheme: 'neon' }))).toEqual(defaults);
    expect(runInitScript(blob({ lightTheme: 'light-blue', darkTheme: 'graphite' }))).toEqual(
      defaults,
    );
  });

  test('themes only /new, /projects/** and /settings, before first paint', () => {
    const stored = blob({ lightTheme: 'light', darkTheme: 'dracula-default' });
    const themed = { 'data-light-theme': 'light', 'data-dark-theme': 'dracula-default' };
    for (const path of ['/new', '/projects', '/projects/p1/sessions/s1', '/settings/appearance']) {
      expect(runInitScript(stored, false, path)).toEqual(themed);
    }
    for (const path of [
      '/',
      '/auth',
      '/pricing',
      '/checkout',
      '/invites/x',
      '/newsroom',
      '/projectsx',
    ]) {
      expect(runInitScript(stored, false, path)).toEqual({});
    }
  });

  test('blocked storage or bad JSON never throws', () => {
    expect(() => runInitScript(null, true)).not.toThrow();
    expect(() => runInitScript('{not json')).not.toThrow();
  });
});

describe('applyInterfaceThemes', () => {
  test('writes both attributes', () => {
    const attributes: Record<string, string> = {};
    applyInterfaceThemes(
      { setAttribute: (n: string, v: string) => void (attributes[n] = v) } as unknown as Element,
      { light: 'light', dark: 'pure-dark' },
    );
    expect(attributes).toEqual({ 'data-light-theme': 'light', 'data-dark-theme': 'pure-dark' });
  });
});

/** A minimal attribute bag standing in for `<html>`. */
function fakeRoot(initial: Record<string, string> = {}) {
  const attrs = new Map(Object.entries(initial));
  return {
    attrs,
    element: {
      getAttribute: (n: string) => attrs.get(n) ?? null,
      hasAttribute: (n: string) => attrs.has(n),
      setAttribute: (n: string, v: string) => void attrs.set(n, v),
      removeAttribute: (n: string) => void attrs.delete(n),
    } as unknown as Element,
  };
}

describe('themed surface', () => {
  test('clearing drops both palette attributes and leaves the rest', () => {
    const { attrs, element } = fakeRoot({
      class: 'dark',
      'data-light-theme': 'iceberg-light',
      'data-dark-theme': 'dracula-default',
    });
    expect(isThemedSurface(element)).toBe(true);
    clearInterfaceThemes(element);
    expect(isThemedSurface(element)).toBe(false);
    expect(Object.fromEntries(attrs)).toEqual({ class: 'dark' });
  });

  const globalsCss = readFileSync(join(import.meta.dir, '../app/globals.css'), 'utf8');
  const themeSection = globalsCss.slice(globalsCss.indexOf(' * Interface themes'));

  // An unthemed page (auth, marketing, checkout, …) has no palette attribute,
  // so it must not match any palette block: each `:root` selector needs one.
  test('every palette block on <html> requires a palette attribute', () => {
    const rootSelectors = [
      ...themeSection.matchAll(/^(:root[^,{\n]*)[,{]/gm),
      ...generatedCss.matchAll(/^(:root[^,{\n]*)[,{]/gm),
    ].map((m) => m[1].trim());
    expect(rootSelectors.length).toBe(4 + TERMINAL_TOTAL);
    for (const selector of rootSelectors) {
      expect(selector).toMatch(/\[data-(light|dark)-theme='[a-z0-9-]+'\]/);
    }
  });

  test('unthemed pages keep the original inverted selection', () => {
    expect(globalsCss).toContain(
      'background: var(--selection, color-mix(in oklch, var(--primary) 72%, transparent));',
    );
  });

  test('the decision is the URL: themed routes in, everything else out', () => {
    for (const path of ['/new', '/projects', '/projects/p1', '/settings', '/de/projects/p1']) {
      expect(isThemedPath(path)).toBe(true);
    }
    for (const path of ['/', '/auth', '/pricing', '/checkout', '/connections', '/invites/x']) {
      expect(isThemedPath(path)).toBe(false);
    }
    expect(isThemedPath('/newsroom')).toBe(false);
    expect(isThemedPath(null)).toBe(false);
  });

  test('syncing themes a themed route and clears any other page', () => {
    const { attrs, element } = fakeRoot({ class: 'dark' });
    const choice = { light: 'iceberg-light', dark: 'dracula-default' };
    syncInterfaceThemes(element, '/projects/p1', choice);
    expect(Object.fromEntries(attrs)).toEqual({
      class: 'dark',
      'data-light-theme': 'iceberg-light',
      'data-dark-theme': 'dracula-default',
    });
    syncInterfaceThemes(element, '/auth', choice);
    expect(Object.fromEntries(attrs)).toEqual({ class: 'dark' });
  });

  // The (app) auth / MFA gate paints before any route layout mounts, so the
  // theme is decided at the root — never by a script or effect inside a route.
  test('the root layout carries the init script; no route layout does', () => {
    const app = join(import.meta.dir, '../app/[locale]');
    expect(readFileSync(join(app, 'layout.tsx'), 'utf8')).toContain('INTERFACE_THEME_INIT_SCRIPT');
    const glob = new Bun.Glob('**/layout.tsx');
    for (const file of glob.scanSync(app)) {
      if (file === 'layout.tsx') continue;
      expect(readFileSync(join(app, file), 'utf8')).not.toContain('INTERFACE_THEME_INIT_SCRIPT');
    }
  });
});
