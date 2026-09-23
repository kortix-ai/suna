/**
 * `memory` — port of apps/web `tool/tools/memory-tool.tsx`.
 *
 * The title reports what the call did ("Memory updated" / "Memory read" /
 * "Memory"), the subtitle names the file, and tapping the subtitle opens that
 * file (`memoryRowTarget` resolves both from one call). The body branch per
 * command is `memoryToolBody` in `lib/session/tools/projects-memory.ts`:
 * directory listing, markdown document or code card, diff, insert, rename,
 * delete, empty state, or the output fallback.
 */

import { useContext, useMemo } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { BrainIcon, CaretRightIcon, TrashIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import {
  memoryToolBody,
  memoryToolInput,
  memoryToolTitle,
  type MemoryToolBody,
} from '@/lib/session/tools/projects-memory';
import { isToolStreaming } from '@/lib/session/tools/projects-connectors';
import { webSpace } from '@/lib/session/user-message';
import {
  BasicTool,
  InlineDiffView,
  partInput,
  partOutput,
  partStatus,
  partStreamingInput,
  ToolCode,
  ToolCodeCard,
  ToolEmptyState,
  ToolMarkdownCard,
  ToolOutputFallback,
  ToolRunningContext,
  useToolNavigation,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { ToolResultCard } from '../shared/result-card';
import { TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';
import { ToolError } from '../tool-error';

function MemoryBody({ body, output }: { body: MemoryToolBody; output: string }) {
  const palette = useTurnPalette();
  switch (body.kind) {
    case 'none':
      return null;
    case 'fallback':
      return <ToolOutputFallback output={output} toolName="memory" />;
    case 'error':
      return <ToolError error={output} toolName="memory" />;
    case 'empty':
      return (
        <ToolResultCard>
          <ToolEmptyState message={body.message} />
        </ToolResultCard>
      );
    case 'markdown':
      return <ToolMarkdownCard code={body.code} />;
    case 'code':
      return <ToolCodeCard code={body.code} language={body.language} />;
    case 'dir':
      return (
        <ToolResultCard bodyStyle={{ paddingHorizontal: webSpace(2), paddingVertical: webSpace(1.5) }}>
          {body.entries.map((entry, i) => (
            <View
              key={entry.key}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: TURN_SPACE.gap2,
                paddingBottom: i + 1 < body.entries.length ? webSpace(3) : 0,
              }}
            >
              <Text
                variant="muted"
                numberOfLines={1}
                style={[TURN_TYPE.xs, { flexShrink: 1, fontFamily: monoFont, color: palette.mutedForeground }]}
              >
                {entry.name}
              </Text>
              <Text
                variant="muted"
                style={[TURN_TYPE.xs, { marginLeft: 'auto', flexShrink: 0, fontVariant: ['tabular-nums'], color: palette.muted50 }]}
              >
                {entry.size}
              </Text>
            </View>
          ))}
        </ToolResultCard>
      );
    case 'diff':
      return (
        <ToolResultCard>
          <InlineDiffView oldValue={body.oldStr} newValue={body.newStr} filename={body.filename} />
        </ToolResultCard>
      );
    case 'insert':
      return (
        <ToolResultCard>
          {body.line != null ? (
            <Text
              variant="muted"
              style={[TURN_TYPE.xs, { paddingHorizontal: webSpace(3), paddingTop: webSpace(2), color: palette.muted70 }]}
            >
              {/* Web renders the label and the number adjacent, with no space. */}
              Inserted at line{body.line}
            </Text>
          ) : null}
          {body.text ? <ToolCode code={body.text} language={body.language} /> : null}
        </ToolResultCard>
      );
    case 'rename':
      return (
        <ToolResultCard>
          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: TURN_SPACE.gap1_5,
              paddingHorizontal: webSpace(2),
              paddingVertical: webSpace(1.5),
            }}
          >
            <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.xs, { fontFamily: monoFont, color: palette.muted80 }]}>
              {body.from}
            </Text>
            <CaretRightIcon size={TURN_SPACE.statusIcon} color={palette.muted40} />
            <Text numberOfLines={1} style={[TURN_TYPE.xs, { fontFamily: monoFont, color: palette.foreground80 }]}>
              {body.to}
            </Text>
          </View>
        </ToolResultCard>
      );
    case 'delete':
      return (
        <ToolResultCard>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: TURN_SPACE.gap1_5,
              paddingHorizontal: webSpace(2),
              paddingVertical: webSpace(1.5),
            }}
          >
            <TrashIcon size={TURN_SPACE.statusIcon} color={palette.muted70} />
            <Text
              variant="muted"
              numberOfLines={1}
              style={[TURN_TYPE.xs, { flexShrink: 1, fontFamily: monoFont, color: palette.muted70 }]}
            >
              {body.path}
            </Text>
          </View>
        </ToolResultCard>
      );
  }
}

export function MemoryTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const streamingInput = partStreamingInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const { openFile } = useToolNavigation();

  const m = useMemo(() => memoryToolInput(input, streamingInput), [input, streamingInput]);
  const isStreaming = isToolStreaming(status, running);
  const body = useMemo(() => memoryToolBody(m, output, status, isStreaming), [m, output, status, isStreaming]);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={BrainIcon}
      trigger={{ title: memoryToolTitle(m.command), subtitle: m.subtitle }}
      onSubtitleClick={m.canOpen ? () => openFile(m.openPath) : undefined}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {body.kind === 'none' ? null : <MemoryBody body={body} output={output} />}
    </BasicTool>
  );
}
ToolRegistry.register('memory', MemoryTool);
ToolRegistry.register('oc-memory', MemoryTool);
