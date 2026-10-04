import {
  languageLabel as sharedLanguageLabel,
  normalizeLanguage as sharedNormalizeLanguage,
} from '@kortix/shared/code-language';

/**
 * The one syntax palette for every code surface in apps/mobile.
 *
 * Mirrors `apps/web/src/lib/code-theme.ts` (theme ids) and the language table
 * of `apps/web/src/components/markdown/code/shiki-highlighter.ts`
 * (`PRELOAD_LANGS`). Language aliases and captions live in @kortix/shared.
 * Theme values and bundled grammars remain host-owned.
 *
 * The language policy leaf is dependency-free, so tests and the highlighter
 * can read it without pulling React Native into the graph.
 *
 * It is the only file besides `global.css` allowed to hold hex values. The two
 * below are the Shiki themes' own base foreground, pinned against the theme
 * JSON by `lib/highlight/shiki.test.ts`.
 */
export const SHIKI_THEME_DARK = 'min-dark';
export const SHIKI_THEME_LIGHT = 'min-light';

/**
 * The only two themes any code surface may render. Widening this type is how a
 * second palette would get back in — don't.
 */
export type CodeThemeName = typeof SHIKI_THEME_DARK | typeof SHIKI_THEME_LIGHT;

export type CodeScheme = 'light' | 'dark';

export function codeThemeFor(scheme: CodeScheme): CodeThemeName {
  return scheme === 'dark' ? SHIKI_THEME_DARK : SHIKI_THEME_LIGHT;
}

/**
 * The colour a token without a theme rule paints in, and the colour of code
 * that is not highlighted yet (a fence still streaming, a grammar still
 * loading). Using the theme's base instead of `--foreground` means the text
 * does not change colour when the highlight lands on plain identifiers.
 */
export const CODE_THEME_FOREGROUND: Record<CodeScheme, string> = {
  light: '#24292eff', // hex-allowlist: min-light base fg, pinned by lib/highlight/shiki.test.ts
  dark: '#b392f0', // hex-allowlist: min-dark base fg, pinned by lib/highlight/shiki.test.ts
};

/**
 * Grammars bundled into the app — web's `PRELOAD_LANGS`, verbatim, minus the
 * two plain ids (`text`, `txt`) that need no grammar. Web lazy-loads any other
 * Shiki grammar on demand; mobile cannot fetch code at runtime, so a language
 * outside this list renders as plain text in the theme's base colour.
 */
export const HIGHLIGHT_LANGS = [
  // plain / config
  'json',
  'jsonc',
  'yaml',
  'toml',
  'ini',
  'dotenv',
  'xml',
  'diff',
  // web
  'html',
  'css',
  'scss',
  'less',
  'javascript',
  'typescript',
  'jsx',
  'tsx',
  'vue',
  'svelte',
  'astro',
  'markdown',
  'mdx',
  // backend / systems
  'python',
  'ruby',
  'go',
  'rust',
  'java',
  'kotlin',
  'swift',
  'c',
  'cpp',
  'csharp',
  'php',
  'sql',
  'lua',
  'r',
  'dart',
  'elixir',
  // shell / ops / data
  'bash',
  'powershell',
  'dockerfile',
  'nginx',
  'makefile',
  'hcl',
  'terraform',
  'graphql',
  'prisma',
  'proto',
  // diagrams
  'mermaid',
] as const;

export type HighlightLang = (typeof HIGHLIGHT_LANGS)[number];

/** Ids that render as plain text without a grammar. */
export const PLAIN_LANGS: ReadonlySet<string> = new Set(['text', 'txt', 'plain', 'plaintext', '']);

export { LANGUAGE_ALIASES } from '@kortix/shared/code-language';

/** Normalise a fenced-code language hint to a grammar id. */
export function normalizeLanguage(lang: string): string {
  return sharedNormalizeLanguage(lang.trim());
}

/** Is `lang` (already normalised) a grammar this app bundles? */
export function isHighlightLang(lang: string): lang is HighlightLang {
  return (HIGHLIGHT_LANGS as readonly string[]).includes(lang);
}

/** Display label for the code-block caption; an empty hint shows "text". */
export function languageLabel(language: string): string {
  if (!language) return 'text';
  const trimmed = language.trim();
  return trimmed ? sharedLanguageLabel(trimmed) : '';
}
