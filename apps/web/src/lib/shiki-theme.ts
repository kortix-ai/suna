/**
 * Single source of truth for the Shiki code-highlighting theme used across
 * the app — markdown code blocks, file viewers, diff renderers, thumbnails.
 *
 * Pierre Dark / Pierre Light pair with `@pierre/diffs` (which uses the same
 * names internally) so every code surface — markdown fences, file content,
 * diff hunks — renders with one consistent palette.
 *
 * Pierre's themes are TextMate-style JSON objects; Shiki accepts them
 * directly when passed to `getSingletonHighlighter({ themes: [...] })`.
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
