/**
 * The front-matter of a memory file: an optional `---` block at the top that
 * holds `type`, `title`, `summary`, `sources`, `related`, `updated_by` and
 * `updated_at`. A small YAML subset, enough for what agents and the UI write:
 *
 * ```
 * ---
 * type: decisions
 * summary: "Pricing: $49 per seat"
 * updated_by: kortix (agent)
 * sources:
 *   - label: Pricing call
 *     url: https://example.test/call
 *   - Slack thread, 2026-10-20
 * related: [people/priya.md]
 * ---
 * ```
 *
 * A key this module does not set keeps its lines byte for byte. A file whose
 * block is not closed has no front-matter: the whole file is content.
 */

export type FrontMatterItem = string | Record<string, string>;
export type FrontMatterValue = string | FrontMatterItem[];

/** One key and its exact lines (the key line and every line under it). `key` '' holds lines before the first key. */
export interface FrontMatterEntry {
  key: string;
  lines: string[];
}

export interface SplitFile {
  /** Null when the file has no front-matter block. */
  entries: FrontMatterEntry[] | null;
  data: Record<string, FrontMatterValue>;
  /** The file after the closing `---` line. */
  content: string;
}

const OPEN = /^---\r?$/;
const CLOSE = /^(?:---|\.\.\.)\r?$/;
const KEY = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?\r?$/;
const ITEM = /^[ \t]*-(?:[ \t]+(.*))?\r?$/;
const PAIR = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/;

function unquote(raw: string): string {
  const text = raw.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return String(JSON.parse(text));
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

function inlineList(raw: string): string[] | null {
  const text = raw.trim();
  if (!text.startsWith('[') || !text.endsWith(']')) return null;
  const inner = text.slice(1, -1).trim();
  return inner ? inner.split(',').map(unquote).filter(Boolean) : [];
}

function valueOf(entry: FrontMatterEntry): FrontMatterValue {
  const head = KEY.exec(entry.lines[0]!)!;
  const inline = head[2]?.trim();
  if (inline) return inlineList(inline) ?? unquote(inline);
  const items: FrontMatterItem[] = [];
  for (const line of entry.lines.slice(1)) {
    const item = ITEM.exec(line);
    if (item) {
      const text = (item[1] ?? '').trim();
      const pair = PAIR.exec(text);
      items.push(pair ? { [pair[1]!]: unquote(pair[2] ?? '') } : unquote(text));
      continue;
    }
    // A `key: value` line under a map item continues it.
    const pair = PAIR.exec(line.trim());
    const last = items[items.length - 1];
    if (pair && last && typeof last === 'object') last[pair[1]!] = unquote(pair[2] ?? '');
  }
  return items;
}

export function splitFrontMatter(text: string): SplitFile {
  const lines = text.split('\n');
  if (!OPEN.test(lines[0] ?? '')) return { entries: null, data: {}, content: text };
  const end = lines.findIndex((line, i) => i > 0 && CLOSE.test(line));
  if (end < 0) return { entries: null, data: {}, content: text };
  const entries: FrontMatterEntry[] = [];
  for (const line of lines.slice(1, end)) {
    const key = KEY.exec(line);
    if (key) entries.push({ key: key[1]!, lines: [line] });
    // A comment at the margin stands alone: removing the key above it keeps it.
    else if (line.startsWith('#')) entries.push({ key: '', lines: [line] });
    else if (entries.length > 0) entries[entries.length - 1]!.lines.push(line);
    else entries.push({ key: '', lines: [line] });
  }
  const data: Record<string, FrontMatterValue> = {};
  for (const entry of entries) if (entry.key && !(entry.key in data)) data[entry.key] = valueOf(entry);
  return { entries, data, content: lines.slice(end + 1).join('\n') };
}

/** A scalar as YAML reads it back unchanged: plain when safe, else JSON-quoted. */
export function yamlScalar(value: string): string {
  const plain = value !== '' && value === value.trim() && !/^[-?:,[\]{}#&*!|>'"%@`]/.test(value) && !/: |\s#|[\r\n]/.test(value);
  return plain && !/^(?:true|false|null|~|yes|no|[-+]?\d[\d._]*)$/i.test(value) ? value : JSON.stringify(value);
}

function entryLines(key: string, value: FrontMatterValue): string[] {
  if (typeof value === 'string') return [`${key}: ${yamlScalar(value)}`];
  const lines = [`${key}:`];
  for (const item of value) {
    if (typeof item === 'string') {
      lines.push(`  - ${yamlScalar(item)}`);
      continue;
    }
    Object.entries(item).forEach(([k, v], i) => lines.push(`${i === 0 ? '  - ' : '    '}${k}: ${yamlScalar(v)}`));
  }
  return lines;
}

/**
 * The front-matter with `updates` applied: a key with a value is rewritten in
 * place (or added at the end), a key set to undefined is removed, every
 * other line is kept as it was.
 */
export function setFrontMatter(entries: readonly FrontMatterEntry[] | null, updates: Record<string, FrontMatterValue | undefined>): FrontMatterEntry[] {
  const next: FrontMatterEntry[] = [];
  const done = new Set<string>();
  for (const entry of entries ?? []) {
    if (!(entry.key in updates)) {
      next.push(entry);
      continue;
    }
    if (done.has(entry.key)) continue;
    done.add(entry.key);
    const value = updates[entry.key];
    if (value !== undefined) next.push({ key: entry.key, lines: entryLines(entry.key, value) });
  }
  for (const [key, value] of Object.entries(updates)) {
    if (!done.has(key) && value !== undefined) next.push({ key, lines: entryLines(key, value) });
  }
  return next;
}

/** The file text: the front-matter block (none when there are no entries), then `content`. */
export function joinFrontMatter(entries: readonly FrontMatterEntry[] | null, content: string): string {
  if (!entries || entries.length === 0) return content;
  return `---\n${entries.flatMap((entry) => entry.lines).join('\n')}\n---\n${content}`;
}
