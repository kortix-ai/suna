import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';

/**
 * Local kortix.toml editing — the CLI mutates config IN THE FILE (the source of
 * truth), not via a server round-trip. Edits are comment-preserving: we append
 * or excise whole array-of-tables blocks (and do targeted scalar replacement)
 * with text surgery rather than parse→stringify, so the heavily-commented
 * scaffold survives intact. `kortix ship` then reconciles the change.
 */

export function manifestFile(cwd: string = process.cwd()): string {
  return resolve(cwd, 'kortix.toml');
}

export function readManifestText(cwd?: string): string {
  const path = manifestFile(cwd);
  if (!existsSync(path)) {
    throw new Error('No kortix.toml here — run `kortix init` first (config is file-based).');
  }
  return readFileSync(path, 'utf8');
}

function writeManifestText(text: string, cwd?: string): void {
  writeFileSync(manifestFile(cwd), text, 'utf8');
}

/** Does an `[[section]]` block with `field = "value"` already exist? */
export function arrayEntryExists(section: string, field: string, value: string, cwd?: string): boolean {
  const data = parseToml(readManifestText(cwd)) as Record<string, unknown>;
  const arr = data[section];
  if (!Array.isArray(arr)) return false;
  return arr.some((e) => e && typeof e === 'object' && (e as Record<string, unknown>)[field] === value);
}

/** Read a single `[[section]]` entry as an object (or null). */
export function readArrayEntry(
  section: string,
  field: string,
  value: string,
  cwd?: string,
): Record<string, unknown> | null {
  const data = parseToml(readManifestText(cwd)) as Record<string, unknown>;
  const arr = data[section];
  if (!Array.isArray(arr)) return null;
  return (
    (arr.find((e) => e && typeof e === 'object' && (e as Record<string, unknown>)[field] === value) as
      | Record<string, unknown>
      | undefined) ?? null
  );
}

/** Append an `[[section]]` block built from `fields` (insertion order). */
export function appendArrayBlock(section: string, fields: Record<string, unknown>, cwd?: string): void {
  const text = readManifestText(cwd);
  const block = serializeArrayBlock(section, fields);
  const sep = text.endsWith('\n') ? (text.endsWith('\n\n') ? '' : '\n') : '\n\n';
  writeManifestText(`${text}${sep}${block}`, cwd);
}

/**
 * Remove the `[[section]]` block whose `field` equals `value`. Returns false if
 * not found. The block runs from its `[[section]]` header to the line before
 * the next top-level `[`/`[[` header (or EOF), minus trailing blank lines.
 */
