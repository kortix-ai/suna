/**
 * The files a session produced — the list behind the composer's "Recent files"
 * sheet. Mirrors web's Outputs card: `deriveOutputs` (`action-panel/shared/
 * derive-panels.ts`) + `output-priority.ts` + `latest-run.ts`. Same rules:
 *
 * - a file exists once its call completed; failed, running and pending calls
 *   list nothing, and a file the agent only read is not an output
 * - sources: write / edit / morph_edit, every file of an `apply_patch`
 *   (deletions skipped), every item of a `show`, and image / video /
 *   presentation generation
 * - one row per file (workspace-relative key); the later call wins
 * - order: the latest run first, then what the user came for (shown, PDF,
 *   spreadsheet, document, deck, page, image, media) before source files
 *
 * Mobile difference: a row needs a sandbox path — it is opened or mentioned by
 * path — so a shown URL (web's "app" output) and a pathless artifact are left
 * out. No React, no React Native.
 */
import {
  createArtifactKind,
  familyForTool,
  isToolPart,
  normalizeActivityToolName,
  toWorkspaceRelative,
  type ToolPart,
} from '@kortix/sdk';

import type { MessageWithParts } from '@/lib/opencode/types';
import { partInput, partMetadata } from './tool-part-accessors';
import { parseImageOutput, parseVideoOutput } from './tools/web-media';
import { parseShowItems } from './tools/web-show';

export type SessionFileKind = 'file' | 'image' | 'video' | 'presentation';

export interface SessionFile {
  /** Workspace-relative path: one per real file. */
  key: string;
  callID: string;
  /** File name, the row's label. */
  name: string;
  path: string;
  kind: SessionFileKind;
  /** The title the agent gave it in a `show`. */
  title?: string;
  /** The agent handed it over with `show`. */
  shown: boolean;
  /** Produced in the latest run: first time, or again. */
  fresh?: 'new' | 'updated';
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'heic', 'bmp']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'avi', 'mkv']);
const MEDIA_EXT = new Set([...VIDEO_EXT, 'mp3', 'wav', 'm4a', 'ogg']);
const DECK_EXT = new Set(['pptx', 'ppt', 'key']);

/** Lower sorts first (web's `RANK_BY_EXT`). */
const RANK_BY_EXT: Record<string, number> = {
  pdf: 0,
  xlsx: 1,
  xls: 1,
  csv: 2,
  tsv: 2,
  docx: 3,
  doc: 3,
  pptx: 4,
  ppt: 4,
  key: 4,
  html: 5,
  htm: 5,
};
const RANK_IMAGE = 6;
const RANK_MEDIA = 7;
const RANK_OTHER = 8;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function basename(path: string): string {
  const cleaned = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const index = cleaned.lastIndexOf('/');
  return index >= 0 ? cleaned.slice(index + 1) : cleaned;
}

