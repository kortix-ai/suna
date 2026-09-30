/**
 * `edit` / `morph_edit`. Port of apps/web `tool/tools/edit-tool.tsx`:
 * - trigger: `PencilSimple` · Editing / Edited / Couldn't update (SDK
 *   `fileVerb`) · the filename (tap opens the file) · `+N −N` diffed from the
 *   same before/after the body renders (settled calls only, jsdiff
 *   `diffLines` counts capped at 1000 edits; none on a failed call);
 * - body: an error output → `ToolOutputFallback`; a before/after pair →
 *   `InlineDiffView` (unified, `text-[0.8rem] leading-[1.55]`, Shiki) in a
 *   `ToolResultCard`; a Morph `code_edit` → its instructions (`text-xs italic
 *   text-muted-foreground`, `mb-1.5`, indented) over a `ToolCodeCard`; a
 *   stale pending part → "No content received"; then LSP diagnostics.
 */

import { useContext, useMemo } from 'react';
import { getFilename, isErrorOutput } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import { PencilSimpleIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import {
  FILE_BODY_TEXT,
  editBodyKind,
  editSources,
  editStat,
  fileRowTitle,
  isStalePendingFile,
} from '@/lib/session/tools/files-write-edit';
import { webSpace } from '@/lib/session/user-message';
import {
  BasicTool,
  DiagnosticsDisplay,
  getToolDiagnostics,
  InlineDiffView,
  partInput,
  partMetadata,
  partOutput,
  partStatus,
  partStreamingInput,
  ToolCodeCard,
  ToolOutputFallback,
  ToolResultCard,
  ToolRunningContext,
  useToolIndent,
  useToolNavigation,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { TURN_SPACE, TURN_TYPE, monoFont, muted, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

export function EditTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const running = useContext(ToolRunningContext);
  const indent = useToolIndent();
  const { openFile } = useToolNavigation();
  const input = partInput(part);
  const streamingInput = partStreamingInput(part);
  const metadata = partMetadata(part);
  const status = partStatus(part);
  const { filePath, before, after, codeEdit, morphInstructions, hasDiff } = editSources(
    input,
    streamingInput,
    metadata,
  );
  const { filename, ext } = useMemo(() => {
    const name = getFilename(filePath) || '';
    return { filename: name, ext: name.split('.').pop() || '' };
  }, [filePath]);
  const diagnostics = useMemo(() => getToolDiagnostics(part, filePath), [part, filePath]);
  const isStalePending = isStalePendingFile({ running, filename, status });
  const output = partOutput(part);
  const isError = status === 'completed' && isErrorOutput(output);
  const diffCounts = useMemo(() => editStat({ status, hasDiff, before, after }), [status, hasDiff, before, after]);
  const kind = editBodyKind({ isError, hasDiff, codeEdit, isStalePending });

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={PencilSimpleIcon}
      trigger={{
        title: fileRowTitle('edit', { running, isError }),
        subtitle: filename || undefined,
        stat: isError ? undefined : diffCounts,
      }}
      onSubtitleClick={filePath ? () => openFile(filePath) : undefined}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {kind === 'error' ? (
        <ToolOutputFallback output={output} toolName="edit" />
      ) : kind === 'diff' ? (
        <ToolResultCard>
          <InlineDiffView oldValue={before} newValue={after} filename={filename} />
        </ToolResultCard>
      ) : kind === 'morph' ? (
        <>
          {morphInstructions ? (
            <Text
              variant="muted"
              style={[
                TURN_TYPE.xs,
                {
                  marginBottom: TURN_SPACE.gap1_5,
                  marginTop: indent ? TURN_SPACE.gap1_5 : 0,
                  marginLeft: indent,
                  fontStyle: 'italic',
                  color: palette.mutedForeground,
                },
              ]}
            >
              {morphInstructions}
            </Text>
          ) : null}
          <ToolCodeCard code={codeEdit} language={ext} />
        </>
      ) : kind === 'stale' ? (
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
ToolRegistry.register('edit', EditTool);
ToolRegistry.register('morph_edit', EditTool);
