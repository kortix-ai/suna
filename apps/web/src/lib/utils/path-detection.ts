/**
 * Path detection utility — robust regex-based file path detection in arbitrary text.
 *
 * Used across the entire frontend to make file paths clickable wherever they appear:
 * markdown, terminal output, tool results, etc.
 */

// ---------------------------------------------------------------------------
// Common file extensions (case-insensitive check)
// ---------------------------------------------------------------------------

const COMMON_EXTENSIONS = new Set([
  // Code
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
  'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala',
  'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hxx', 'cs', 'fs', 'fsx',
  'swift', 'm', 'mm', 'zig', 'nim', 'lua', 'r', 'jl', 'ex', 'exs',
  'erl', 'hrl', 'clj', 'cljs', 'cljc', 'dart', 'v', 'sv', 'vhd',
  'php', 'pl', 'pm', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  // Web
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl', 'vue', 'svelte',
  'astro', 'mdx',
  // Data / config
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'env', 'xml', 'csv', 'tsv', 'sql', 'graphql', 'gql', 'proto', 'avro',
  // Docs
  'md', 'markdown', 'txt', 'rst', 'adoc', 'tex', 'bib', 'org',
  // Build / tooling
  'dockerfile', 'makefile', 'cmake', 'gradle', 'sbt', 'lock',
  'gitignore', 'eslintrc', 'prettierrc', 'editorconfig', 'npmrc',
  // Images / media (so users can preview them)
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico', 'bmp',
  'mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'flac',
  // Documents
  'pdf', 'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt',
  // Misc
  'wasm', 'map', 'snap', 'patch', 'diff', 'log',
]);

// ---------------------------------------------------------------------------
// Patterns that look like paths but are NOT
// ---------------------------------------------------------------------------

const COMMON_NON_FILES = new Set([
  'e.g.', 'i.e.', 'etc.', 'vs.', 'v1.', 'v2.', 'v3.',
  'n/a', 'w/o', 'w/', 'i/o',
]);

