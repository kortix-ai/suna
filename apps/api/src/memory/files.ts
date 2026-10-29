/**
 * Memory pages are the Markdown files of a layer folder (`./layers`). This
 * module maps a file to a page and back, and runs every page read and write
 * as Drive operations. Nothing is copied: what an agent writes through its
 * mount is the page, and what a person saves here is the file the agent reads.
 *
 * A page is a `.md` / `.markdown` / `.txt` file anywhere under the layer
 * folder, not hidden (no `.`-segment), not a conflict copy, not in the folder
 * of another of the owner's DM agents. Delete is a Drive delete: no trash.
 */
import type {
  MemoryAuthor,
  MemoryLayer,
  MemoryNoteInput,
  MemoryPage,
  MemoryPageCreateInput,
  MemoryPageSummary,
  MemoryPageType,
  MemoryPageUpdateInput,
  MemorySource,
} from '@kortix/api-contract';
import { MEMORY_FILED_PAGE_TYPES, MEMORY_LIMITS, MEMORY_PAGE_TYPES, MemorySourceKindSchema } from '@kortix/api-contract';
import { conflictOriginal } from '../drives/access';
import { pathWithinFolder } from '../drives/folders';
import { DriveStorageError } from '../drives/volumes';
import { mapWithConcurrency } from '../shared/map-with-concurrency';
import { joinFrontMatter, type FrontMatterValue, setFrontMatter, type SplitFile, splitFrontMatter } from './front-matter';
import { assertWrites, type Layer, MemoryError, notFound } from './layers';
import { findSecret } from './secret-check';
import { volumeOps } from './volume-ops';

export { volumeOps } from './volume-ops';

// ─── Ids ────────────────────────────────────────────────────────────────────

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
const unb64 = (id: string) => (/^[A-Za-z0-9_-]{1,2048}$/.test(id) ? Buffer.from(id, 'base64url').toString('utf8') : '');

/** A relative path that stays inside its folder: no empty, `.` or `..` segment, no leading slash. */
export function safeRel(rel: string): boolean {
  return rel.length > 0 && rel.length <= 1024 && rel.split('/').every((part) => part !== '' && part !== '.' && part !== '..') && !/[\u0000-\u001f]/.test(rel);
}

export const pageIdOf = (key: string, rel: string) => b64(`${key}\n${rel}`);

export function decodePageId(id: string): { key: string; rel: string } | null {
  const [key, rel, ...rest] = unb64(id).split('\n');
  return key && rel && rest.length === 0 && safeRel(rel) ? { key, rel } : null;
}

/** A page version's id: the page and the Drive commit that wrote it. */
export const versionIdOf = (key: string, rel: string, commit: string) => b64(`${key}\n${rel}\n${commit}`);

// ─── A file as a page (pure) ────────────────────────────────────────────────

const PAGE_EXT = /\.(?:md|markdown|txt)$/i;
const H1 = /^#[ \t]+(.+?)[ \t]*#*[ \t]*\r?$/;

/** `MEMORY.md` (any case, any folder): a folder's index that agents keep. Never a page; no route reads, edits or deletes it. */
export const isIndexFile = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1).toLowerCase() === 'memory.md';

/** Is `rel` (relative to a layer folder) a page file? */
export function isPageRel(rel: string): boolean {
  return PAGE_EXT.test(rel) && !rel.split('/').some((part) => part.startsWith('.')) && conflictOriginal(rel) === null && !isIndexFile(rel);
}

/** A file name as a title: no extension, `-` and `_` as spaces. */
export function titleFromName(rel: string): string {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  return base.replace(PAGE_EXT, '').replace(/[-_]+/g, ' ').trim() || base;
}

/**
 * A page's type: front-matter `type:`, else its first folder (case-insensitive;
 * inside a DM's agent folder, the first folder under it), else `Notes.md`
 * at the top = `note`, else `other`.
 */
