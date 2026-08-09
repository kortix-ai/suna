'use client';

import { TextShimmer } from '@/components/ui/text-shimmer';
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
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { ToolResultCard } from '@/features/session/tool/shared/result-card';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { cn } from '@/lib/utils';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { getFilename } from '@/ui';
import { PencilSimpleIcon } from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { useCallback, useContext, useMemo } from 'react';

export function EditTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
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
  // Selector, not the whole store: an unselected `useFilePreviewStore()` makes
  // every edit row a subscriber of `isOpen` / `filePath` / `lineNumber`, so
  // opening ONE preview re-rendered every edit row in the session.
  const openPreview = useFilePreviewStore((s) => s.openPreview);
  const handleSubtitleClick = useCallback(() => {
    if (filePath) openPreview(filePath);
  }, [filePath, openPreview]);

  return (
    <BasicTool
      icon={<PencilSimpleIcon className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: 'Editing',
        subtitle: isStalePending
          ? undefined
          : filename || (isStalePending ? 'Working...' : undefined),
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
            <div className={cn('text-muted-foreground mt-1.5 text-xs italic', indent)}>
              {morphInstructions}
            </div>
          )}
          <ToolCodeCard code={codeEdit} language={ext} />
        </>
      ) : isStalePending ? (
        <ToolResultCard bodyClassName="px-2 py-1.5">
          <TextShimmer>
            {tHardcodedUi.raw(
              'componentsSessionToolRenderers.line2853JsxTextWaitingForFileContent',
            )}
          </TextShimmer>
        </ToolResultCard>
      ) : null}
      <DiagnosticsDisplay diagnostics={diagnostics} filePath={filePath} />
    </BasicTool>
  );
}
ToolRegistry.register('edit', EditTool);
ToolRegistry.register('morph_edit', EditTool);
