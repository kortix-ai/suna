'use client';

import { DiffView } from '@/components/diff/diff-view';
import { BetterCodeBlock } from '@/components/ui/better-code-block';
import { TextShimmer } from '@/components/ui/text-shimmer';
import {
  BasicTool,
  DiagnosticsDisplay,
  getToolDiagnostics,
  partInput,
  partMetadata,
  partStatus,
  partStreamingInput,
  ToolRunningContext,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';

import { useFilePreviewStore } from '@/stores/file-preview-store';
import { getDirectory, getFilename } from '@/ui';
import { useTranslations } from 'next-intl';
import { useContext } from 'react';

export function WriteTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(part);
  const streamingInput = partStreamingInput(part);
  const metadata = partMetadata(part);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const filePath = (input.filePath as string) || (streamingInput.filePath as string) || undefined;
  const filename = getFilename(filePath) || '';
  const directory = filePath ? getDirectory(filePath) : undefined;
  const content = (input.content as string) || (streamingInput.content as string) || '';
  const ext = filename.split('.').pop() || '';
  const diagnostics = getToolDiagnostics(part, filePath);

  const isStalePending = !running && !filename && (status === 'pending' || status === 'running');

  const { openPreview } = useFilePreviewStore();

  return (
    <BasicTool
      trigger={{
        title: 'Write',
        subtitle: filename || (isStalePending ? 'Working...' : undefined),
        args: directory ? [directory] : undefined,
      }}
      onSubtitleClick={filePath ? () => openPreview(filePath) : undefined}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
      className="overflow-hidden p-0"
    >
      {content ? (
        <div className="bg-card">
          <BetterCodeBlock
            code={content}
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
