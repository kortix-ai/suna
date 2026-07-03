/**
 * Tiny, dependency-free readers shared by build + install:
 *   - resolveOpencodeDir: the `[opencode] config_dir` from kortix.toml
 *   - parseFrontmatter:   YAML-ish frontmatter from a SKILL.md / agent .md
 *
 * These intentionally mirror apps/api/src/projects/git/config.ts so the CLI
 * (which scans a working tree) and the API (which scans a git tree) agree on
 * where things live and how their metadata is read.
 */

export const DEFAULT_OPENCODE_CONFIG_DIR = '.kortix/opencode';

/**
 * Read a scalar `key` out of a top-level `[section]` (TOML) or `section:` (YAML)
 * block of a manifest. Dependency-free heuristic line reader (this package ships
 * into the sandbox/CLI bundle, so it deliberately avoids a full parser) that
 * handles BOTH formats: a TOML `[section]` header + `key = value`, or a YAML
 * top-level `section:` key + an indented `key: value`. `#` opens a comment in
 * both. Returns null if not found.
 */
function readSectionScalar(manifestRaw: string, section: string, key: string): string | null {
  let inSection = false;
  const keyRe = new RegExp(`^${key}\\s*[:=]\\s*(.+)$`);
  for (const rawLine of manifestRaw.split(/\r?\n/)) {
    const stripped = stripComment(rawLine);
    const line = stripped.trim();
    if (!line) continue;
    // TOML table header — `[section]`.
    const tomlSection = line.match(/^\[([a-zA-Z0-9_.-]+)]$/);
    if (tomlSection) {
      inSection = tomlSection[1] === section;
      continue;
    }
    // A YAML top-level key (no leading indentation, `key:`) opens/closes a block.
    if (/^\S/.test(stripped)) {
      const topKey = line.match(/^([a-zA-Z0-9_.-]+)\s*:(?:\s|$)/);
      if (topKey) {
        inSection = topKey[1] === section;
        continue;
      }
    }
    if (!inSection) continue;
    // `key = value` (TOML) or `key: value` (YAML, indented under the section).
    const kv = line.match(keyRe);
    if (kv) return unquote(kv[1].trim());
  }
  return null;
}

export function resolveOpencodeDir(manifestRaw: string | null | undefined): string {
  if (!manifestRaw) return DEFAULT_OPENCODE_CONFIG_DIR;
  const value = readSectionScalar(manifestRaw, 'opencode', 'config_dir');
  if (value && !value.startsWith('/') && !value.split('/').includes('..')) {
    return value.replace(/\/+$/, '');
  }
  return DEFAULT_OPENCODE_CONFIG_DIR;
}

export function projectNameFromManifest(manifestRaw: string | null | undefined): string | null {
  if (!manifestRaw) return null;
  return readSectionScalar(manifestRaw, 'project', 'name');
}

export function parseFrontmatter(raw: string | null | undefined): Record<string, string> {
  if (!raw?.startsWith('---')) return {};
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return {};
  const meta: Record<string, string> = {};
  for (const line of raw.slice(3, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (!match) continue;
    meta[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return meta;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

// `#` opens a comment in both TOML and YAML (outside quotes) — shared reader.
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if ((ch === '"' || ch === "'") && line[i - 1] !== '\\') {
      quote = quote === ch ? null : quote || ch;
      continue;
    }
    if (ch === '#' && !quote) return line.slice(0, i);
  }
  return line;
}
