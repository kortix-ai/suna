'use client';

import {
  BasicTool,
  DiagnosticsDisplay,
  getToolDiagnostics,
  InlineDiffView,
  isErrorOutput,
  partInput,
  partMetadata,
  partOutput,
  partStatus,
  partStreamingInput,
  ToolCodeCard,
  ToolOutputFallback,
  ToolRunningContext,
  useToolIndent,
} from '@/features/session/tool/shared/infrastructure';
import { fileVerb, filePhase } from '@/features/session/tool/shared/file-verb';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { ToolResultCard } from '@/features/session/tool/shared/result-card';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { cn } from '@/lib/utils';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { getFilename } from '@/ui';
import { PencilSimpleIcon } from '@phosphor-icons/react';
import { diffLines } from 'diff';
import { useCallback, useContext, useMemo } from 'react';

export function EditTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const running = useContext(ToolRunningContext);
  const input = partInput(part);
  const streamingInput = partStreamingInput(part);
  const metadata = partMetadata(part);
  const status = partStatus(part);
  const filediff = metadata.filediff as Record<string, unknown> | undefined;
  const filePath =
    (input.filePath as string) ||
    (streamingInput.filePath as string) ||
    (streamingInput.target_filepath as string) ||
    undefined;
  const { filename, ext } = useMemo(() => {
    const name = getFilename(filePath) || '';
    return { filename: name, ext: name.split('.').pop() || '' };
  }, [filePath]);
  // Unmemoised this ran on every frame of a COLLAPSED row: `partOutput` plus two
  // full-string `includes`, and — when the output carries `<file_diagnostics>` —
  // a global regex, a full split and a per-line regex on top.
  const diagnostics = useMemo(() => getToolDiagnostics(part, filePath), [part, filePath]);
  const indent = useToolIndent();

  const isStalePending = !running && !filename && (status === 'pending' || status === 'running');

  const before =
    (filediff?.before as string) ??
    (input.oldString as string) ??
    (streamingInput.oldString as string) ??
    '';
  const after =
    (filediff?.after as string) ??
    (input.newString as string) ??
    (streamingInput.newString as string) ??
    '';
  const codeEdit = (input.code_edit as string) || (streamingInput.code_edit as string) || '';
  const morphInstructions =
    (input.instructions as string) || (streamingInput.instructions as string) || '';
  const hasDiff = before !== '' || after !== '';
  const output = partOutput(part);
  const isError = status === 'completed' && isErrorOutput(output);

  /**
   * `Editing` never became `Edited`. The row was a present participle for the
   * life of the transcript, so a call that finished an hour ago still claimed to
   * be mid-flight — the single biggest reason a settled session read as a
   * stalled one. See `file-verb.ts`; every other surface has reported this call
   * in the right tense for a long time.
   *
   * `morph_edit` shares this renderer and therefore this wording, which is
   * correct: the reader is told what happened to their file, not which of two
   * edit implementations the agent picked.
   */
  const title = fileVerb('edit', filePhase(running, isError));
  // Line counts for the row, from the same before/after the expanded diff
  // renders — so the closed row already answers "how big was this edit?".
  // Settled calls only: while an edit streams, `after` grows by the chunk, and
  // re-diffing a whole file per chunk is per-frame work a collapsed row must
  // not do. `maxEditLength` bails on pathological pairs (two rewritten
  // 10k-line files) — no stat beats a stalled frame; the expanded DiffView
  // still shows everything.
  const diffCounts = useMemo(() => {
    if (status !== 'completed' || !hasDiff) return undefined;
    const changes = diffLines(before, after, { maxEditLength: 1000 });
    if (!changes) return undefined;
    let additions = 0;
    let deletions = 0;
    for (const change of changes) {
      if (change.added) additions += change.count;
      else if (change.removed) deletions += change.count;
    }
    return { additions, deletions };
  }, [status, hasDiff, before, after]);
  // Selector, not the whole store: an unselected `useFilePreviewStore()` makes
  // every edit row a subscriber of `isOpen` / `filePath` / `lineNumber`, so
  // opening ONE preview re-rendered every edit row in the session.
  const openPreview = useFilePreviewStore((s) => s.openPreview);
  const handleSubtitleClick = useCallback(() => {
    if (filePath) openPreview(filePath);
  }, [filePath, openPreview]);

  return (
    <BasicTool
      icon={<PencilSimpleIcon className="size-3.5 shrink-0" />}
      trigger={{
        title,
        subtitle: filename || undefined,
        // No stat on a failed call: the numbers would describe an edit that
        // did not land.
        stat: isError ? undefined : diffCounts,
      }}
      onSubtitleClick={filePath ? handleSubtitleClick : undefined}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
      className="overflow-hidden p-0"
    >
      {isError ? (
        <ToolOutputFallback output={output} toolName="edit" />
      ) : hasDiff ? (
        <ToolResultCard>
          <InlineDiffView oldValue={before} newValue={after} filename={filename} />
        </ToolResultCard>
      ) : codeEdit ? (
        <>
          {/* Morph's instructions describe the edit the card below carries, so
              they share its indent rather than sitting flush with the row. */}
          {morphInstructions && (
            // `mb-1.5` carries the gap to the card BELOW, which no longer draws
            // a top margin on the panel. Inline the two collapse to the same
            // 6px this line has always had under it.
            <div
              className={cn(
                'text-muted-foreground mb-1.5 text-xs italic',
                indent && 'mt-1.5',
                indent,
              )}
            >
              {morphInstructions}
            </div>
          )}
          <ToolCodeCard code={codeEdit} language={ext} />
        </>
      ) : isStalePending ? (
        // The same statement `write` makes, in the same words, because it is the
        // same situation: a part that is DONE waiting — the run it belonged to
        // is over. This row used to shimmer "Waiting for file content" instead,
        // which is a promise, and on a restored session it was a promise the
        // transcript could never keep — the animation ran forever over a diff
        // that was never going to arrive. `write-tool.tsx` dropped that shimmer;
        // `edit` kept it, so one situation had two answers.
        <ToolResultCard bodyClassName="px-2 py-1.5">
          <span className="text-muted-foreground/60 text-xs">No content received</span>
        </ToolResultCard>
      ) : null}
      <DiagnosticsDisplay diagnostics={diagnostics} filePath={filePath} />
    </BasicTool>
  );
}
ToolRegistry.register('edit', EditTool);
ToolRegistry.register('morph_edit', EditTool);
