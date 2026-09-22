/**
 * `task_done` / `agent_task_approve` / `task_approve`. Port of apps/web
 * `tool/tools/task-done-tool.tsx`: the one leading icon that is a tinted chip —
 * `size-4 rounded-sm bg-kortix-green/15` holding a `size-3` `kortix-green`
 * check — · "Task done"; body is the result (`px-3 py-2 text-xs
 * leading-relaxed`, muted).
 */

import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { CheckIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { withAlpha } from '@/lib/utils/theme';
import { webSpace } from '@/lib/session/user-message';
import { BasicTool, partInput } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { TURN_SPACE, TURN_TYPE, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

export function TaskDoneTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const palette = useTurnPalette();
  const input = partInput(part);
  const result = (input.result as string) || '';
  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={
        <View
          style={{
            width: TURN_SPACE.icon,
            height: TURN_SPACE.icon,
            flexShrink: 0,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: TURN_SPACE.radiusSm,
            backgroundColor: withAlpha(palette.kortixGreen, 0.15),
          }}
        >
          <CheckIcon size={TURN_SPACE.statusIcon} color={palette.kortixGreen} />
        </View>
      }
      trigger={{ title: 'Task done' }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      {result ? (
        <Text
          variant="muted"
          style={[
            TURN_TYPE.xsRelaxed,
            { paddingHorizontal: TURN_SPACE.cardPad, paddingVertical: webSpace(2), color: palette.mutedForeground },
          ]}
        >
          {result}
        </Text>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('task_done', TaskDoneTool);
ToolRegistry.register('task-done', TaskDoneTool);
