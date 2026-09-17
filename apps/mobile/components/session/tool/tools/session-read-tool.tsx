/**
 * `session_read`. Port of apps/web `tool/tools/session-read-tool.tsx`:
 * `Eyeglasses` · "Session · <mode>" · the short session id · status, `N msgs`,
 * `N tools`, `/pattern/`. In `tools` mode the body is one row per tool call —
 * a `w-6` status column (success check, muted/50 clock, destructive warning),
 * the tool name (`w-24` mono medium `text-foreground/80`) and its summary
 * (mono muted/60), hairline `border-border/10` between rows, capped at
 * `max-h-96`; otherwise the error fallback or the output as markdown.
 */

import { useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { Text } from '@/components/ui/text';
import { CheckIcon, ClockIcon, EyeglassesIcon, WarningCircleIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import {
  parseSessionReadSummary,
  parseSessionReadToolEntries,
  sessionReadArgs,
  sessionReadModeLabel,
  shortSessionId,
} from '@/lib/session/tools/agents-session';
import { webSpace } from '@/lib/session/user-message';
import {
  BasicTool,
  ToolOutputFallback,
  isErrorOutput,
  partInput,
  partOutput,
} from '../shared/infrastructure';
import { OutputBlock } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import { TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

const ENTRY_ICON = webSpace(2.5);

function EntryStatus({ status }: { status: string }) {
  const palette = useTurnPalette();
  if (status === 'completed') return <CheckIcon size={ENTRY_ICON} color={palette.success} />;
  if (status === 'pending') return <ClockIcon size={ENTRY_ICON} color={palette.muted50} />;
  return <WarningCircleIcon size={ENTRY_ICON} color={palette.destructive} />;
}

export function SessionReadTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const input = partInput(part);
  const output = partOutput(part);
  const sessionId = (input.session_id as string) || '';
  const mode = (input.mode as string) || 'summary';
  const pattern = (input.pattern as string) || '';

  const parsed = useMemo(() => parseSessionReadSummary(output), [output]);
  const toolEntries = useMemo(() => parseSessionReadToolEntries(mode, output), [mode, output]);
  const outputIsError = useMemo(() => isErrorOutput(output), [output]);
  const statusArgs = useMemo(() => sessionReadArgs(parsed, mode, pattern), [parsed, mode, pattern]);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={EyeglassesIcon}
      trigger={{
        title: `Session · ${sessionReadModeLabel(mode)}`,
        subtitle: shortSessionId(sessionId),
        args: statusArgs,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {mode === 'tools' && toolEntries.length > 0 ? (
        <ScrollView style={{ maxHeight: TURN_SPACE.outputMaxHeight }} bounces={false} overScrollMode="never" nestedScrollEnabled>
          {toolEntries.map((entry, i) => (
            <View
              key={entry.at}
              style={{
                flexDirection: 'row',
                alignItems: 'flex-start',
                borderBottomWidth: i === toolEntries.length - 1 ? 0 : 1,
                borderBottomColor: palette.border10,
              }}
            >
              <View style={{ width: webSpace(6), flexShrink: 0, alignItems: 'center', paddingVertical: webSpace(1) }}>
                <View style={{ height: TURN_TYPE.xs.lineHeight, justifyContent: 'center' }}>
                  <EntryStatus status={entry.status} />
                </View>
              </View>
              <Text
                variant="muted"
                numberOfLines={1}
                style={[
                  TURN_TYPE.xs,
                  {
                    width: webSpace(24),
                    flexShrink: 0,
                    paddingVertical: webSpace(1),
                    fontFamily: monoFont,
                    fontWeight: '500',
                    color: palette.foreground80,
                  },
                ]}
              >
                {entry.tool}
              </Text>
              <Text
                variant="muted"
                numberOfLines={1}
                style={[
                  TURN_TYPE.xs,
                  { flex: 1, paddingVertical: webSpace(1), paddingRight: webSpace(2), fontFamily: monoFont, color: palette.muted60 },
                ]}
              >
                {entry.summary}
              </Text>
            </View>
          ))}
        </ScrollView>
      ) : outputIsError ? (
        <ToolOutputFallback output={output} toolName="session_read" />
      ) : output ? (
        <OutputBlock text={output} markdown />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('session_read', SessionReadTool);
ToolRegistry.register('session-read', SessionReadTool);
ToolRegistry.register('oc-session_read', SessionReadTool);
ToolRegistry.register('oc-session-read', SessionReadTool);
