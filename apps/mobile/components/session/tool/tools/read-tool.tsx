/**
 * `read`. Port of apps/web `tool/tools/read-tool.tsx`:
 * - trigger: `ReadCvLogo` · Reading / Read / Couldn't read (SDK `fileVerb`) ·
 *   the filename (tap opens the file); no filename on a stale pending part;
 * - body: file content → `ToolCodeCard` highlighted by extension; directory
 *   entries → a result card (`space-y-0.5 px-2 py-1.5`, `Folder` / `File`
 *   `size-3 text-muted-foreground/40`, mono `text-xs text-muted-foreground/80`);
 *   stale pending → "Waiting for file content..." shimmer; an error output →
 *   `ToolOutputFallback`;
 * - under the row (inline surface): the instruction files the read loaded,
 *   `mt-1 space-y-0.5 pl-2`, a success-toned `+` and the display path in mono
 *   `text-xs text-muted-foreground`; tap opens the file.
 *
 * `ReadExpandedContent` below is the previous mobile renderer, still imported
 * by `tool-part-renderer.tsx`'s legacy switch.
 */

import { useContext, useMemo } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { getFilename, isErrorOutput, parseReadOutput } from '@kortix/sdk';
import { TextShimmer } from '@/components/kortix/text-shimmer';
import { Text } from '@/components/ui/text';
import { FileIcon, FolderIcon, ReadCvLogoIcon } from '@/lib/icons';
import type { ToolPart } from '@/lib/opencode/types';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { toDisplayPath } from '@/lib/session/turn-body';
import { SEARCH_TEXT, readBodyKind, readLoaded } from '@/lib/session/tools/files-search';
import { fileRowTitle, isStalePendingFile } from '@/lib/session/tools/files-write-edit';
import { webSpace } from '@/lib/session/user-message';
import { HighlightedCode as LegacyHighlightedCode } from '../shared/highlighted-code';
import {
  BasicTool,
  partInput,
  partMetadata,
  partOutput,
  partStatus,
  partStreamingInput,
  ToolCodeCard,
  ToolOutputFallback,
  ToolResultCard,
  ToolRunningContext,
  ToolSurfaceContext,
  useToolNavigation,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from '../shared/styles';
import { getToolInput } from '../shared/tool-part';
import type { ToolProps } from '../shared/types';

export function ReadTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const surface = useContext(ToolSurfaceContext);
  const running = useContext(ToolRunningContext);
  const { openFile } = useToolNavigation();
  const input = partInput(part);
  const streamingInput = partStreamingInput(part);
  const metadata = partMetadata(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const filePath = (input.filePath as string) || (streamingInput.filePath as string) || undefined;
  const filename = getFilename(filePath) || '';
  const ext = filename.split('.').pop() || '';

  const isStalePending = isStalePendingFile({ running, filename, status });
  // A read that returned its error must not be reported in the wording of one
  // that opened the file.
  const isReadError = useMemo(() => status === 'completed' && isErrorOutput(output), [status, output]);
  const loaded = useMemo(() => readLoaded(status, metadata), [status, metadata]);
  const parsed = useMemo(() => (status === 'completed' ? parseReadOutput(output) : null), [status, output]);
  const kind = readBodyKind({ parsed, isStalePending, output });

  return (
    <>
      <BasicTool
        disclosureId={disclosureKey('tool', part.id)}
        icon={ReadCvLogoIcon}
        trigger={{
          title: fileRowTitle('read', { running, isError: isReadError }),
          subtitle: isStalePending ? undefined : filename || undefined,
        }}
        onSubtitleClick={filePath ? () => openFile(filePath) : undefined}
        defaultOpen={defaultOpen}
        forceOpen={forceOpen}
        locked={locked}
      >
        {kind === 'code' ? (
          <ToolCodeCard code={parsed?.content ?? ''} language={ext} />
        ) : kind === 'directory' ? (
          <ToolResultCard
            bodyStyle={{ rowGap: webSpace(0.5), paddingHorizontal: webSpace(2), paddingVertical: webSpace(1.5) }}
          >
            {(parsed?.entries ?? []).map((entry) => {
              const Glyph = entry.endsWith('/') ? FolderIcon : FileIcon;
              return (
                <View key={entry} style={{ flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap1_5 }}>
                  <Glyph size={TURN_SPACE.statusIcon} color={palette.muted40} />
                  <Text
                    variant="muted"
                    numberOfLines={1}
                    style={[TURN_TYPE.xs, { flexShrink: 1, fontFamily: monoFont, color: palette.muted80 }]}
                  >
                    {entry}
                  </Text>
                </View>
              );
            })}
          </ToolResultCard>
        ) : kind === 'stale' ? (
          <ToolResultCard bodyStyle={{ paddingHorizontal: webSpace(2), paddingVertical: webSpace(1.5) }}>
            <TextShimmer style={TURN_TYPE.xs}>{SEARCH_TEXT.waitingForFileContent}</TextShimmer>
          </ToolResultCard>
        ) : kind === 'error' ? (
          <ToolOutputFallback output={output} toolName="read" />
        ) : null}
      </BasicTool>
      {surface !== 'panel' && loaded.length > 0 ? (
        <View style={{ marginTop: webSpace(1), rowGap: webSpace(0.5), paddingLeft: webSpace(2) }}>
          {loaded.map((path) => (
            <Pressable
              key={path}
              accessibilityRole="link"
              accessibilityLabel={toDisplayPath(path)}
              onPress={() => openFile(path)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap1_5 }}
            >
              <Text variant="muted" style={[TURN_TYPE.xs, { color: palette.success }]}>
                +
              </Text>
              <Text
                variant="muted"
                numberOfLines={1}
                style={[TURN_TYPE.xs, { flexShrink: 1, fontFamily: monoFont, color: palette.mutedForeground }]}
              >
                {toDisplayPath(path)}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </>
  );
}
ToolRegistry.register('read', ReadTool);

// ─── Legacy (tool-part-renderer.tsx switch) ──────────────────────────────────

export function ReadExpandedContent({ tool, isDark }: { tool: ToolPart; isDark: boolean }) {
  const input = getToolInput(tool);
  const filePath = input.filePath || '';

  const { content } = useMemo(() => {
    if (tool.state.status !== 'completed' || !('output' in tool.state) || !tool.state.output) {
      return { content: '', lineNumbers: false };
    }
    const raw = tool.state.output.trim();

    // Try to extract content from <content>...</content> XML tags
    const contentMatch = raw.match(/<content>([\s\S]*?)<\/content>/);
    if (contentMatch) {
      const extracted = contentMatch[1];
      // Content often has line numbers like "1: line text\n2: line text"
      const lines = extracted.split('\n');
      const hasLineNumbers = lines.length > 1 && lines.slice(0, 3).every((l) => /^\d+:\s/.test(l));
      if (hasLineNumbers) {
        const cleanLines = lines.map((l) => l.replace(/^\d+:\s/, ''));
        return { content: cleanLines.join('\n'), lineNumbers: true };
      }
      return { content: extracted, lineNumbers: false };
    }

    const stripped = raw
      .replace(/<path>[\s\S]*?<\/path>/g, '')
      .replace(/<type>[\s\S]*?<\/type>/g, '')
      .replace(/<content>|<\/content>/g, '')
      .trim();

    return { content: stripped || raw, lineNumbers: false };
  }, [tool.state]);

  if (!content) return null;

  return (
    <ScrollView
      style={{ maxHeight: 300 }}
      contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 10 }}
      nestedScrollEnabled
      showsVerticalScrollIndicator
    >
      <LegacyHighlightedCode
        content={content.length > 4000 ? content.slice(0, 4000) : content}
        filePath={filePath || 'file.txt'}
        isDark={isDark}
        maxLines={50}
      />
    </ScrollView>
  );
}
