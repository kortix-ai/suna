'use client';

import { DiffView } from '@/components/diff/diff-view';
import { TextShimmer } from '@/components/ui/text-shimmer';
import {
  BasicTool,
  DiagnosticsDisplay,
  getToolDiagnostics,
  isErrorOutput,
  partInput,
  partMetadata,
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
import { useTranslations } from 'next-intl';
import { useCallback, useContext, useMemo } from 'react';

export function WriteTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(part);
  const streamingInput = partStreamingInput(part);
  const metadata = partMetadata(part);
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
        <ToolOutputFallback output={output} toolName="write" />
      ) : content ? (
        <ToolCodeCard code={content} language={ext} />
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
ToolRegistry.register('write', WriteTool);

interface PatchFileLite {
  filePath?: string;
  relativePath?: string;
  type?: 'add' | 'update' | 'delete' | 'move';
  patch?: string;
  diff?: string;
  before?: string;
  after?: string;
  additions?: number;
  deletions?: number;
  movePath?: string;
}

const PATCH_TYPE_STYLE: Record<
  string,
  { label: string; tone: 'success' | 'warning' | 'destructive' | 'info' }
> = {
  add: { label: 'Add', tone: 'success' },
  update: { label: 'Edit', tone: 'warning' },
  delete: { label: 'Delete', tone: 'destructive' },
  move: { label: 'Move', tone: 'info' },
};

function RawPatchDiffView({ patch }: { patch: string; filename: string }) {
  if (!patch) return null;
  return <DiffView patch={patch} layout="unified" hideFileHeader />;
}
