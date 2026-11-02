/**
 * `GOAL.md`: a goal's definition and state as YAML front matter, then free
 * Markdown. `kortix goals` writes it in a session; a person may edit it in
 * Files. The front matter uses a small YAML subset, enough for what the CLI
 * writes and for hand edits: `key: value` scalars (plain, "double" or
 * 'single' quoted, `null`/`~`, booleans, numbers), block lists of scalars,
 * block lists of flat maps, `[]`, and `#` comments. Anything else reads as a
 * string. No YAML dependency: this package keeps zero runtime dependencies.
 */

import type { ProjectGoalDocument } from './goals';

/** GOAL.md key → ProjectGoalDocument field, in file order. */
const FIELDS: ReadonlyArray<readonly [string, keyof ProjectGoalDocument]> = [
  ['goal', 'objective'],
  ['state', 'status'],
  ['assigned_user', 'assigned_user'],
  ['assigned_agent', 'agent'],
  ['space', 'space'],
  ['summary', 'summary'],
  ['done_criteria', 'success_criteria'],
  ['links', 'links'],
  ['waiting_on', 'waiting_on'],
  ['heartbeat', 'heartbeat_every'],
  ['max_wakes_per_day', 'max_wakes_per_day'],
  ['max_sessions', 'max_sessions'],
  ['reminder_id', 'reminder_id'],
  ['next_wake_at', 'next_wake_at'],
  ['last_wake_at', 'last_wake_at'],
  ['wake_day', 'wake_day'],
  ['wake_count', 'wake_count'],
  ['verified_by', 'verified_by'],
  ['sessions', 'sessions'],
  ['transitions', 'transitions'],
];
const LISTS = new Set(['done_criteria', 'links', 'sessions', 'transitions']);
const KEY = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/;

function scalar(raw: string): unknown {
  let s = raw.trim();
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      return s.replace(/^"|"$/g, '');
    }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length > 1) return s.slice(1, -1).replace(/''/g, "'");
  s = s.replace(/\s+#.*$/, '');
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true' || s === 'false') return s === 'true';
  if (s === '[]') return [];
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function fmt(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'string') return String(value);
  return /^[A-Za-z0-9_./@+][A-Za-z0-9 _./@+,()'-]*$/.test(value) && !value.endsWith(' ') && scalar(value) === value
    ? value
    : JSON.stringify(value);
}

/** The front matter's top-level keys, unparsed values kept as the subset reads them. */
function frontMatter(lines: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let key: string | null = null;
  let item: Record<string, unknown> | null = null;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const top = /^\S/.test(line) ? KEY.exec(line) : null;
    if (top) {
      key = top[1]!;
      item = null;
      out[key] = top[2] === undefined ? null : scalar(top[2]);
      continue;
    }
    if (!key) continue;
    const dash = /^\s*-(?:\s+(.*))?$/.exec(line);
    if (dash) {
      const list = Array.isArray(out[key]) ? (out[key] as unknown[]) : (out[key] = []) as unknown[];
      const pair = KEY.exec(dash[1] ?? '');
      item = pair ? { [pair[1]!]: pair[2] === undefined ? null : scalar(pair[2]) } : null;
      list.push(item ?? scalar(dash[1] ?? ''));
      continue;
    }
    const pair = KEY.exec(line.trim());
    if (pair && item) item[pair[1]!] = pair[2] === undefined ? null : scalar(pair[2]);
  }
  return out;
}

/**
 * Read a GOAL.md. Null when the file has no front matter or no `goal:`.
 * Lists that are not lists read as empty lists.
 */
export function parseGoalFile(text: string | null | undefined): ProjectGoalDocument | null {
  if (!text) return null;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end < 0) return null;
  const raw = frontMatter(lines.slice(1, end));
  if (typeof raw.goal !== 'string' || !raw.goal.trim()) return null;
  const doc: Record<string, unknown> = { version: 1, summary: '', items: [], reminder_id: null, verified_by: null, next_wake_at: null };
  for (const [fileKey, field] of FIELDS) {
    if (!(fileKey in raw)) continue;
    const value = raw[fileKey];
    doc[field] = LISTS.has(fileKey)
      ? Array.isArray(value)
        ? value.filter((v) => (fileKey === 'links' ? typeof v === 'string' : v && typeof v === 'object'))
        : []
      : value;
  }
  for (const [fileKey, field] of FIELDS) if (LISTS.has(fileKey) && fileKey !== 'links' && !(fileKey in raw)) doc[field] = [];
  if (typeof doc.summary !== 'string') doc.summary = doc.summary == null ? '' : String(doc.summary);
  return { ...(doc as unknown as ProjectGoalDocument), format: 'goal.md', body: lines.slice(end + 1).join('\n') };
}

/** Write a GOAL.md: front matter in a fixed key order, then `doc.body`. Undefined fields are left out. */
export function formatGoalFile(doc: ProjectGoalDocument): string {
  const out = ['---'];
  for (const [fileKey, field] of FIELDS) {
    const value = doc[field];
    if (value === undefined) continue;
    if (!LISTS.has(fileKey)) {
      out.push(`${fileKey}: ${fmt(value)}`);
      continue;
    }
    const list = (value ?? []) as unknown[];
    if (list.length === 0) {
      out.push(`${fileKey}: []`);
      continue;
    }
    out.push(`${fileKey}:`);
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') {
        out.push(`  - ${fmt(entry)}`);
        continue;
      }
      Object.entries(entry).forEach(([k, v], i) => out.push(`${i === 0 ? '  - ' : '    '}${k}: ${fmt(v)}`));
    }
  }
  out.push('---');
  return `${out.join('\n')}\n${doc.body ?? ''}`;
}
