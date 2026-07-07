'use client';

import { BetterCodeBlock } from '@/components/ui/better-code-block';
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
  ToolOutputFallback,
  ToolRunningContext,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { getDirectory, getFilename } from '@/ui';
import { useTranslations } from 'next-intl';
import { useContext } from 'react';

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
  const filename = getFilename(filePath) || '';
  const directory = filePath ? getDirectory(filePath) : undefined;
  const ext = filename.split('.').pop() || '';
  const diagnostics = getToolDiagnostics(part, filePath);

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
  const { openPreview } = useFilePreviewStore();

  return (
    <BasicTool
      trigger={{
        title: 'Edit',
        subtitle: filename || (isStalePending ? 'Working...' : undefined),
        args: directory ? [directory] : undefined,
      }}
      onSubtitleClick={filePath ? () => openPreview(filePath) : undefined}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
      className="overflow-hidden p-0"
    >
      {isError ? (
        <ToolOutputFallback output={output} toolName="edit" />
      ) : hasDiff ? (
        <div data-scrollable className="max-h-96 overflow-auto">
          <InlineDiffView oldValue={before} newValue={after} filename={filename} />
        </div>
      ) : codeEdit ? (
        <div className="bg-card">
          {morphInstructions && (
            <div className="text-muted-foreground px-3 pt-2 text-xs italic">
              {morphInstructions}
            </div>
          )}
          <BetterCodeBlock
            code={codeEdit}
            language={ext}
            showBackgroundColors={false}
            border={false}
            className="p-0"
          />
        </div>
      ) : isStalePending ? (
        <TextShimmer>
          {tHardcodedUi.raw('componentsSessionToolRenderers.line2853JsxTextWaitingForFileContent')}
        </TextShimmer>
      ) : null}
      <DiagnosticsDisplay diagnostics={diagnostics} filePath={filePath} />
    </BasicTool>
  );
}
ToolRegistry.register('edit', EditTool);
ToolRegistry.register('morph_edit', EditTool);
