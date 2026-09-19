/**
 * The right-hand file viewer.
 *
 * Pixels only: it takes a `ViewerState` and a scroll offset and draws them.
 * `files-screen.tsx` owns the read and turns the SDK's `FileContent` into a
 * `ViewerState` with `toViewerState`, which is a pure function so the size,
 * truncation and binary rules are covered without a renderer.
 *
 * The viewport is sliced in this component instead of being handed to a
 * `<scrollbox>`. Slicing keeps the line-number gutter aligned with the code
 * (both render the same window), keeps a 500 KiB file from being laid out in
 * full on every keystroke, and makes the captured frame in a test a function of
 * the offset alone.
 */

import { SyntaxStyle } from '@opentui/core';

import { theme } from '../../theme.ts';
import { layoutRow } from '../../ui/index.ts';

/** Above this, only the head is rendered and the footer says so. */
export const MAX_TEXT_BYTES = 512 * 1024;

/** What the viewer is showing right now. */
export type ViewerState =
  | { kind: 'empty' }
  | { kind: 'loading'; path: string }
  | { kind: 'error'; path: string; message: string }
  | {
      kind: 'text';
      path: string;
      /** Already truncated to `MAX_TEXT_BYTES` when `truncated` is set. */
      content: string;
      bytes: number;
      truncated: boolean;
    }
  | { kind: 'binary'; path: string; bytes: number; mimeType?: string };

/**
 * One `SyntaxStyle` for the process. It owns a native handle, so one instance
 * is created lazily and reused — the same rule the transcript's text part
 * follows (`features/session/transcript/parts/text-part.tsx`).
 */
let syntaxStyleSingleton: SyntaxStyle | null = null;

export function viewerSyntaxStyle(): SyntaxStyle {
  if (!syntaxStyleSingleton) syntaxStyleSingleton = SyntaxStyle.create();
  return syntaxStyleSingleton;
}

/**
 * The tree-sitter filetype for a path, or `undefined` for "draw it unstyled".
 *
 * Only the five grammars `@opentui/core` 0.5.11 ships on disk are mapped
 * (`docs/opentui-api-reference.md` §9.8: `javascript`, `typescript`,
 * `typescriptreact`, `markdown`, `zig`). Naming any other filetype makes the
 * renderable try to DOWNLOAD a grammar on first paint, which in a terminal is
 * a stall on a cold cache and a silent no-op offline. Unmapped files still
 * render: `CodeOptions.drawUnstyledText` defaults to true.
 */
export function filetypeFor(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1) : '';
  switch (extension) {
    case 'ts':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'tsx':
      return 'typescriptreact';
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return 'javascript';
    case 'md':
    case 'mdx':
    case 'markdown':
      return 'markdown';
    case 'zig':
      return 'zig';
    default:
      return undefined;
  }
}

/** Extensions the daemon may return as text but that are not worth painting. */
const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'svg',
  'avif',
  'tiff',
]);

export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

/** `1.4 KiB`, `912 B`. One decimal, because a terminal column is expensive. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}

/** Decoded byte length of a base64 payload, padding accounted for. */
export function base64Bytes(base64: string): number {
  const clean = base64.replace(/\s/g, '');
  if (!clean) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(Math.floor((clean.length * 3) / 4) - padding, 0);
}

/** The subset of the SDK's `FileContent` the viewer reads. */
export interface ReadResult {
  type?: 'text' | 'binary';
  content?: string;
  encoding?: 'base64';
  mimeType?: string;
}

/**
 * Turn one `readFile` response into what the viewer draws.
 *
 * Three rules, in order: a base64/binary payload or an image extension is a
 * placeholder line with its size; text over `MAX_TEXT_BYTES` is cut at the last
 * whole line inside the budget and flagged; anything else is shown whole.
 */
export function toViewerState(path: string, result: ReadResult): ViewerState {
  const raw = result.content ?? '';
  if (result.encoding === 'base64' || result.type === 'binary' || isImagePath(path)) {
    const bytes =
      result.encoding === 'base64' ? base64Bytes(raw) : new TextEncoder().encode(raw).length;
    return { kind: 'binary', path, bytes, mimeType: result.mimeType };
  }
  const encoded = new TextEncoder().encode(raw);
  if (encoded.length <= MAX_TEXT_BYTES) {
    return { kind: 'text', path, content: raw, bytes: encoded.length, truncated: false };
  }
  const head = new TextDecoder().decode(encoded.slice(0, MAX_TEXT_BYTES));
  // Cut at the last newline so the tail is never half a line (and never half a
  // multi-byte character, which the slice above can produce).
  const lastBreak = head.lastIndexOf('\n');
  const content = lastBreak > 0 ? head.slice(0, lastBreak) : head;
  return { kind: 'text', path, content, bytes: encoded.length, truncated: true };
}

