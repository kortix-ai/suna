/**
 * Pure logic behind the memory tool renderers
 * (`components/session/tool/tools/memory-tool.tsx`, `memory-search-tool.tsx`,
 * `get-mem-tool.tsx`).
 *
 * `memoryToolTitle`, `memoryRowTarget`, `isMemoryMarkdown` and `hitPreview` are
 * apps/web's exports of the same names. `memoryToolInput` / `memoryToolBody`
 * lift web `MemoryTool`'s field resolution and body branch order out of the
 * component so the branch each command takes is testable without a renderer.
 * Copy comes from `apps/web/translations/en.json`.
 */

import { isErrorOutput, memoryRelPath, parseMemoryView } from '@kortix/sdk';
import type { ParsedMemoryEntry } from './projects-memory-entry-output';
import type { MemorySearchHitSource } from './projects-memory-search-output';

// ─── memory ──────────────────────────────────────────────────────────────────

/** The commands that CHANGE what the agent will remember. `view` is the only read. */
const MEMORY_UPDATE_COMMANDS: ReadonlySet<string> = new Set([
  'create',
  'insert',
  'str_replace',
  'rename',
  'delete',
]);

/** A write and a read are different rows; an unknown command is the bare noun. */
export function memoryToolTitle(command: string): string {
  if (MEMORY_UPDATE_COMMANDS.has(command)) return 'Memory updated';
  if (command === 'view') return 'Memory read';
  return 'Memory';
}

/**
 * The ONE file a memory row is about: the name it shows and the file it opens,
 * from one call so they cannot disagree. A rename is about its destination.
 */
export function memoryRowTarget(
  command: string,
  path: string,
  newPath: string,
): { openPath: string; subtitle: string | undefined } {
  const openPath = command === 'rename' ? newPath || path : path;
  const relative = memoryRelPath(openPath);
  return { openPath, subtitle: relative && relative !== 'memory' ? relative : undefined };
}

/** `.md` / `.mdx` memory files render as documents; everything else is source. */
export function isMemoryMarkdown(ext: string): boolean {
  return ext === 'md' || ext === 'mdx';
}

export interface MemoryToolInput {
  command: string;
  /** `path`, else `old_path` (a rename's source). */
  path: string;
  oldPath: string;
  newPath: string;
  fileText: string;
  oldStr: string;
  newStr: string;
  insertText: string;
  insertLine: unknown;
  /** The body's name for the file (a rename's diff/label is its source). */
  relPath: string;
  ext: string;
  openPath: string;
  subtitle: string | undefined;
  /** The subtitle opens `openPath`: a file target, and not a deleted file. */
  canOpen: boolean;
}

function s(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function memoryToolInput(
  input: Record<string, unknown>,
  streamingInput: Record<string, unknown>,
): MemoryToolInput {
  const command = s(input.command) || s(streamingInput.command);
  const path = s(input.path) || s(streamingInput.path) || s(input.old_path) || s(streamingInput.old_path);
  const newPath = s(input.new_path);
  const relPath = memoryRelPath(path);
  const ext = (relPath.split('.').pop() || 'md').toLowerCase();
  const { openPath, subtitle } = memoryRowTarget(command, path, newPath);
  // A directory listing has nothing to open; asked of `openPath`, the file the tap receives.
  const isFileTarget = command !== 'view' || /\.\w+$/.test(openPath);

  return {
    command,
    path,
    oldPath: s(input.old_path),
    newPath,
    fileText: s(input.file_text) || s(streamingInput.file_text),
    oldStr: (input.old_str as string) ?? (streamingInput.old_str as string) ?? '',
    newStr: (input.new_str as string) ?? (streamingInput.new_str as string) ?? '',
    insertText: s(input.insert_text) || s(streamingInput.insert_text),
    insertLine: input.insert_line ?? streamingInput.insert_line,
    relPath,
    ext,
    openPath,
    subtitle,
    canOpen: Boolean(openPath) && isFileTarget && command !== 'delete',
  };
}

export type MemoryToolBody =
  | { kind: 'none' }
  | { kind: 'fallback' }
  | { kind: 'error' }
  | { kind: 'empty'; message: string }
  | { kind: 'dir'; entries: { key: string; name: string; size: string }[] }
  | { kind: 'markdown'; code: string }
  | { kind: 'code'; code: string; language: string }
  | { kind: 'diff'; oldStr: string; newStr: string; filename: string }
  | { kind: 'insert'; line: string | null; text: string; language: string }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'delete'; path: string };

