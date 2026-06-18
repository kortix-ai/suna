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

export function resolveOpencodeDir(manifestRaw: string | null | undefined): string {
  if (!manifestRaw) return DEFAULT_OPENCODE_CONFIG_DIR;
  let inOpencode = false;
  for (const rawLine of manifestRaw.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const section = line.match(/^\[([a-zA-Z0-9_.-]+)]$/);
    if (section) {
      inOpencode = section[1] === 'opencode';
      continue;
    }
    if (!inOpencode) continue;
    const kv = line.match(/^config_dir\s*=\s*(.+)$/);
    if (kv) {
      const value = unquote(kv[1].trim());
      if (value && !value.startsWith('/') && !value.split('/').includes('..')) {
        return value.replace(/\/+$/, '');
      }
    }
  }
  return DEFAULT_OPENCODE_CONFIG_DIR;
}

export function projectNameFromManifest(manifestRaw: string | null | undefined): string | null {
  if (!manifestRaw) return null;
  let inProject = false;
  for (const rawLine of manifestRaw.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const section = line.match(/^\[([a-zA-Z0-9_.-]+)]$/);
    if (section) {
      inProject = section[1] === 'project';
      continue;
    }
    if (!inProject) continue;
    const kv = line.match(/^name\s*=\s*(.+)$/);
    if (kv) return unquote(kv[1].trim());
  }
  return null;
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
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function stripTomlComment(line: string): string {
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