// URL protocols — skip anything that looks like a URL
const URL_PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Check if a regex match at the given position is embedded inside a URL.
 * Scans backwards to the nearest whitespace boundary and checks if the
 * resulting token starts with a URL protocol (http://, https://, etc.).
 *
 * For example, in "http://localhost:3211/open?path=/workspace/file.txt",
 * the path "/workspace/file.txt" is embedded in the URL and should NOT
 * be detected as a standalone clickable file path.
 */
function isEmbeddedInUrl(text: string, matchStart: number): boolean {
  let i = matchStart - 1;
  while (i >= 0 && !/\s/.test(text[i])) {
    i--;
  }
  const tokenStart = i + 1;
  if (tokenStart >= matchStart) return false;
  const preceding = text.slice(tokenStart, matchStart);
  // Strip leading delimiters (quotes, brackets) that might wrap the URL
  const stripped = preceding.replace(/^["'`(\[{<]+/, '');
  return URL_PROTOCOL_RE.test(stripped);
}

// ---------------------------------------------------------------------------
// Core regex
// ---------------------------------------------------------------------------

/**
 * Regex that matches file paths in arbitrary text.
 *
 * Matches:
 *   /absolute/path/to/file.ext
 *   ./relative/path/file.ext
 *   ../parent/path/file.ext
 *   ~/home/path/file.ext
 *   relative/dir/file.ext (at least one slash, must end with extension)
 *
 * Optional line:col suffix:  :42  or  :42:15
 *
 * Won't match inside URLs (http://...), or strings without a slash.
 *
 * Structure:
 *   (lookbehind)(path-group)(line-col-group?)(lookahead)
 *
 *   lookbehind  = start-of-string OR whitespace/delimiter
 *   path-group  = optional prefix (./ ../ ~/ /) + dir-segments + filename.ext
 *   line-col    = optional :line or :line:col
 *   lookahead   = end-of-string OR whitespace/delimiter
 */
// Build the regex as a single string, then compile it.
const FILE_PATH_PATTERN = [
  "(?:^|(?<=[\\s\"'`({\\[,;|=>]))",   // lookbehind: start or delimiter
  "(",                                  // group 1 open
    "(?:\\.{0,2}/|~/)?",               //   optional prefix: / ./ ../ ~/
    "(?:[\\w@.][\\w@.\\-]*/)+",        //   one or more dir segments
    "[\\w@.\\-]+",                      //   filename
    "\\.\\w{1,10}",                     //   .extension
  ")",                                  // group 1 close
  "(:\\d{1,6}(?::\\d{1,6})?)?",        // group 2: optional :line:col
  "(?=$|[\\s\"'`()}\\[\\],;|<])",      // lookahead: end or delimiter
].join("");

/**
 * Pre-compiled global regex for scanning text.
 * NOTE: we recreate per call because global regexes are stateful.
 */
function getPathRegex(): RegExp {
  return new RegExp(FILE_PATH_PATTERN, 'gm');
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PathSegment {
  type: 'text' | 'path';
  value: string;
  /** The clean file path (without :line:col) */
  filePath?: string;
  /** Line number if present (e.g. from `:42`) */
  lineNumber?: number;
  /** Column number if present (e.g. from `:42:15`) */
  column?: number;
}

export interface PathMatch {
  /** The full matched string including :line:col */
  fullMatch: string;
  /** The clean file path without :line:col */
  filePath: string;
  /** Start index in the source text */
  start: number;
  /** End index in the source text */
  end: number;
  /** Line number if present */
  lineNumber?: number;
  /** Column number if present */
  column?: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Heuristic: does this string look like a file path? */
export function looksLikeFilePath(text: string): boolean {
  if (!text || text.length < 3 || text.length > 500) return false;
  if (text.includes(' ') || text.includes('\n')) return false;
  if (COMMON_NON_FILES.has(text.toLowerCase())) return false;
  if (URL_PROTOCOL_RE.test(text)) return false;
  // Must contain at least one slash
  if (!text.includes('/')) return false;
  // Extract extension
  const extMatch = text.replace(/:\d+(?::\d+)?$/, '').match(/\.(\w{1,10})$/);
  if (!extMatch) return false;
  return COMMON_EXTENSIONS.has(extMatch[1].toLowerCase());
}

/**
 * Find all file path matches in a block of text.
 * Returns an array of PathMatch objects with positions and parsed line/col.
 */
export function detectFilePaths(text: string): PathMatch[] {
  if (!text || text.length < 4) return [];

  const regex = getPathRegex();
  const matches: PathMatch[] = [];
  let m: RegExpExecArray | null;

  while ((m = regex.exec(text)) !== null) {
    const pathPart = m[1];
    const lineColPart = m[2] || '';
    const fullMatch = pathPart + lineColPart;

    // Skip if it looks like a URL fragment
    if (URL_PROTOCOL_RE.test(pathPart)) continue;

    // Skip if the matched path is embedded inside a URL
    // (e.g. "http://localhost:3211/open?path=/workspace/file.txt")
    if (isEmbeddedInUrl(text, m.index)) continue;

    // Skip common non-file patterns
    if (COMMON_NON_FILES.has(pathPart.toLowerCase())) continue;

    // Verify extension is known
    const extMatch = pathPart.match(/\.(\w{1,10})$/);
    if (!extMatch || !COMMON_EXTENSIONS.has(extMatch[1].toLowerCase())) continue;

    // Parse line:col if present
    let lineNumber: number | undefined;
    let column: number | undefined;
    if (lineColPart) {
      const parts = lineColPart.slice(1).split(':');
      lineNumber = parseInt(parts[0], 10);
      if (parts[1]) column = parseInt(parts[1], 10);
    }

    matches.push({
      fullMatch,
      filePath: pathPart,
      start: m.index,
      end: m.index + fullMatch.length,
      lineNumber,
      column,
    });
  }

  return matches;
}

/**
 * Split text into alternating text and path segments.
 * This is the primary function used by rendering components.
 */
export function splitTextByPaths(text: string): PathSegment[] {
  if (!text) return [];

  const matches = detectFilePaths(text);
  if (matches.length === 0) {
    return [{ type: 'text', value: text }];
  }

  const segments: PathSegment[] = [];
  let lastIndex = 0;

  for (const match of matches) {
    // Text before this path
    if (match.start > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, match.start) });
    }

    segments.push({
      type: 'path',
      value: match.fullMatch,
      filePath: match.filePath,
      lineNumber: match.lineNumber,
      column: match.column,
    });

    lastIndex = match.end;
  }

  // Remaining text after last match
  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return segments;
}