function pathKey(path: string): string {
  return toWorkspaceRelative(path.replace(/\\/g, '/').replace(/^\.\//, ''));
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function kindOfName(name: string): SessionFileKind {
  const ext = extensionOf(name);
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (DECK_EXT.has(ext)) return 'presentation';
  return 'file';
}

type Candidate = Omit<SessionFile, 'key' | 'fresh'>;

function candidate(callID: string, path: string, extra?: Partial<Candidate>): Candidate | null {
  const name = basename(path);
  if (!path || !name) return null;
  return { callID, name, path, kind: 'file', shown: false, ...extra };
}

function patchCandidates(part: ToolPart): Candidate[] {
  const raw = partMetadata(part as never).files;
  if (!Array.isArray(raw)) return [];
  const out: Candidate[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const file = entry as { type?: unknown; filePath?: unknown; relativePath?: unknown };
    if (file.type === 'delete') continue;
    const item = candidate(part.callID, text(file.filePath) || text(file.relativePath));
    if (item) out.push(item);
  }
  return out;
}

function showCandidates(part: ToolPart): Candidate[] {
  const input = partInput(part as never);
  const items = parseShowItems(input.items);
  const payloads: Array<Record<string, unknown>> =
    items && items.length > 0 ? (items as never) : [input];
  const out: Candidate[] = [];
  for (const payload of payloads) {
    // A URL is web's "app" output: nothing to open by path.
    if (/^https?:\/\//i.test(text(payload?.url))) continue;
    const path = text(payload?.path);
    const item = candidate(part.callID, path, {
      kind: kindOfName(basename(path)),
      title: text(payload?.title) || undefined,
      shown: true,
    });
    if (item) out.push(item);
  }
  return out;
}

function completedOutput(part: ToolPart): string {
  const state = part.state as { status?: string; output?: unknown };
  return state.status === 'completed' && typeof state.output === 'string' ? state.output : '';
}

function createdCandidates(part: ToolPart): Candidate[] {
  const kind = createArtifactKind(part);
  if (!kind) return [];
  const output = completedOutput(part);
  let path = '';
  if (kind === 'image') path = parseImageOutput(output).imagePath ?? '';
  else if (kind === 'video') path = parseVideoOutput(output).videoPath ?? '';
  else {
    try {
      path = text((JSON.parse(output) as { presentation_path?: unknown }).presentation_path);
    } catch {
      path = '';
    }
  }
  const item = candidate(part.callID, path, { kind });
  return item ? [item] : [];
}

function candidatesOf(part: ToolPart): Candidate[] {
  const status = (part.state as { status?: string }).status;
  if (status === 'error' || status === 'running' || status === 'pending') return [];

  const family = familyForTool(part.tool);
  const tool = normalizeActivityToolName(part.tool);

  if (family === 'edit') {
    if (tool === 'apply_patch') return patchCandidates(part);
    const input = partInput(part as never);
    const item = candidate(part.callID, text(input.filePath ?? input.file_path ?? input.path));
    return item ? [item] : [];
  }

  if (family === 'create') {
    if (tool === 'show' || tool === 'show_user') return showCandidates(part);
    return createdCandidates(part);
  }

  return [];
}

function rank(file: Pick<SessionFile, 'name' | 'kind' | 'shown'>): number {
  if (file.shown) return 0;
  const ext = extensionOf(file.name);
  const byExt = RANK_BY_EXT[ext];
  if (byExt !== undefined) return byExt;
  if (file.kind === 'image' || IMAGE_EXT.has(ext)) return RANK_IMAGE;
  if (file.kind === 'video' || MEDIA_EXT.has(ext)) return RANK_MEDIA;
  if (file.kind === 'presentation') return RANK_BY_EXT.pptx;
  return RANK_OTHER;
}

/** Source, config, styles: the making-of. The sheet lists them under "Other files". */
export function isSupportingFile(file: Pick<SessionFile, 'name' | 'kind' | 'shown'>): boolean {
  return rank(file) === RANK_OTHER;
}

function byRank(files: SessionFile[]): SessionFile[] {
  return files
    .map((file, index) => ({ file, index, rank: rank(file) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.file);
}

export function deriveSessionFiles(messages: MessageWithParts[] | undefined): SessionFile[] {
  if (!messages || messages.length === 0) return [];

  // The latest run: every message from the last user message on.
  let latestStart = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info?.role === 'user') {
      latestStart = i;
      break;
    }
  }

  const files: SessionFile[] = [];
  const indexByKey = new Map<string, number>();

  messages.forEach((message, messageIndex) => {
    const isLatest = messageIndex >= latestStart;
    for (const part of message.parts ?? []) {
      if (!isToolPart(part as never)) continue;
      for (const item of candidatesOf(part as unknown as ToolPart)) {
        const key = pathKey(item.path);
        const existing = indexByKey.get(key);
        if (existing === undefined) {
          indexByKey.set(key, files.length);
          files.push({ ...item, key, ...(isLatest ? { fresh: 'new' as const } : {}) });
        } else {
          files[existing] = { ...item, key, ...(isLatest ? { fresh: 'updated' as const } : {}) };
        }
      }
    }
  });

  return [...byRank(files.filter((f) => f.fresh)), ...byRank(files.filter((f) => !f.fresh))];
}

/** The kind a person recognizes (web's `deliverableKindLabel`). Never an extension. */
export function sessionFileKindLabel(file: Pick<SessionFile, 'name' | 'kind'>): string {
  if (file.kind === 'presentation') return 'Slides';
  if (file.kind === 'video') return 'Video';
  const ext = extensionOf(file.name);
  if (file.kind === 'image' || IMAGE_EXT.has(ext)) return 'Image';
  if (ext === 'pdf') return 'PDF';
  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv' || ext === 'tsv') return 'Spreadsheet';
  if (ext === 'docx' || ext === 'doc') return 'Document';
  if (DECK_EXT.has(ext)) return 'Slides';
  if (ext === 'html' || ext === 'htm') return 'Web page';
  if (MEDIA_EXT.has(ext)) return 'Video';
  return 'File';
}

/** Search: name, title, path and kind label, case-insensitive substring. */
export function filterSessionFiles(files: SessionFile[], query: string): SessionFile[] {
  const q = query.trim().toLowerCase();
  if (!q) return files;
  return files.filter((file) =>
    [file.name, file.title ?? '', file.path, sessionFileKindLabel(file)]
      .join('\n')
      .toLowerCase()
      .includes(q)
  );
}

/** The `@` mention text for a file: its workspace-relative path, as the `@` picker inserts it. */
export function sessionFileMentionLabel(path: string): string {
  return pathKey(path);
}

/** The draft with `@label ` added at its end. Unchanged when it already mentions the file. */
export function appendFileMention(draft: string, label: string): string {
  if (draft.includes(`@${label}`)) return draft;
  const separator = draft.length === 0 || /\s$/.test(draft) ? '' : ' ';
  return `${draft}${separator}@${label} `;
}

/** File types the preview sheet does not render: it fetches nothing and offers Download. */
const NO_INLINE_PREVIEW_EXT = new Set([
  // documents, decks, sheets
  'pdf',
  'doc',
  'docx',
  'odt',
  'rtf',
  'ppt',
  'pptx',
  'key',
  'odp',
  'xls',
  'xlsx',
  'ods',
  // archives and binaries
  'zip',
  'tar',
  'gz',
  'tgz',
  'rar',
  '7z',
  'exe',
  'dmg',
  'pkg',
  'deb',
  'rpm',
  // audio and video
  ...MEDIA_EXT,
  'm4v',
  'ogv',
  'aac',
  'flac',
  'opus',
]);

/**
 * Whether the preview sheet renders the file (text, code, markdown, a page,
 * CSV, JSON, an image). A PDF, an Office file, an archive or media is never
 * fetched there (Jay, 2026-09-22): the sheet shows its file card and Download.
 */
export function previewsInline(name: string): boolean {
  return !NO_INLINE_PREVIEW_EXT.has(extensionOf(name));
}