function documentBody(code: string, ext: string): MemoryToolBody {
  return isMemoryMarkdown(ext) ? { kind: 'markdown', code } : { kind: 'code', code, language: ext };
}

/** Web `MemoryTool`'s body, branch for branch. */
export function memoryToolBody(
  m: MemoryToolInput,
  output: string,
  status: string,
  isStreaming: boolean,
): MemoryToolBody {
  const failed =
    !!output && (/^no replacement was performed/i.test(output.trim()) || /did not appear/i.test(output));

  if (status === 'completed' && isErrorOutput(output)) return { kind: 'fallback' };

  switch (m.command) {
    case 'view': {
      const view = parseMemoryView(output, m.path);
      if (view?.type === 'dir') {
        if (view.entries.length === 0) return { kind: 'empty', message: 'Memory is empty.' };
        return {
          kind: 'dir',
          entries: view.entries.map((entry) => ({
            key: entry.path,
            name: memoryRelPath(entry.path),
            size: entry.size,
          })),
        };
      }
      if (view?.type === 'file' && view.content) return documentBody(view.content, m.ext);
      if (output) return { kind: 'fallback' };
      return { kind: 'empty', message: isStreaming ? 'Reading memory…' : 'Nothing to show.' };
    }
    case 'create':
      if (m.fileText) return documentBody(m.fileText, m.ext);
      return { kind: 'empty', message: isStreaming ? 'Writing memory…' : 'No content.' };
    case 'str_replace':
      if (failed) return { kind: 'error' };
      if (m.oldStr || m.newStr) return { kind: 'diff', oldStr: m.oldStr, newStr: m.newStr, filename: m.relPath };
      return { kind: 'empty', message: 'No changes.' };
    case 'insert':
      if (!m.insertText && m.insertLine == null) return { kind: 'empty', message: 'Nothing inserted.' };
      return {
        kind: 'insert',
        line: m.insertLine != null ? String(m.insertLine) : null,
        text: m.insertText,
        language: m.ext,
      };
    case 'rename':
      return { kind: 'rename', from: memoryRelPath(m.oldPath || m.path), to: memoryRelPath(m.newPath) };
    case 'delete':
      return { kind: 'delete', path: m.relPath };
    default:
      return output ? { kind: 'fallback' } : { kind: 'none' };
  }
}

// ─── memory search ───────────────────────────────────────────────────────────

/** The one line a folded hit shows in place of its body: first line, 80 chars max. */
export function hitPreview(content: string): string {
  const trimmed = content.trimStart();
  const end = trimmed.indexOf('\n');
  const line = (end === -1 ? trimmed : trimmed.slice(0, end)).trim();
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

export function memorySearchTitle(label: string): string {
  return label.toLowerCase().includes('ltm') ? 'LTM Search' : 'Memory Search';
}

export function memorySearchHitSourceLabel(source: MemorySearchHitSource): string {
  return source === 'ltm' ? 'LTM' : source === 'obs' ? 'Observation' : 'Memory';
}

/** `{count, plural, one {# result} other {# results}}`. */
export function memoryResultCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'result' : 'results'}`;
}

/** `86` + `% conf`, or `null` without a confidence. */
export function memoryConfidenceLabel(confidence: number | null): string | null {
  return confidence != null ? `${Math.round(confidence * 100)}% conf` : null;
}

// ─── get_mem ─────────────────────────────────────────────────────────────────

/**
 * The shut row names the memory: an observation's title or an LTM entry's
 * caption as the subtitle, the record id as the badge. Unparsed, the id is the
 * subtitle.
 */
export function getMemTrigger(
  input: Record<string, unknown>,
  report: ParsedMemoryEntry | null,
): { title: string; subtitle: string | undefined; badge: string | undefined } {
  const memoryId = input.id != null ? String(input.id) : '';
  const recalled = report ? (report.kind === 'observation' ? report.title : report.caption) : '';
  const idLabel = memoryId ? `#${memoryId}` : undefined;
  return { title: 'Recalled', subtitle: recalled || idLabel, badge: recalled ? idLabel : undefined };
}

export function getMemFactsLabel(count: number): string {
  return `Facts (${count})`;
}

export function getMemTagsLabel(count: number): string {
  return `Tags (${count})`;
}

export function getMemFilesReadLabel(count: number): string {
  return `Files read (${count})`;
}
