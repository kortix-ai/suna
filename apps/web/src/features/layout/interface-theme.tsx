'use client';

/**
 * The interface theme picker's one option list, its swatch, and its hook.
 *
 * Three surfaces offer the same choice — the Appearance tab, the user menu's
 * Theme submenu and the command palette — and all three read this file, so a
 * person who learns the control in one place meets the same words, the same
 * swatches and the same order in the others.
 *
 * The model (mode in `next-themes`, palette per mode in the preferences store)
 * lives in `lib/interface-themes.ts`; the colours live in `globals.css`.
 */

import {
  applyInterfaceThemes,
  interfaceThemeFor,
  isThemedSurface,
  normalizeDarkTheme,
  normalizeLightTheme,
  resolveInterfaceTheme,
  TERMINAL_THEMES,
  type InterfaceThemeId,
  type ThemeChoice,
} from '@/lib/interface-themes';
import { cn } from '@kortix/ui';
import { useUserPreferencesStore } from '@kortix/ui/internal/stores/user-preferences-store';
import { useTheme } from 'next-themes';
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';

/** `settings.appearance.themes.<labelKey>`. */
export type InterfaceThemeLabel = 'system' | 'light' | 'pureLight' | 'dark' | 'pureDark';

/**
 * One row of the picker. `kind` is the discriminant a surface reads before
 * showing the row's name: a `'labelled'` row's name comes from the
 * `settings.appearance.themes.<labelKey>` catalog entry and must be
 * translated; a `'named'` row's name is a terminal theme's own proper noun
 * (`TerminalTheme.name`, e.g. "Catppuccin Mocha") and must NOT be — it is
 * shown verbatim in every locale.
 */
export type InterfaceThemeOption =
  | {
      value: InterfaceThemeId;
      kind: 'labelled';
      labelKey: InterfaceThemeLabel;
      group: 'system' | 'light' | 'dark';
    }
  | {
      value: InterfaceThemeId;
      kind: 'named';
      name: string;
      family: string;
      group: 'light' | 'dark';
    };

const KORTIX_LABELS: readonly {
  value: InterfaceThemeId;
  labelKey: InterfaceThemeLabel;
  group: 'light' | 'dark';
}[] = [
  { value: 'light', labelKey: 'light', group: 'light' },
  { value: 'pure-light', labelKey: 'pureLight', group: 'light' },
  { value: 'dark', labelKey: 'dark', group: 'dark' },
  { value: 'pure-dark', labelKey: 'pureDark', group: 'dark' },
];

/**
 * Picker rows in display order: System, then the four Kortix-designed
 * palettes, then one row per generated terminal theme
 * (`TERMINAL_THEMES`, `lib/kortix-themes.generated.json`) in that file's
 * own order — light and dark modes interleaved, grouped alphabetically by
 * family. A surface that wants light-only or dark-only rows filters on
 * `group`; `AppearanceTabView` does exactly that to build its three Select
 * groups.
 */
export const INTERFACE_THEME_OPTIONS: readonly InterfaceThemeOption[] = [
  { value: 'system', kind: 'labelled', labelKey: 'system', group: 'system' },
  ...KORTIX_LABELS.map(({ value, labelKey, group }): InterfaceThemeOption => ({
    value,
    kind: 'labelled',
    labelKey,
    group,
  })),
  ...TERMINAL_THEMES.map((theme): InterfaceThemeOption => ({
    value: theme.id,
    kind: 'named',
    name: theme.name,
    family: theme.family,
    group: theme.mode,
  })),
];

/** A type sample, not language — the same glyphs in every locale. */
const SAMPLE_GLYPH = 'Aa';

/**
 * A small "Aa" tile painted with the theme's own canvas, ink and hairline, plus
 * a dot in its CTA colour (black/white for mono themes, blue for blue ones).
 * The colours come from `[data-theme-preview]` scopes in globals.css, so the
 * swatch is the real palette, not a copy of it. System shows both sides it can
 * resolve to, at the palettes currently chosen.
 */
export function ThemeSwatch({
  value,
  choice,
  className,
}: {
  value: InterfaceThemeId;
  choice: ThemeChoice;
  className?: string;
}) {
  const frame = cn(
    'border-border inline-flex h-5 w-9 shrink-0 items-center justify-center overflow-hidden rounded-sm border text-xs font-medium',
    className,
  );

  if (value === 'system') {
    return (
      <span aria-hidden className={frame}>
        <span
          data-theme-preview={choice.light}
          className="bg-background text-foreground flex h-full flex-1 items-center justify-end"
        >
          {SAMPLE_GLYPH[0]}
        </span>
        <span
          data-theme-preview={choice.dark}
          className="bg-background text-foreground flex h-full flex-1 items-center justify-start"
        >
          {SAMPLE_GLYPH[1]}
        </span>
      </span>
    );
  }

  return (
    <span
      aria-hidden
      data-theme-preview={value}
      className={cn(frame, 'bg-background text-foreground gap-1')}
    >
      <span className="bg-primary size-1.5 shrink-0 rounded-full" />
      {SAMPLE_GLYPH}
    </span>
  );
}

