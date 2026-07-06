import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';
import {
  type ManifestFormat,
  manifestCandidatePaths,
  parseManifestText,
} from '@kortix/manifest-schema';

type YamlDocument = ReturnType<typeof parseDocument>;

/**
 * Local manifest editing — the CLI mutates config IN THE FILE (the source of
 * truth), not via a server round-trip. Edits are comment-preserving so the
 * heavily-commented scaffold survives intact. `kortix ship` then reconciles
 * the change.
 *
 * DUAL-FORMAT: reads resolve kortix.yaml OR kortix.toml (yaml preferred), and
 * both are writable. TOML edits are comment-preserving text surgery (append
 * or excise whole array-of-tables blocks, targeted scalar replacement)
 * rather than parse→stringify. YAML edits go through the `yaml` package's
 * Document API (mutating the parsed AST in place), which preserves comments
 * natively — see the `*Yaml` helpers below.
 */

/** Resolve the on-disk manifest, preferring kortix.yaml. Returns the existing
 *  file (+ format), or the canonical kortix.toml default when none exists. */
function resolveManifest(cwd: string = process.cwd()): {
  path: string;
  format: ManifestFormat;
  exists: boolean;
} {
  for (const cand of manifestCandidatePaths()) {
    const abs = resolve(cwd, cand.path);
    if (existsSync(abs)) return { path: abs, format: cand.format, exists: true };
  }
  return { path: resolve(cwd, 'kortix.toml'), format: 'toml', exists: false };
}

export function manifestFile(cwd: string = process.cwd()): string {
  return resolveManifest(cwd).path;
}

export function readManifestText(cwd?: string): string {
  const m = resolveManifest(cwd);
  if (!m.exists) {
    throw new Error('No kortix manifest here — run `kortix init` first (config is file-based).');
  }
  return readFileSync(m.path, 'utf8');
}

/** Parse the resolved manifest in its own format (read-only; works for both). */
function readParsedManifest(cwd?: string): Record<string, unknown> {
  const m = resolveManifest(cwd);
  if (!m.exists) {
    throw new Error('No kortix manifest here — run `kortix init` first (config is file-based).');
  }
  return parseManifestText(readFileSync(m.path, 'utf8'), m.format);
}

function writeManifestText(text: string, cwd?: string): void {
  writeFileSync(manifestFile(cwd), text, 'utf8');
}

/**
 * Resolve a (possibly dotted) section path to its parsed value. `triggers`
 * returns `data.triggers`; `sandbox.templates` walks into `data.sandbox.templates`.
 */
function resolveSection(data: Record<string, unknown>, section: string): unknown {
  let node: unknown = data;
  for (const seg of section.split('.')) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}

/** Does an `[[section]]` block with `field = "value"` already exist? */
export function arrayEntryExists(
  section: string,
  field: string,
  value: string,
  cwd?: string,
): boolean {
  const data = readParsedManifest(cwd);
  const arr = resolveSection(data, section);
  if (!Array.isArray(arr)) return false;
  return arr.some(
    (e) => e && typeof e === 'object' && (e as Record<string, unknown>)[field] === value,
  );
}

/** Read a single `[[section]]` entry as an object (or null). */
export function readArrayEntry(
  section: string,
  field: string,
  value: string,
  cwd?: string,
): Record<string, unknown> | null {
  const data = readParsedManifest(cwd);
  const arr = resolveSection(data, section);
  if (!Array.isArray(arr)) return null;
  return (
    (arr.find(
      (e) => e && typeof e === 'object' && (e as Record<string, unknown>)[field] === value,
    ) as Record<string, unknown> | undefined) ?? null
  );
}