export function removeArrayBlock(section: string, field: string, value: string, cwd?: string): boolean {
  const text = readManifestText(cwd);
  const lines = text.split('\n');
  const headerRe = new RegExp(`^\\s*\\[\\[\\s*${escapeRe(section)}\\s*\\]\\]\\s*$`);
  const anyHeaderRe = /^\s*\[/;
  const fieldRe = new RegExp(`^\\s*${escapeRe(field)}\\s*=\\s*["']${escapeRe(value)}["']\\s*$`);

  for (let i = 0; i < lines.length; i += 1) {
    if (!headerRe.test(lines[i]!)) continue;
    // Find the block extent.
    let end = i + 1;
    while (end < lines.length && !anyHeaderRe.test(lines[end]!)) end += 1;
    const blockMatches = lines.slice(i, end).some((l) => fieldRe.test(l));
    if (!blockMatches) continue;
    // Also swallow a single leading comment block + blank line that introduces it.
    let start = i;
    while (start > 0 && (lines[start - 1]!.trim().startsWith('#') || lines[start - 1]!.trim() === '')) {
      // Only swallow contiguous comments immediately above (not the whole file).
      if (lines[start - 1]!.trim() === '' && (start - 2 < 0 || !lines[start - 2]!.trim().startsWith('#'))) break;
      start -= 1;
    }
    const next = [...lines.slice(0, start), ...lines.slice(end)];
    writeManifestText(collapseBlankRuns(next.join('\n')), cwd);
    return true;
  }
  return false;
}

/**
 * Set a scalar `key` inside the `[[section]]` block identified by
 * `field = idValue`, in place (preserves the block's other lines/comments).
 * Inserts the key right after the header if absent. Returns false if no block.
 */
export function setScalarInArrayBlock(
  section: string,
  field: string,
  idValue: string,
  key: string,
  value: string | number | boolean,
  cwd?: string,
): boolean {
  const text = readManifestText(cwd);
  const lines = text.split('\n');
  const headerRe = new RegExp(`^\\s*\\[\\[\\s*${escapeRe(section)}\\s*\\]\\]\\s*$`);
  const anyHeaderRe = /^\s*\[/;
  const idRe = new RegExp(`^\\s*${escapeRe(field)}\\s*=\\s*["']${escapeRe(idValue)}["']\\s*$`);
  const keyRe = new RegExp(`^(\\s*)${escapeRe(key)}\\s*=`);
  const rendered = `${key} = ${renderScalar(value)}`;

  for (let i = 0; i < lines.length; i += 1) {
    if (!headerRe.test(lines[i]!)) continue;
    let end = i + 1;
    while (end < lines.length && !anyHeaderRe.test(lines[end]!)) end += 1;
    if (!lines.slice(i, end).some((l) => idRe.test(l))) continue;
    for (let j = i + 1; j < end; j += 1) {
      if (keyRe.test(lines[j]!)) {
        lines[j] = lines[j]!.replace(/=.*/, `= ${renderScalar(value)}`);
        writeManifestText(lines.join('\n'), cwd);
        return true;
      }
    }
    // Not present — insert right after the header.
    lines.splice(i + 1, 0, rendered);
    writeManifestText(lines.join('\n'), cwd);
    return true;
  }
  return false;
}

/**
 * Set `key = value` inside a top-level `[table]` (e.g. `[policy]`), in place.
 * Creates the table at EOF if absent. Comment-preserving.
 */
export function setTableScalar(table: string, key: string, value: string | number | boolean, cwd?: string): void {
  const text = readManifestText(cwd);
  const lines = text.split('\n');
  const headerRe = new RegExp(`^\\s*\\[\\s*${escapeRe(table)}\\s*\\]\\s*$`);
  const anyHeaderRe = /^\s*\[/;
  const keyRe = new RegExp(`^(\\s*)${escapeRe(key)}\\s*=`);

  for (let i = 0; i < lines.length; i += 1) {
    if (!headerRe.test(lines[i]!)) continue;
    let end = i + 1;
    while (end < lines.length && !anyHeaderRe.test(lines[end]!)) end += 1;
    for (let j = i + 1; j < end; j += 1) {
      if (keyRe.test(lines[j]!)) {
        lines[j] = lines[j]!.replace(/=.*/, `= ${renderScalar(value)}`);
        writeManifestText(lines.join('\n'), cwd);
        return;
      }
    }
    lines.splice(i + 1, 0, `${key} = ${renderScalar(value)}`);
    writeManifestText(lines.join('\n'), cwd);
    return;
  }
  // No table yet — append one.
  const sep = text.endsWith('\n') ? '\n' : '\n\n';
  writeManifestText(`${text}${sep}[${table}]\n${key} = ${renderScalar(value)}\n`, cwd);
}

// ── serialization ───────────────────────────────────────────────────────────

function serializeArrayBlock(section: string, fields: Record<string, unknown>): string {
  const out = [`[[${section}]]`];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    out.push(`${k} = ${renderValue(v)}`);
  }
  return `${out.join('\n')}\n`;
}

function renderValue(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => renderScalar(x as never)).join(', ')}]`;
  if (v && typeof v === 'object') {
    const inner = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined && val !== null)
      .map(([k, val]) => `${k} = ${renderScalar(val as never)}`)
      .join(', ');
    return `{ ${inner} }`;
  }
  return renderScalar(v as string | number | boolean);
}

function renderScalar(v: string | number | boolean): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Collapse 3+ consecutive blank lines (left by block removal) down to 2. */
function collapseBlankRuns(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}
