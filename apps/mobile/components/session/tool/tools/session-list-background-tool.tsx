/**
 * `session_list` / `session_list_background` / `session_list_spawned`. Port of
 * apps/web `tool/tools/session-list-background-tool.tsx`:
 * `Stack` · "Background work" · the project ("all projects") · `N workers` /
 * `none`; body is one row per worker (`px-3 py-1.5`, status dot — info while
 * running, success when complete, else neutral — the id's last 12 characters
 * in mono `text-foreground/70`, the project muted/50, the status muted/40) in a
 * `max-h-56` scroll area, else the error fallback, the output as markdown, or
 * "No background sessions".
 */

import { useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { Text } from '@/components/ui/text';
import { StackIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { parseBackgroundWorkers, sessionListArgs } from '@/lib/session/tools/agents-session';
import { webSpace } from '@/lib/session/user-message';
import {
  BasicTool,
  ToolEmptyState,
  ToolOutputFallback,
  isErrorOutput,
  partInput,
  partOutput,
  partStatus,
} from '../shared/infrastructure';
import { OutputBlock } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import { TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

export function SessionListBackgroundTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const project = (input.project as string) || '';

  const workers = useMemo(() => parseBackgroundWorkers(output), [output]);
  const mentionsSession = useMemo(() => output.includes('ses_'), [output]);
  const outputIsError = useMemo(() => isErrorOutput(output), [output]);
  const noWorkers = status === 'completed' && workers.length === 0 && !mentionsSession;
  const args = useMemo(() => sessionListArgs(workers.length, noWorkers), [workers.length, noWorkers]);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={StackIcon}
      trigger={{ title: 'Background work', subtitle: project || 'all projects', args }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {workers.length > 0 ? (
        <ScrollView style={{ maxHeight: webSpace(56) }} nestedScrollEnabled>
          {workers.map((w, i) => (
            <View
              key={w.id}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: webSpace(2),
                paddingHorizontal: TURN_SPACE.cardPad,
                paddingVertical: webSpace(1.5),
                borderTopWidth: i === 0 ? 0 : 1,
                borderTopColor: palette.border20,
              }}
            >
              <View
                style={{
                  width: webSpace(2),
                  height: webSpace(2),
                  flexShrink: 0,
                  borderRadius: webSpace(1),
                  backgroundColor:
                    w.status === 'running' ? palette.info : w.status === 'complete' ? palette.success : palette.mutedForeground,
                }}
              />
              <Text
                variant="muted"
                numberOfLines={1}
                style={[TURN_TYPE.xs, { fontFamily: monoFont, color: palette.foreground70 }]}
              >
                {w.id.slice(-12)}
              </Text>
              <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.xs, { flex: 1, color: palette.muted50 }]}>
                {w.project}
              </Text>
              <Text variant="muted" style={[TURN_TYPE.xs, { color: palette.muted40 }]}>
                {w.status}
              </Text>
            </View>
          ))}
        </ScrollView>
      ) : outputIsError ? (
        <ToolOutputFallback output={output} toolName="session_list" />
      ) : output ? (
        <OutputBlock text={output} markdown />
      ) : noWorkers ? (
        <ToolEmptyState message="No background sessions" />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('session_list', SessionListBackgroundTool);
ToolRegistry.register('session-list', SessionListBackgroundTool);
ToolRegistry.register('oc-session_list', SessionListBackgroundTool);
ToolRegistry.register('oc-session-list', SessionListBackgroundTool);
ToolRegistry.register('session_list_background', SessionListBackgroundTool);
ToolRegistry.register('session-list-background', SessionListBackgroundTool);
ToolRegistry.register('oc-session_list_background', SessionListBackgroundTool);
ToolRegistry.register('oc-session-list-background', SessionListBackgroundTool);
ToolRegistry.register('session_list_spawned', SessionListBackgroundTool);
ToolRegistry.register('session-list-spawned', SessionListBackgroundTool);
ToolRegistry.register('oc-session_list_spawned', SessionListBackgroundTool);
ToolRegistry.register('oc-session-list-spawned', SessionListBackgroundTool);
