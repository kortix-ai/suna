/**
 * The one syntax palette for every code surface in apps/mobile.
 *
 * Mirrors `apps/web/src/lib/code-theme.ts` (theme ids) and the language table
 * of `apps/web/src/components/markdown/code/shiki-highlighter.ts`
 * (`PRELOAD_LANGS`) plus `unified-markdown-utils.ts` (`LANGUAGE_ALIASES`,
 * `languageLabel`). Change a value on web, change it here.
 *
 * This module has NO imports, on purpose: it is pure data plus two string
 * helpers, so tests and the highlighter can read it without pulling React
 * Native into the graph.
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

/**
 * Fenced-code hints that are not the id the highlighter loads. Every value is a
 * `HIGHLIGHT_LANGS` entry or `text` (pinned by the test). Copied from web's
 * `LANGUAGE_ALIASES`.
 */
export const LANGUAGE_ALIASES: Record<string, string> = {
  // web
  htm: 'html',
  js: 'javascript',
  node: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  sass: 'scss',
  svg: 'xml',
  // backend / systems
  py: 'python',
  py3: 'python',
  python3: 'python',
  rb: 'ruby',
  rs: 'rust',
  golang: 'go',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
  'c#': 'csharp',
  'c++': 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  ex: 'elixir',
  exs: 'elixir',
  // shell / ops
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  'shell-session': 'bash',
  ps1: 'powershell',
  pwsh: 'powershell',
  docker: 'dockerfile',
  make: 'makefile',
  mk: 'makefile',
  tf: 'terraform',
  tfvars: 'terraform',
  // data / config
  yml: 'yaml',
  md: 'markdown',
  mdown: 'markdown',
  jsonl: 'json',
  ndjson: 'json',
  env: 'dotenv',
  patch: 'diff',
  gql: 'graphql',
  protobuf: 'proto',
  psql: 'sql',
  postgres: 'sql',
  postgresql: 'sql',
  mysql: 'sql',
  sqlite: 'sql',
  txt: 'text',
  plain: 'text',
  plaintext: 'text',
};

/** Normalise a fenced-code language hint to a grammar id. */
export function normalizeLanguage(lang: string): string {
  const lower = lang.trim().toLowerCase();
  return LANGUAGE_ALIASES[lower] || lower;
}

/** Is `lang` (already normalised) a grammar this app bundles? */
export function isHighlightLang(lang: string): lang is HighlightLang {
  return (HIGHLIGHT_LANGS as readonly string[]).includes(lang);
}

/**
 * Hints the header shows exactly as typed, even though they normalise to
 * something else for highlighting (web's `LABEL_KEEPS_INPUT`).
 */
const LABEL_KEEPS_INPUT = new Set([
  'c#',
  'c++',
  'console',
  'cxx',
  'hpp',
  'jsonl',
  'mysql',
  'ndjson',
  'patch',
  'postgres',
  'postgresql',
  'psql',
  'shell-session',
  'sqlite',
  'svg',
]);

/** Display label for the code-block caption; an empty hint shows "text". */
export function languageLabel(language: string): string {
  if (!language) return 'text';
  const lower = language.trim().toLowerCase();
  if (LABEL_KEEPS_INPUT.has(lower)) return lower;
  return LANGUAGE_ALIASES[lower] || lower;
}