export function typeOf(declared: unknown, rel: string, agentSegment: string | null): MemoryPageType {
  if (typeof declared === 'string' && (MEMORY_PAGE_TYPES as readonly string[]).includes(declared.toLowerCase())) {
    return declared.toLowerCase() as MemoryPageType;
  }
  let parts = rel.split('/');
  if (agentSegment && parts.length > 1 && parts[0] === agentSegment) parts = parts.slice(1);
  const folder = parts.length > 1 ? parts[0]!.toLowerCase() : null;
  if (folder && (MEMORY_FILED_PAGE_TYPES as readonly string[]).includes(folder)) return folder as MemoryPageType;
  if (parts.length === 1 && parts[0]!.toLowerCase() === 'notes.md') return 'note';
  return 'other';
}

/** `Jay` → a person; `kortix (agent)` → an agent; empty or an email (never shown) → null. */
export function authorFromFrontMatter(value: FrontMatterValue | undefined): MemoryAuthor | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.includes('@')) return null;
  const agent = /^(.+?)\s*\(agent\)$/i.exec(text);
  return agent
    ? { kind: 'agent', user_id: null, name: null, agent: agent[1]! }
    : { kind: 'person', user_id: null, name: text, agent: null };
}

const SYSTEM_AUTHOR: MemoryAuthor = { kind: 'system', user_id: null, name: null, agent: null };

/** Front-matter `sources:` as numbered sources, in file order. */
export function sourcesOf(value: FrontMatterValue | undefined): MemorySource[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, i): MemorySource => {
    const map = typeof item === 'string' ? (/^https?:\/\//i.test(item) ? { url: item } : { label: item }) : item;
    const session = map.session ?? map.session_id ?? null;
    const declared = MemorySourceKindSchema.safeParse(map.kind);
    return {
      number: i + 1,
      kind: declared.success ? declared.data : session ? 'thread' : 'outside',
      session_id: session,
      message_id: map.message ?? map.message_id ?? null,
      label: map.label ?? map.title ?? map.url ?? session ?? `Source ${i + 1}`,
      url: map.url ?? null,
      thread_href_hint: null,
    };
  });
}

export interface ParsedPage {
  type: MemoryPageType;
  title: string;
  summary: string;
  /** The body's opening as plain text, at most `EXCERPT_CHARS`: the All view's card. */
  excerpt: string;
  body: string;
  sources: MemorySource[];
  /** Front-matter `related:`, relative paths. */
  related: string[];
  updatedBy: MemoryAuthor | null;
  updatedAt: string | null;
  split: SplitFile;
  /** The content before the body: the `# ` heading line and the blank lines after it. */
  head: string;
}

/** The first non-blank, non-heading line of the body, at most 200 characters. */
function firstLine(body: string): string {
  const line = body.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? '';
  return line.replace(/^(?:[-*+>]\s+)+/, '').slice(0, MEMORY_LIMITS.summary_chars);
}

const EXCERPT_CHARS = 280;

