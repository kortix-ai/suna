/**
 * `agent_status` / `agent_task_list`. Port of apps/web `tool/tools/agent-status-tool.tsx`.
 *
 * - trigger: `Stack` · "Agent status"; badge "N task(s)" once settled;
 * - body (settled only): one row per task — status glyph (`KortixLoader` for
 *   in-progress, success check, warning clock for input-needed, muted/40 X or
 *   circle), title `text-foreground/80`, the id's last 8 characters in mono
 *   muted/50, and a `CaretRight` (muted/20) when the task has a worker
 *   session; hairline `border-border/20` between rows. A row with a session
 *   opens it (web: `SubSessionModal`; mobile: the session in the app);
 * - an error payload → `ToolOutputFallback`; no task rows → the cleaned output.
 */

import { useMemo } from 'react';
import { Pressable, View } from 'react-native';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { Text } from '@/components/ui/text';
import { CaretRightIcon, CheckIcon, CircleIcon, ClockIcon, StackIcon, XIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { agentStatusModel, type TaskRow } from '@/lib/session/tools/agents-status';
import { webSpace } from '@/lib/session/user-message';
import { withAlpha } from '@/lib/utils/theme';
import {
  BasicTool,
  ToolOutputFallback,
  partOutput,
  partStatus,
  useToolNavigation,
} from '../shared/infrastructure';
import { OutputBlock } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import { TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

function TaskStatusGlyph({ status }: { status: string }) {
  const palette = useTurnPalette();
  const size = TURN_SPACE.statusIcon;
  if (status === 'in_progress') return <KortixLoader customSize={size} />;
  if (status === 'completed') return <CheckIcon size={size} color={palette.success} />;
  if (status === 'input_needed') return <ClockIcon size={size} color={palette.warning} />;
  if (status === 'cancelled') return <XIcon size={size} color={palette.muted40} />;
  return <CircleIcon size={size} color={palette.muted40} />;
}

function TaskStatusRow({ row, first, onOpen }: { row: TaskRow; first: boolean; onOpen?: () => void }) {
  const palette = useTurnPalette();
  const hasSession = Boolean(onOpen);
  return (
    <Pressable
      accessibilityRole={hasSession ? 'button' : undefined}
      accessibilityLabel={hasSession ? `Open ${row.title}` : undefined}
      disabled={!hasSession}
      onPress={onOpen}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: webSpace(2.5),
        paddingHorizontal: TURN_SPACE.cardPad,
        paddingVertical: webSpace(2),
        borderTopWidth: first ? 0 : 1,
        borderTopColor: palette.border20,
        backgroundColor: pressed && hasSession ? palette.mutedHalf : undefined,
      })}
    >
      <TaskStatusGlyph status={row.status} />
      <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.xs, { flex: 1, color: palette.foreground80 }]}>
        {row.title}
      </Text>
      <Text variant="muted" style={[TURN_TYPE.xs, { flexShrink: 0, fontFamily: monoFont, color: palette.muted50 }]}>
        {row.id.slice(-8)}
      </Text>
      {hasSession ? <CaretRightIcon size={TURN_SPACE.statusIcon} color={withAlpha(palette.mutedForeground, 0.2)} /> : null}
    </Pressable>
  );
}

export function AgentStatusTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const status = partStatus(part);
  const output = partOutput(part);
  const { enabled: navigationEnabled, openSession } = useToolNavigation();
  const model = useMemo(() => agentStatusModel({ status, output }), [status, output]);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={StackIcon}
      trigger={{ title: model.title }}
      badge={model.badge}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      {model.showRows ? (
        <View>
          {model.taskRows.map((row, i) => (
            <TaskStatusRow
              key={row.id}
              row={row}
              first={i === 0}
              onOpen={row.sessionId && navigationEnabled ? () => openSession(row.sessionId!) : undefined}
            />
          ))}
        </View>
      ) : null}

      {model.showError ? <ToolOutputFallback output={output} toolName="agent_status" /> : null}

      {model.showRaw ? <OutputBlock text={model.cleanedOutput} /> : null}
    </BasicTool>
  );
}
ToolRegistry.register('agent_status', AgentStatusTool);
ToolRegistry.register('agent-status', AgentStatusTool);
ToolRegistry.register('agent_task_list', AgentStatusTool);
ToolRegistry.register('agent-task-list', AgentStatusTool);