/**
 * The picker's state: which row is selected and what choosing a row does.
 * Choosing a light or dark row writes the palette first, then the mode, so the
 * palette and the `.dark` class change in the same frame.
 */
export function useInterfaceTheme() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const light = useUserPreferencesStore((s) => normalizeLightTheme(s.preferences.lightTheme));
  const dark = useUserPreferencesStore((s) => normalizeDarkTheme(s.preferences.darkTheme));
  const setLightTheme = useUserPreferencesStore((s) => s.setLightTheme);
  const setDarkTheme = useUserPreferencesStore((s) => s.setDarkTheme);

  const choice = useMemo<ThemeChoice>(() => ({ light, dark }), [light, dark]);
  const selected = interfaceThemeFor(theme, choice);

  const select = useCallback(
    (id: InterfaceThemeId) => {
      const next = resolveInterfaceTheme(id);
      if (next.mode === 'light') setLightTheme(next.light);
      if (next.mode === 'dark') setDarkTheme(next.dark);
      setTheme(next.mode);
    },
    [setTheme, setLightTheme, setDarkTheme],
  );

  return { selected, select, choice, resolvedTheme };
}

/** What `<html>` looked like before the first preview frame. */
interface PreviewSnapshot {
  light: string | null;
  dark: string | null;
  mode: 'light' | 'dark' | null;
  colorScheme: string;
}

/**
 * A look-before-you-pick preview for a theme row. `preview(id)` paints `<html>`
 * with that row — mode class, `color-scheme` and, on a themed route, the
 * palette attribute — and writes nothing to the store or to next-themes.
 * `preview(null)` puts `<html>` back as it was. `commit()` drops the snapshot,
 * so the caller's `select(id)` lands on a page that already shows `id` and no
 * restore runs after it.
 */
export function useInterfaceThemePreview(choice: ThemeChoice) {
  const snapshot = useRef<PreviewSnapshot | null>(null);
  const choiceRef = useRef(choice);
  useLayoutEffect(() => {
    choiceRef.current = choice;
  });

  const preview = useCallback((id: InterfaceThemeId | null) => {
    const root = document.documentElement;
    if (id === null) {
      const saved = snapshot.current;
      if (!saved) return;
      snapshot.current = null;
      paintWithoutTransitions(() => {
        if (saved.light !== null) root.setAttribute('data-light-theme', saved.light);
        if (saved.dark !== null) root.setAttribute('data-dark-theme', saved.dark);
        root.classList.remove('light', 'dark');
        if (saved.mode) root.classList.add(saved.mode);
        root.style.colorScheme = saved.colorScheme;
      });
      return;
    }

    snapshot.current ??= {
      light: root.getAttribute('data-light-theme'),
      dark: root.getAttribute('data-dark-theme'),
      mode: root.classList.contains('dark')
        ? 'dark'
        : root.classList.contains('light')
          ? 'light'
          : null,
      colorScheme: root.style.colorScheme,
    };

    const next = resolveInterfaceTheme(id);
    const mode =
      next.mode === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : next.mode;
    paintWithoutTransitions(() => {
      // Off a themed route `<html>` carries no palette attributes on purpose
      // (`syncInterfaceThemes`); the preview keeps it that way.
      if (isThemedSurface(root)) {
        applyInterfaceThemes(root, {
          light: next.mode === 'light' ? next.light : choiceRef.current.light,
          dark: next.mode === 'dark' ? next.dark : choiceRef.current.dark,
        });
      }
      root.classList.remove('light', 'dark');
      root.classList.add(mode);
      root.style.colorScheme = mode;
    });
  }, []);

  const commit = useCallback(() => {
    snapshot.current = null;
  }, []);

  return { preview, commit };
}

/**
 * The same trick as next-themes' `disableTransitionOnChange`: arrowing through
 * forty themes must repaint at once, not fade every `transition-colors` node.
 */
function paintWithoutTransitions(paint: () => void) {
  const style = document.createElement('style');
  style.appendChild(document.createTextNode('*,*::before,*::after{transition:none!important}'));
  document.head.appendChild(style);
  paint();
  void window.getComputedStyle(document.body).opacity;
  setTimeout(() => style.remove(), 1);
}
