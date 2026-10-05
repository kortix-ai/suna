/**
 * The change-request diff, as pixels only.
 *
 * `GET /projects/:id/change-requests/:crId/diff` returns BOTH a per-file list
 * (`files: ProjectCommitFile[]`) and one combined unified patch (`patch`).
 * OpenTUI's `<diff>` takes exactly one unified-diff string
 * (`docs/opentui-api-reference.md` §4.10), so the combined patch is split back
 * into per-file patches here and `n`/`p` step through them — the same split
 * `apps/web/src/features/changes/change-vocabulary.ts` does with
 * `splitUnifiedPatch`.
 *
 * Scrolling: `<diff>` has no scroll offset of its own, so it sits inside a
 * `<scrollbox>` at its full content height and the box is scrolled through its
 * ref. The height is the patch's own line count, which is exact for the unified
 * view and an upper bound for the split view (side-by-side never adds rows).
 */

import type { DiffRenderable, ScrollBoxRenderable } from '@opentui/core';
import { useEffect, useRef } from 'react';

import { theme } from '../../theme.ts';
import { layoutRow } from '../../ui/index.ts';

/** The two modes `<diff>` accepts, as its own literal union. */
export type DiffViewMode = 'unified' | 'split';

/** One file's slice of a combined unified patch. */
export interface DiffFile {
  /** The post-image path (`b/…`), or the pre-image path for a deletion. */
  path: string;
  patch: string;
  additions: number;
  deletions: number;
}

/** Count `+`/`-` body lines, ignoring the `+++`/`---` file headers. */
function countChanges(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

/** The path a `diff --git a/x b/y` chunk is about, `+++`/`---` as the fallback. */
export function pathOfChunk(chunk: string): string {
  const git = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
  if (git?.[2]) return git[2];
  const post = chunk.match(/^\+\+\+ b\/(.+)$/m);
  if (post?.[1] && post[1] !== 'dev/null') return post[1];
  const pre = chunk.match(/^--- a\/(.+)$/m);
  if (pre?.[1]) return pre[1];
  return '(unknown file)';
}

/**
 * Split a combined unified patch into one chunk per file.
 *
 * A patch with no `diff --git` header (a bare `--- / +++ / @@` patch, which is
 * what some tools emit) is returned as ONE file rather than dropped — the task
 * here is to render what the server sent, not to validate it.
 */
export function splitUnifiedPatch(patch: string): DiffFile[] {
  const text = patch ?? '';
  if (!text.trim()) return [];
  const chunks = text
    .split(/^(?=diff --git )/m)
    .map((chunk) => chunk.trimEnd())
    .filter((chunk) => chunk.length > 0);
  if (chunks.length === 0) return [];
  return chunks.map((chunk) => ({
    path: pathOfChunk(chunk),
    patch: chunk,
    ...countChanges(chunk),
  }));
}

/** What the diff pane is showing. */
export type DiffState =
  | { kind: 'idle' }
  | { kind: 'loading'; crId: string }
  | { kind: 'error'; crId: string; message: string }
  | {
      kind: 'ready';
      crId: string;
      title: string;
      baseRef: string;
      headRef: string;
      files: DiffFile[];
      additions: number;
      deletions: number;
    };

export interface DiffViewProps {
  state: DiffState;
  /** Which file of `files` is on screen. The screen clamps it. */
  fileIndex: number;
  mode: DiffViewMode;
  /** First visible row of the scroll box. */
  offset: number;
  width: number;
  height: number;
}

export function DiffView({ state, fileIndex, mode, offset, width, height }: DiffViewProps) {
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const diffRef = useRef<DiffRenderable>(null);
  const bodyWidth = Math.max(width - 1, 0);

  // The offset is the screen's state; the box is told about it, never the
  // other way round, so a re-render never fights the reader's position.
  useEffect(() => {
    scrollRef.current?.scrollTo({ x: 0, y: Math.max(offset, 0) });
  }, [offset]);

  if (state.kind === 'idle') {
    return <text fg={theme.faint}>Enter opens the diff.</text>;
  }
  if (state.kind === 'loading') {
    return <text fg={theme.faint}>reading the diff…</text>;
  }
  if (state.kind === 'error') {
    return <text fg={theme.danger}>{layoutRow(state.message, '', bodyWidth)}</text>;
  }

  const index = Math.min(Math.max(fileIndex, 0), Math.max(state.files.length - 1, 0));
  const file = state.files[index];
  const header = layoutRow(
    `${state.title}`,
    `+${state.additions} -${state.deletions} · ${mode}`,
    bodyWidth,
  );

  return (
    // `overflow: hidden` is load-bearing, not tidiness: without it the
    // scrollbox's rows paint over the two header lines above it (verified —
    // the first captured row read `112 sconstpstartb=o1;path`, the title and
    // the diff's first line interleaved). Same trap the transcript hit.
    <box flexDirection="column" width={width} height={height} overflow="hidden">
      {/* `flexShrink={0}` on every fixed row: the box has an explicit height
          and a `flexGrow` child, so without it flexbox shrinks these one-row
          texts to zero and they paint on top of each other (verified — row 0
          read `1/2 src/app.tse boot path`, both headers in one row). */}
      <text fg={theme.fg} flexShrink={0}>
        {header}
      </text>
      <text fg={theme.faint} flexShrink={0}>
        {layoutRow(
          file
            ? `${index + 1}/${state.files.length} ${file.path}`
            : `${state.headRef} → ${state.baseRef}`,
          file ? `+${file.additions} -${file.deletions}` : '',
          bodyWidth,
        )}
      </text>
      {/* The scrollbox takes no `width` and never forces
          `scrollbarOptions.visible`: an explicit width on the box or on the
          `<diff>` makes the content paint outside the viewport, and
          `{ visible: true }` blanks the viewport entirely in 0.5.11
          (docs/opentui-notes.md). */}
      {file ? (
        <scrollbox
          ref={scrollRef}
          scrollY
          flexGrow={1}
          contentOptions={{ flexDirection: 'column' }}
        >
          {/* No `filetype`: a diff's colors come from the renderable's own
              add/remove styling, and naming a grammar that is not one of the
              five `@opentui/core` ships offline makes it try to DOWNLOAD one on
              first paint (`docs/opentui-api-reference.md` §9.8). */}
          <diff
            ref={diffRef}
            diff={file.patch}
            view={mode}
            showLineNumbers
            height={Math.max(file.patch.split('\n').length, 1)}
          />
        </scrollbox>
      ) : (
        <text fg={theme.faint} flexShrink={0}>
          This change request has no file changes.
        </text>
      )}
      <text fg={theme.faint} flexShrink={0}>
        s unified/split · n/p file · J/K scroll · Esc list
      </text>
    </box>
  );
}