/** The body as one line of plain text: headings, fences, list, quote, table and inline Markdown marks dropped. */
function excerptOf(body: string): string {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('```') && !/^\|?[\s:|-]+\|?$/.test(line))
    .map((line) =>
      line
        .replace(/^(?:[-*+>]\s+|\d+[.)]\s+|\[[ xX]\]\s+)+/, '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*`~]+/g, '')
        // `_` marks emphasis only at a word edge: `project_channels` keeps its underscore.
        .replace(/(^|\W)_+|_+(?=\W|$)/g, '$1')
        .replace(/\s*\|\s*/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .join(' ')
    .slice(0, EXCERPT_CHARS)
    .trim();
}

export function parsePage(text: string, rel: string, agentSegment: string | null): ParsedPage {
  const split = splitFrontMatter(text);
  const { data, content } = split;
  // The heading counts only as the first non-blank line: the title, not a section.
  const lead = /^(?:[ \t]*\r?\n)*/.exec(content)![0];
  const lineEnd = content.indexOf('\n', lead.length);
  const firstContentLine = content.slice(lead.length, lineEnd < 0 ? undefined : lineEnd);
  const h1 = H1.exec(firstContentLine);
  let head = lead;
  if (h1) {
    const after = lineEnd < 0 ? content.length : lineEnd + 1;
    head = content.slice(0, after) + /^(?:[ \t]*\r?\n)*/.exec(content.slice(after))![0];
  }
  const body = content.slice(head.length);
  const str = (key: string) => (typeof data[key] === 'string' ? (data[key] as string) : '');
  const related = Array.isArray(data.related) ? data.related.filter((item): item is string => typeof item === 'string' && safeRel(item)) : [];
  return {
    type: typeOf(data.type, rel, agentSegment),
    title: (h1?.[1] ?? str('title')).trim() || titleFromName(rel),
    summary: str('summary').trim().slice(0, MEMORY_LIMITS.summary_chars) || firstLine(body),
    excerpt: excerptOf(body),
    body,
    sources: sourcesOf(data.sources),
    related,
    updatedBy: authorFromFrontMatter(data.updated_by),
    updatedAt: str('updated_at') && !Number.isNaN(Date.parse(str('updated_at'))) ? new Date(str('updated_at')).toISOString() : null,
    split,
    head,
  };
}

/** Front-matter `updated_at` trails a later edit by at most this: a file changed after it was set is read by its mtime and commit. */
const FRESH_MS = 60_000;

/**
 * When and by whom: front-matter `updated_at` while it is fresh, else the file mtime. The author is
 * front-matter `updated_by`, else `system`: an agent's `updated_at` is its own guess of the time.
 */
export function updatedOf(page: Pick<ParsedPage, 'updatedAt' | 'updatedBy'>, mtimeMs: number): { at: string; by: MemoryAuthor } {
  const at = page.updatedAt ? Date.parse(page.updatedAt) : null;
  const by = page.updatedBy ?? SYSTEM_AUTHOR;
  if (at !== null && mtimeMs - at <= FRESH_MS) return { at: page.updatedAt!, by };
  return { at: new Date(mtimeMs).toISOString(), by };
}

/** A title as a file name: lowercase ASCII words joined by `-`, at most 80 characters. */
export function slugOf(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
  return slug || 'page';
}

// ─── Caps ───────────────────────────────────────────────────────────────────

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

/** 422 when any text holds a secret. The text itself is never logged or echoed. */
export function checkSecrets(...texts: string[]): void {
  if (texts.some((text) => findSecret(text))) {
    throw new MemoryError(422, 'secret_detected', 'That looks like a secret. Keep secrets in Secrets, not in memory.');
  }
}

function checkBody(body: string): void {
  if (bytes(body) > MEMORY_LIMITS.body_bytes) {
    throw new MemoryError(413, 'page_too_large', `A page holds at most ${MEMORY_LIMITS.body_bytes} bytes. Split it into two pages.`);
  }
}

// ─── Reading a layer ────────────────────────────────────────────────────────

export interface PageFile {
  rel: string;
  path: string;
  mtime: number;
  size: number;
}

export const agentSegmentOf = (layer: Pick<Layer, 'root' | 'agentFolder'>) => (layer.agentFolder ? layer.agentFolder.slice(layer.root.length + 1) : null);

/**
 * The layer's page files, the DM agent folder first, then newest first; and
 * how many other files (not pages, not hidden) the folder holds.
 */
export async function layerFiles(layer: Layer): Promise<{ pages: PageFile[]; otherFiles: number }> {
  const entries = await volumeOps().list(layer.drive, layer.root);
  const pages: PageFile[] = [];
  let otherFiles = 0;
  for (const entry of entries) {
    if (entry.type !== 'file' || !pathWithinFolder(entry.path, layer.root) || entry.path === layer.root) continue;
    if (layer.skip.some((folder) => pathWithinFolder(entry.path, folder))) continue;
    const rel = entry.path.slice(layer.root.length + 1);
    if (isPageRel(rel)) pages.push({ rel, path: entry.path, mtime: Number(entry.mtime), size: Number(entry.size) });
    // Conflict copies are the Files page's to show (it names them); hidden files are nobody's.
    else if (!rel.split('/').some((part) => part.startsWith('.')) && conflictOriginal(rel) === null && !isIndexFile(rel)) otherFiles++;
  }
  const inAgent = (file: PageFile) => (layer.agentFolder && pathWithinFolder(file.path, layer.agentFolder) ? 0 : 1);
  pages.sort((a, b) => inAgent(a) - inAgent(b) || b.mtime - a.mtime || (a.rel < b.rel ? -1 : 1));
  return { pages, otherFiles };
}

const HEAD_BYTES = 4096;
const HEAD_CACHE_MAX = 5000;
// replica-local: parsed file heads by (drive, path, mtime, size); a changed file has a new key.
const heads = new Map<string, ParsedPage>();

/** Title, summary, type and front-matter of a file from its first 4 KiB (all of it when the front-matter runs longer). */
export async function headOf(layer: Layer, file: PageFile): Promise<ParsedPage> {
  const key = `${layer.drive.driveId}\n${file.path}\n${file.mtime}\n${file.size}\n${agentSegmentOf(layer) ?? ''}`;
  const hit = heads.get(key);
  if (hit) {
    heads.delete(key);
    heads.set(key, hit);
    return hit;
  }
  const partial = file.size > HEAD_BYTES;
  let read = await volumeOps().read(layer.drive, file.path, partial ? { headBytes: HEAD_BYTES } : undefined);
  if (partial && read && read.text.startsWith('---') && splitFrontMatter(read.text).entries === null) {
    read = await volumeOps().read(layer.drive, file.path);
  }
  const parsed = parsePage(read?.text ?? '', file.rel, agentSegmentOf(layer));
  heads.set(key, parsed);
  if (heads.size > HEAD_CACHE_MAX) heads.delete(heads.keys().next().value!);
  return parsed;
}

const HEAD_CONCURRENCY = 8;

export function summaryOf(layer: Layer, file: PageFile, page: ParsedPage): MemoryPageSummary {
  const updated = updatedOf(page, file.mtime);
  return {
    page_id: pageIdOf(layer.key, file.rel),
    layer_id: layer.key,
    type: page.type,
    title: page.title,
    summary: page.summary,
    excerpt: page.excerpt,
    updated_at: updated.at,
    updated_by: updated.by,
    path: file.path,
  };
}

/** The pages of a layer, newest first, at most `MEMORY_LIMITS.pages_per_layer` (`truncated` past it). */
export async function listPages(layer: Layer, filter: { type?: MemoryPageType } = {}): Promise<{ pages: MemoryPageSummary[]; truncated: boolean }> {
  const { pages: files } = await layerFiles(layer);
  const listed = files.slice(0, MEMORY_LIMITS.pages_per_layer);
  const summaries = await mapWithConcurrency(listed, HEAD_CONCURRENCY, async (file) => summaryOf(layer, file, await headOf(layer, file)));
  return {
    pages: filter.type ? summaries.filter((page) => page.type === filter.type) : summaries,
    truncated: files.length > listed.length,
  };
}

export async function layerView(layer: Layer): Promise<MemoryLayer> {
  const { pages: files, otherFiles } = await layerFiles(layer);
  const counts = { people: 0, decisions: 0, workstreams: 0, playbooks: 0, note: 0, other: 0 };
  const listed = files.slice(0, MEMORY_LIMITS.pages_per_layer);
  for (const page of await mapWithConcurrency(listed, HEAD_CONCURRENCY, (file) => headOf(layer, file))) counts[page.type]++;
  return {
    layer_id: layer.key,
    scope: layer.scope,
    space_id: layer.spaceId,
    name: layer.name,
    counts,
    read_only: layer.readOnly,
    can_write: layer.canWrite,
    folder: layer.root,
    agent_folder: layer.agentFolder,
    drive_id: layer.drive.driveId,
    other_files: otherFiles,
  };
}

/** A page path of the layer: 404 for a path that is not one of its pages. */
export function pagePath(layer: Layer, rel: string): string {
  const path = `${layer.root}/${rel}`;
  if (!safeRel(rel) || !isPageRel(rel) || layer.skip.some((folder) => pathWithinFolder(path, folder))) throw notFound();
  return path;
}

export async function getPage(layer: Layer, rel: string): Promise<MemoryPage> {
  const path = pagePath(layer, rel);
  const stat = await volumeOps().stat(layer.drive, path);
  if (!stat || stat.type !== 'file') throw notFound();
  if (stat.size > MEMORY_LIMITS.body_bytes + HEAD_BYTES) {
    throw new MemoryError(413, 'page_too_large', 'This file is too large to open here. Open it in Files.', { path });
  }
  const read = await volumeOps().read(layer.drive, path);
  if (!read) throw notFound();
  const page = parsePage(read.text, rel, agentSegmentOf(layer));
  return pageOf(layer, { rel, path, mtime: Number(stat.mtime), size: Number(stat.size) }, page, await relatedOf(layer, page.related));
}

/**
 * Related pages titled as the page list titles them (`headOf`: the `# `
 * line, else front-matter `title`, else the file name). At most
 * `MEMORY_LIMITS.related`, read 8 at a time from the head cache; a file that
 * is gone or is not a page keeps its file name.
 */
async function relatedOf(layer: Layer, rels: readonly string[]): Promise<MemoryPage['related']> {
  return mapWithConcurrency(rels.slice(0, MEMORY_LIMITS.related), HEAD_CONCURRENCY, async (rel) => {
    const named = { page_id: pageIdOf(layer.key, rel), title: titleFromName(rel) };
    const path = `${layer.root}/${rel}`;
    if (!isPageRel(rel) || layer.skip.some((folder) => pathWithinFolder(path, folder))) return named;
    const stat = await volumeOps().stat(layer.drive, path);
    if (!stat || stat.type !== 'file') return named;
    return { ...named, title: (await headOf(layer, { rel, path, mtime: Number(stat.mtime), size: Number(stat.size) })).title };
  });
}

function pageOf(layer: Layer, file: PageFile, page: ParsedPage, related: MemoryPage['related']): MemoryPage {
  return {
    ...summaryOf(layer, file, page),
    body: page.body,
    sources: page.sources,
    related,
    version_no: Math.floor(file.mtime),
    can_edit: layer.canWrite,
    can_delete: layer.canWrite,
  };
}

// ─── Writing ────────────────────────────────────────────────────────────────

const conflictOn = (error: unknown) => error instanceof DriveStorageError && error.status === 409;

/** The front-matter every UI write stamps: who and when. */
const stamp = (author: string) => ({ updated_by: author, updated_at: new Date().toISOString() });

/** Create a page as `<type>/<slug>.md` (`other`: `<slug>.md`); a DM page goes in the agent folder unless `agent_folder: false`. Returns its relative path. */
export async function createPage(layer: Layer, author: string, input: MemoryPageCreateInput): Promise<string> {
  assertWrites(layer);
  const body = input.body ?? '';
  checkBody(body);
  checkSecrets(input.title, input.summary ?? '', body);
  const related = (input.related ?? []).map((id) => {
    const ref = decodePageId(id);
    if (!ref || ref.key !== layer.key) throw new MemoryError(400, 'invalid_input', 'related: page ids of this layer only.');
    return ref.rel;
  });
  const base = layer.agentFolder && input.agent_folder !== false ? layer.agentFolder : layer.root;
  const path = `${base}/${input.type === 'other' ? '' : `${input.type}/`}${slugOf(input.title)}.md`;
  const rel = path.slice(layer.root.length + 1);
  const entries = setFrontMatter(null, {
    ...(input.summary ? { summary: input.summary } : {}),
    ...(related.length ? { related } : {}),
    ...stamp(author),
  });
  const text = joinFrontMatter(entries, `# ${input.title.trim()}\n\n${body}${body && !body.endsWith('\n') ? '\n' : ''}`);
  try {
    await volumeOps().write(layer.drive, path, text, { overwrite: false });
  } catch (error) {
    if (conflictOn(error)) {
      throw new MemoryError(409, 'title_taken', 'A page with that title already exists.', { page_id: pageIdOf(layer.key, rel) });
    }
    throw error;
  }
  return rel;
}

/** Replace the body (the UI edits nothing else): front-matter and heading are kept, `updated_by` / `updated_at` stamped. */
export async function updatePage(layer: Layer, rel: string, author: string, input: MemoryPageUpdateInput): Promise<void> {
  assertWrites(layer);
  checkBody(input.body);
  checkSecrets(input.body);
  const path = pagePath(layer, rel);
  // Read first, then stat: a write between the two shows as a newer mtime; one after the stat fails If-Match.
  const read = await volumeOps().read(layer.drive, path);
  const stat = read && (await volumeOps().stat(layer.drive, path));
  if (!read || !stat) throw notFound();
  const conflict = () =>
    new MemoryError(409, 'version_conflict', 'This page changed since you opened it. Reload it, then save again.', { version_no: Math.floor(Number(stat.mtime)) });
  if (Math.floor(Number(stat.mtime)) !== input.base_version) throw conflict();
  const page = parsePage(read.text, rel, agentSegmentOf(layer));
  const body = input.body.length && !input.body.endsWith('\n') ? `${input.body}\n` : input.body;
  const text = joinFrontMatter(setFrontMatter(page.split.entries, stamp(author)), page.head + body);
  try {
    await volumeOps().write(layer.drive, path, text, { overwrite: true, ...(read.etag ? { ifMatch: read.etag } : {}) });
  } catch (error) {
    if (conflictOn(error)) throw conflict();
    throw error;
  }
}

/** Delete the file for good (a Drive delete). */
export async function deletePage(layer: Layer, rel: string): Promise<void> {
  assertWrites(layer);
  const path = pagePath(layer, rel);
  if (!(await volumeOps().stat(layer.drive, path))) throw notFound();
  await volumeOps().remove(layer.drive, path);
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * The Remember box: one line appended to the layer's `Notes.md` (a DM's: in
 * the agent folder), `- <text> — <name>, <YYYY-MM-DD>[ (from <thread>)]`.
 * Agents file the lines into topic files and delete them. Returns the relative path.
 */
export async function addNote(layer: Layer, author: string, input: MemoryNoteInput, threadLabel: string | null, now = new Date()): Promise<string> {
  assertWrites(layer);
  checkSecrets(input.text);
  const path = `${layer.agentFolder ?? layer.root}/Notes.md`;
  const line = `- ${oneLine(input.text)} — ${oneLine(author)}, ${now.toISOString().slice(0, 10)}${threadLabel ? ` (from ${oneLine(threadLabel)})` : ''}`;
  // One retry: another note landed between the read and the write.
  for (let attempt = 0; ; attempt++) {
    const read = await volumeOps().read(layer.drive, path);
    const text = read ? `${read.text.replace(/\s*$/, '')}\n${line}\n` : `# Notes\n\n${line}\n`;
    checkBody(text);
    try {
      await volumeOps().write(layer.drive, path, text, read ? { overwrite: true, ...(read.etag ? { ifMatch: read.etag } : {}) } : { overwrite: false });
      return path.slice(layer.root.length + 1);
    } catch (error) {
      if (!conflictOn(error) || attempt > 0) throw error;
    }
  }
}
