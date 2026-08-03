/**
 * The Pierre palette: Pierre Dark / Pierre Light, shared by `@pierre/diffs`
 * (which uses the same names internally), the CodeMirror theme in
 * `lib/codemirror-pierre-theme.ts`, and — through `PIERRE_THEME` in
 * `components/markdown/code` — the easy-panel file viewer, so panes that sit
 * side by side agree. Markdown code uses its own pair and does not come here.
 *
 * These are TextMate-style JSON objects; Shiki keys them by their `.name`,
 * so a call site passes the object to load it and the name to reference it.
 */
import pierreDark from '@pierre/theme/pierre-dark';
import pierreLight from '@pierre/theme/pierre-light';

// Each theme object includes its own `name`, which Shiki uses as the key.
// Re-export the names so call sites can either pass the JSON (to load) or
// the name (to reference an already-loaded theme).
export const SHIKI_THEME_DARK_NAME = pierreDark.name;
export const SHIKI_THEME_LIGHT_NAME = pierreLight.name;

export const SHIKI_THEMES = {
  dark: pierreDark,
  light: pierreLight,
} as const;

/** Resolve the Shiki theme name to use for the current next-themes value. */
export function resolveShikiThemeName(resolvedTheme: string | undefined): string {
  return resolvedTheme === 'dark' ? SHIKI_THEME_DARK_NAME : SHIKI_THEME_LIGHT_NAME;
}
