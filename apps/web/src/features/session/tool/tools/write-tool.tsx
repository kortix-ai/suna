'use client';

import {
  BasicTool,
  DiagnosticsDisplay,
  getToolDiagnostics,
  isErrorOutput,
  partInput,
  partOutput,
  partStatus,
  partStreamingInput,
  ToolCodeCard,
  ToolOutputFallback,
  ToolRunningContext,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { ToolResultCard } from '@/features/session/tool/shared/result-card';
import type { ToolProps } from '@/features/session/tool/shared/types';

import { useFilePreviewStore } from '@/stores/file-preview-store';
import { getFilename } from '@/ui';
import { PencilSimpleIcon } from '@phosphor-icons/react';
import { useCallback, useContext, useMemo } from 'react';

/**
 * The stat the row reports beside the filename — a green `+42`, in the same
 * DiffStat the edit row draws, so every file row counts its change the one
 * way.
 *
 * Additions only, and honestly so: a write replaces whatever was there, and
 * nothing client-side knows the old content (the runtime supplies no
 * `filediff` for writes), so a deletions number would be an invention.
 * DiffStat drops the `−0` on its own.
 *
 * It counts the STREAMING content, so the number climbs while the file is
 * being written and settles on the final size — the closed row answers "how
 * much did this write?" without being opened. Counted with `indexOf` rather
 * than `split('\n')`: this runs on every streamed chunk of a file that can be
 * tens of kilobytes, and splitting allocates an array of every line just to
 * read its length.
 */
export function writeStat(content: string): { additions: number; deletions: number } | undefined {
  if (!content) return undefined;
  let lines = 1;
  for (let i = content.indexOf('\n'); i !== -1; i = content.indexOf('\n', i + 1)) lines++;
  return { additions: lines, deletions: 0 };
}

export function WriteTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const streamingInput = partStreamingInput(part);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const filePath = (input.filePath as string) || (streamingInput.filePath as string) || undefined;
  // Two `split()` calls — one on the path, one on the basename — allocating two
  // throwaway arrays per render, for a value that only changes when the part does.
  const filename = useMemo(() => getFilename(filePath) || '', [filePath]);
  const content = (input.content as string) || (streamingInput.content as string) || '';
  const ext = useMemo(() => filename.split('.').pop() || '', [filename]);
  const output = partOutput(part);
  // `isErrorOutput` trims the whole output and attempts a `JSON.parse` over it.
  // A written file's output is not small, and this ran on every render of the row.
  const isError = useMemo(
    () => status === 'completed' && isErrorOutput(output),
    [status, output],
  );
  const stat = useMemo(() => writeStat(content), [content]);
  // Unmemoised this ran on every frame of a COLLAPSED row: `partOutput` plus two
  // full-string `includes`, and — when the output carries `<file_diagnostics>` —
  // a global regex, a full split and a per-line regex on top.
  const diagnostics = useMemo(() => getToolDiagnostics(part, filePath), [part, filePath]);

  const isStalePending = !running && !filename && (status === 'pending' || status === 'running');

  // Field selector, not the whole store: destructuring the store subscribes this
  // row to every field in it, so opening one file preview re-rendered every write
  // row on screen.
  const openPreview = useFilePreviewStore((s) => s.openPreview);
  const handleSubtitleClick = useCallback(() => {
    if (filePath) openPreview(filePath);
  }, [filePath, openPreview]);

  return (
    <BasicTool
      icon={<PencilSimpleIcon className="size-3.5 shrink-0" />}
      trigger={{
        title: 'Write',
        subtitle: filename || undefined,
        // No stat on a failed call: the numbers would describe a file that
        // did not land.
        stat: isError ? undefined : stat,
      }}
      onSubtitleClick={filePath ? handleSubtitleClick : undefined}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
      className="overflow-hidden p-0"
    >
      {isError ? (
        <ToolOutputFallback output={output} toolName="write" />
      ) : content ? (
        <ToolCodeCard code={content} language={ext} />
      ) : isStalePending ? (
        // A stale part is DONE waiting — the run it belonged to is over. The
        // shimmer this used to draw promised content that could never arrive,
        // on every restored session, forever.
        <ToolResultCard bodyClassName="px-2 py-1.5">
          <span className="text-muted-foreground/60 text-xs">No content received</span>
        </ToolResultCard>
      ) : null}
      <DiagnosticsDisplay diagnostics={diagnostics} filePath={filePath} />
    </BasicTool>
  );
}
ToolRegistry.register('write', WriteTool);