/** Append an `[[section]]` block built from `fields` (insertion order). */
export function appendArrayBlock(
  section: string,
  fields: Record<string, unknown>,
  cwd?: string,
): void {
  if (resolveManifest(cwd).format === 'yaml') {
    appendArrayBlockYaml(section, fields, cwd);
    return;
  }
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
export function removeArrayBlock(
  section: string,
  field: string,
  value: string,
  cwd?: string,
): boolean {
  if (resolveManifest(cwd).format === 'yaml') {
    return removeArrayBlockYaml(section, field, value, cwd);
  }
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
    while (
      start > 0 &&
      (lines[start - 1]!.trim().startsWith('#') || lines[start - 1]!.trim() === '')
    ) {
      // Only swallow contiguous comments immediately above (not the whole file).
      if (
        lines[start - 1]!.trim() === '' &&
        (start - 2 < 0 || !lines[start - 2]!.trim().startsWith('#'))
      )
        break;
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
  if (resolveManifest(cwd).format === 'yaml') {
    return setScalarInArrayBlockYaml(section, field, idValue, key, value, cwd);
  }
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
export function setTableScalar(
  table: string,
  key: string,
  value: string | number | boolean,
  cwd?: string,
): void {
  if (resolveManifest(cwd).format === 'yaml') {
    setTableScalarYaml(table, key, value, cwd);
    return;
  }
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

// ── YAML editing ────────────────────────────────────────────────────────────
// Mirrors the four TOML text-surgery ops above, but against the `yaml`
// package's Document AST — comments are attached to nodes, so mutating the
// AST in place and re-stringifying preserves them without any text surgery.

function readYamlDocument(cwd?: string): YamlDocument {
  return parseDocument(readManifestText(cwd));
}

function writeYamlDocument(doc: YamlDocument, cwd?: string): void {
  writeManifestText(doc.toString(), cwd);
}

interface YamlSeqLike {
  items: unknown[];
}

function isYamlSeqLike(value: unknown): value is YamlSeqLike {
  return !!value && typeof value === 'object' && Array.isArray((value as YamlSeqLike).items);
}

/** Ensure every segment of `path` exists, creating an empty seq at the final
 *  segment and empty maps for the intermediate ones. */
function ensureYamlSeqPath(doc: YamlDocument, path: string[]): void {
  for (let i = 0; i < path.length; i += 1) {
    const sub = path.slice(0, i + 1);
    if (!doc.hasIn(sub)) {
      doc.setIn(sub, doc.createNode(i === path.length - 1 ? [] : {}));
    }
  }
}

/** Ensure every segment of `path` exists as a map. */
function ensureYamlMapPath(doc: YamlDocument, path: string[]): void {
  for (let i = 0; i < path.length; i += 1) {
    const sub = path.slice(0, i + 1);
    if (!doc.hasIn(sub)) doc.setIn(sub, doc.createNode({}));
  }
}

/** Index of the seq entry at `path` whose `field` equals `value`, or -1. */
function findYamlArrayIndex(doc: YamlDocument, path: string[], field: string, value: string): number {
  const seq = doc.getIn(path, true);
  if (!isYamlSeqLike(seq)) return -1;
  return seq.items.findIndex((item) => {
    if (!item || typeof (item as { get?: unknown }).get !== 'function') return false;
    return (item as { get: (k: string) => unknown }).get(field) === value;
  });
}

function appendArrayBlockYaml(section: string, fields: Record<string, unknown>, cwd?: string): void {
  const doc = readYamlDocument(cwd);
  const path = section.split('.');
  ensureYamlSeqPath(doc, path);
  const entry: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    entry[k] = v;
  }
  doc.addIn(path, doc.createNode(entry));
  writeYamlDocument(doc, cwd);
}

function removeArrayBlockYaml(section: string, field: string, value: string, cwd?: string): boolean {
  const doc = readYamlDocument(cwd);
  const path = section.split('.');
  const idx = findYamlArrayIndex(doc, path, field, value);
  if (idx < 0) return false;
  doc.deleteIn([...path, idx]);
  writeYamlDocument(doc, cwd);
  return true;
}

function setScalarInArrayBlockYaml(
  section: string,
  field: string,
  idValue: string,
  key: string,
  value: string | number | boolean,
  cwd?: string,
): boolean {
  const doc = readYamlDocument(cwd);
  const path = section.split('.');
  const idx = findYamlArrayIndex(doc, path, field, idValue);
  if (idx < 0) return false;
  doc.setIn([...path, idx, key], value);
  writeYamlDocument(doc, cwd);
  return true;
}

function setTableScalarYaml(
  table: string,
  key: string,
  value: string | number | boolean,
  cwd?: string,
): void {
  const doc = readYamlDocument(cwd);
  const path = table.split('.');
  ensureYamlMapPath(doc, path);
  doc.setIn([...path, key], value);
  writeYamlDocument(doc, cwd);
}
