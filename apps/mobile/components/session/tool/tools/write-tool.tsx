/**
 * `write`. Port of apps/web `tool/tools/write-tool.tsx`:
 * - trigger: `PencilSimple` · Writing / Wrote / Couldn't write (SDK
 *   `fileVerb`) · the filename (tap opens the file) · a green `+N` for the
 *   written lines (`writeStat`, climbing while the content streams; none on a
 *   failed call);
 * - body: an error output → `ToolOutputFallback`; content → `ToolCodeCard`
 *   highlighted by extension; a stale pending part → "No content received"
 *   (`text-xs text-muted-foreground/60`, `px-2 py-1.5`); then LSP diagnostics.
 */

import { useContext, useMemo } from 'react';
import { getFilename, isErrorOutput } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import { PencilSimpleIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import {
  FILE_BODY_TEXT,
  fileRowTitle,
  isStalePendingFile,
  writeBodyKind,
  writeTriggerStat,
} from '@/lib/session/tools/files-write-edit';
import { webSpace } from '@/lib/session/user-message';
import {
  BasicTool,
  DiagnosticsDisplay,
  getToolDiagnostics,
  partInput,
  partOutput,
  partStatus,
  partStreamingInput,
  ToolCodeCard,
  ToolOutputFallback,
  ToolResultCard,
  ToolRunningContext,
  useToolNavigation,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { TURN_TYPE, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

export function WriteTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const running = useContext(ToolRunningContext);
  const { openFile } = useToolNavigation();
  const input = partInput(part);
  const streamingInput = partStreamingInput(part);
  const status = partStatus(part);
  const filePath = (input.filePath as string) || (streamingInput.filePath as string) || undefined;
  const filename = useMemo(() => getFilename(filePath) || '', [filePath]);
  const content = (input.content as string) || (streamingInput.content as string) || '';
  const ext = useMemo(() => filename.split('.').pop() || '', [filename]);
  const output = partOutput(part);
  const isError = useMemo(() => status === 'completed' && isErrorOutput(output), [status, output]);
  const stat = useMemo(() => writeTriggerStat({ isError, content }), [isError, content]);
  const diagnostics = useMemo(() => getToolDiagnostics(part, filePath), [part, filePath]);
  const isStalePending = isStalePendingFile({ running, filename, status });
  const kind = writeBodyKind({ isError, content, isStalePending });

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={PencilSimpleIcon}
      trigger={{
        title: fileRowTitle('write', { running, isError }),
        subtitle: filename || undefined,
        stat,
      }}
      onSubtitleClick={filePath ? () => openFile(filePath) : undefined}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {kind === 'error' ? (
        <ToolOutputFallback output={output} toolName="write" />
      ) : kind === 'code' ? (
        <ToolCodeCard code={content} language={ext} />
      ) : kind === 'stale' ? (
        // A stale part is DONE waiting — the run it belonged to is over.
        <ToolResultCard bodyStyle={{ paddingHorizontal: webSpace(2), paddingVertical: webSpace(1.5) }}>
          <Text variant="muted" style={[TURN_TYPE.xs, { color: palette.muted60 }]}>
            {FILE_BODY_TEXT.noContentReceived}
          </Text>
        </ToolResultCard>
      ) : null}
      <DiagnosticsDisplay diagnostics={diagnostics} filePath={filePath} />
    </BasicTool>
  );
}
ToolRegistry.register('write', WriteTool);
