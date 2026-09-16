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
 *
 * `WriteEditExpandedContent` below is the previous mobile renderer, still
 * imported by `tool-part-renderer.tsx`'s legacy switch.
 */

import { useContext, useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { getFilename, isErrorOutput } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import { PencilSimpleIcon } from '@/lib/icons';
import { generateLineDiff } from '@/lib/opencode/diff-utils';
import type { ToolPart } from '@/lib/opencode/types';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { getExtFromPath, stripCodeFences } from '@/lib/session/highlight-tokens';
import {
  FILE_BODY_TEXT,
  editBodyKind,
  editSources,
  editStat,
  fileRowTitle,
  isStalePendingFile,
} from '@/lib/session/tools/files-write-edit';
import { webSpace } from '@/lib/session/user-message';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { DiffCodeLine } from '../shared/diff-code-line';
import { HighlightedCode as LegacyHighlightedCode } from '../shared/highlighted-code';
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
import { getToolInput } from '../shared/tool-part';
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

// ─── Legacy (tool-part-renderer.tsx switch) ──────────────────────────────────

export function WriteEditExpandedContent({ tool, isDark }: { tool: ToolPart; isDark: boolean }) {
  const input = getToolInput(tool);
  const content = input.content || input.newString || '';
  const filePath = input.filePath || '';
  const ext = getExtFromPath(filePath);

  // For edit, show unified diff
  const oldString = input.oldString;
  const newString = input.newString;
  const isEdit = tool.tool === 'edit' || tool.tool === 'morph_edit';

  const lineDiff = useMemo(() => {
    if (isEdit && oldString && newString) {
      return generateLineDiff(oldString, newString);
    }
    return null;
  }, [isEdit, oldString, newString]);

  const fs = 10.5;
  const lh = 16;

  return (
    <View>
      {lineDiff ? (
        <ScrollView style={{ maxHeight: 300 }} nestedScrollEnabled showsVerticalScrollIndicator>
          <View style={{ paddingVertical: 4 }}>
            {lineDiff.slice(0, 40).map((line, i) => {
              const isRemoved = line.type === 'removed';
              const isAdded = line.type === 'added';

              return (
                <View
                  key={i}
                  style={{
                    backgroundColor: isRemoved
                      ? withAlpha(THEME.accent.red, isDark ? 0.06 : 0.05)
                      : isAdded
                        ? withAlpha(THEME.accent.green, isDark ? 0.06 : 0.05)
                        : 'transparent',
                  }}
                >
                  <DiffCodeLine text={line.text} lineType={line.type} ext={ext} isDark={isDark} fs={fs} lh={lh} />
                </View>
              );
            })}
          </View>
          {lineDiff.length > 40 && (
            <View style={{ paddingHorizontal: 12, paddingVertical: 6 }}>
              <Text style={{ fontSize: 10, fontFamily: monoFont, color: muted(isDark) }}>
                ... {lineDiff.length - 40} more lines
              </Text>
            </View>
          )}
        </ScrollView>
      ) : content ? (
        <ScrollView
          style={{ maxHeight: 250 }}
          contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 10 }}
          nestedScrollEnabled
          showsVerticalScrollIndicator
        >
          <LegacyHighlightedCode
            content={(() => {
              const cleaned = stripCodeFences(content);
              return cleaned.length > 3000 ? cleaned.slice(0, 3000) : cleaned;
            })()}
            filePath={filePath}
            isDark={isDark}
            maxLines={40}
          />
        </ScrollView>
      ) : null}
    </View>
  );
}
