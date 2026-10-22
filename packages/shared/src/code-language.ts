/**
 * Fenced-code language hints that are not the id the highlighter preloads.
 *
 * Two kinds live here and both cost the reader something:
 *
 * 1. Hints Shiki has no grammar *or* alias for — `golang`, `env`, `patch`,
 *    `svg`, `psql`, `plaintext`. `ensureLangLoaded` throws on these, the catch
 *    warns, and the block renders unhighlighted forever.
 * 2. Hints Shiki resolves but only through its own alias table — `rs`, `kt`,
 *    `c++`, `ps1`. Those highlight, but `highlightSync` gates on
 *    `loadedLangs.has(lang)`, which is seeded from `PRELOAD_LANGS` verbatim, so
 *    the unresolved spelling misses the fast path and the block repaints from
 *    plain to colour a frame later.
 *
 * Every value must therefore be a `PRELOAD_LANGS` entry, not Shiki's canonical
 * id — that list carries `dockerfile`, `makefile` and `bash`, which are
 * themselves Shiki aliases (of `docker`, `make`, `shellscript`). Normalising to
 * the canonical id would be correct and still miss the sync path. The unit test
 * pins this; add an alias there and it fails until the target is preloaded.
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

/** Normalise a fenced-code language hint to a Shiki grammar id. */
export function normalizeLanguage(lang: string): string {
  const lower = lang.toLowerCase();
  return LANGUAGE_ALIASES[lower] || lower;
}

/**
 * Hints the header shows exactly as typed, even though they normalise to
 * something else for highlighting. The grammar id is a Shiki implementation
 * detail; these spellings name a narrower thing the reader chose on purpose, and
 * collapsing them loses that — a `psql` block labelled "sql", an `svg` block
 * labelled "xml", a `c++` block labelled "cpp". Everything else takes the
 * normalised name, so the two tables cannot drift apart.
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

/** Display label for the code-block header; empty hint falls back to "text". */
export function languageLabel(language: string): string {
  if (!language) return 'text';
  const lower = language.toLowerCase();
  if (LABEL_KEEPS_INPUT.has(lower)) return lower;
  return LANGUAGE_ALIASES[lower] || lower;
}