/** The viewer's lines for a state — `[]` for anything that is not text. */
export function viewerLines(state: ViewerState): string[] {
  if (state.kind !== 'text') return [];
  // A trailing newline is a line terminator, not an empty last line.
  const body = state.content.endsWith('\n') ? state.content.slice(0, -1) : state.content;
  return body.length === 0 ? [''] : body.split('\n');
}

export interface FileViewerProps {
  state: ViewerState;
  /** First visible line, zero-based. The screen clamps it. */
  offset: number;
  width: number;
  height: number;
  focused?: boolean;
}

export function FileViewer({ state, offset, width, height, focused = false }: FileViewerProps) {
  const bodyWidth = Math.max(width - 1, 0);

  if (state.kind === 'empty') {
    return <text fg={theme.faint}>Select a file. Enter opens it.</text>;
  }
  if (state.kind === 'loading') {
    return <text fg={theme.faint}>{layoutRow(`reading ${state.path}…`, '', bodyWidth)}</text>;
  }
  if (state.kind === 'error') {
    return (
      <box flexDirection="column" width={width}>
        <text fg={theme.fg}>{layoutRow(state.path, '', bodyWidth)}</text>
        <text fg={theme.danger}>{layoutRow(state.message, '', bodyWidth)}</text>
      </box>
    );
  }
  if (state.kind === 'binary') {
    return (
      <box flexDirection="column" width={width}>
        <text fg={theme.fg}>{layoutRow(state.path, '', bodyWidth)}</text>
        <text fg={theme.faint}>
          {layoutRow(
            `${isImagePath(state.path) ? 'image' : 'binary'} · ${formatBytes(state.bytes)}${
              state.mimeType ? ` · ${state.mimeType}` : ''
            } · not rendered in a terminal`,
            '',
            bodyWidth,
          )}
        </text>
      </box>
    );
  }

  const lines = viewerLines(state);
  // One row for the header, one for the footer.
  const rows = Math.max(height - 2, 1);
  const start = Math.min(Math.max(offset, 0), Math.max(lines.length - 1, 0));
  const visible = lines.slice(start, start + rows);
  const gutterWidth = String(lines.length).length;
  const filetype = filetypeFor(state.path);
  const footer = `${start + 1}-${start + visible.length}/${lines.length} · ${formatBytes(state.bytes)}${
    state.truncated ? ` · truncated at ${formatBytes(MAX_TEXT_BYTES)}` : ''
  }`;

  return (
    <box flexDirection="column" width={width} height={height}>
      <text fg={focused ? theme.fg : theme.dim}>
        {layoutRow(state.path, filetype ?? 'text', bodyWidth)}
      </text>
      <box flexDirection="row" width={width} height={rows}>
        {/* The gutter is ONE text whose content carries the newlines, so it
            stays row-for-row aligned with the `<code>` beside it and needs no
            index-keyed array of one-row elements. */}
        <text fg={theme.faint} width={gutterWidth + 1} flexShrink={0}>
          {visible
            .map((_line, index) => String(start + index + 1).padStart(gutterWidth))
            .join('\n')}
        </text>
        {/* `conceal` defaults to TRUE (`Code.d.ts:60`), which HIDES markup the
            grammar marks concealable — a markdown `# ` heading prefix renders
            as nothing. A file viewer shows the file, byte for byte, so it is
            off here. Verified: with the default, `# Kortix` painted `Kortix`. */}
        <code
          content={visible.join('\n')}
          filetype={filetype}
          syntaxStyle={viewerSyntaxStyle()}
          conceal={false}
          // A wrapped long line pushes every following line down while the
          // gutter beside it does not move, so the numbers stop matching the
          // code (verified live on an 8 KiB kortix.yaml). A file viewer reads
          // like `less -S`: one screen line per file line, clipped at the right
          // edge. Horizontal scrolling is not implemented.
          wrapMode="none"
          flexGrow={1}
          height={rows}
        />
      </box>
      <text fg={theme.faint}>{layoutRow(footer, '', bodyWidth)}</text>
    </box>
  );
}
