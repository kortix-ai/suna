/**
 * Tiny, dependency-free readers shared by build + fetch:
 *   - projectNameFromManifest: `project.name` from a kortix.yaml
 *   - parseFrontmatter:        YAML-ish frontmatter from a SKILL.md / agent .md
 *
 * This package ships into the sandbox/CLI bundle, so it deliberately avoids a
 * full YAML parser.
 */

/**
 * Read a scalar `key` out of a top-level `section:` block of a kortix.yaml: a
 * top-level `section:` key and an indented `key: value` below it. `#` opens a
 * comment. Returns null if not found.
 */
function readSectionScalar(manifestRaw: string, section: string, key: string): string | null {
  let inSection = false;
  const keyRe = new RegExp(`^${key}\\s*:\\s*(.+)$`);
  for (const rawLine of manifestRaw.split(/\r?\n/)) {
    const stripped = stripComment(rawLine);
    const line = stripped.trim();
    if (!line) continue;
    // A top-level key (no leading indentation, `key:`) opens or closes a block.
    if (/^\S/.test(stripped)) {
      const topKey = line.match(/^([a-zA-Z0-9_.-]+)\s*:(?:\s|$)/);
      if (topKey) {
        inSection = topKey[1] === section;
        continue;
      }
    }
    if (!inSection) continue;
    const kv = line.match(keyRe);
    if (kv) return unquote(kv[1].trim());
  }
  return null;
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

// `#` opens a comment outside quotes.
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
