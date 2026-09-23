/**
 * `task_delete`. Port of apps/web `tool/tools/task-delete-tool.tsx`:
 * `Trash` · "Delete task" (subtitle "failed" on an error payload); body is the
 * error fallback or "Task removed" (`px-3 py-2 text-xs leading-relaxed`, muted).
 *
 * Web's file also defines `extractSkillContent` / `extractSkillFiles`, which
 * nothing calls; they are not ported.
 */

import { useMemo } from 'react';
import { Text } from '@/components/ui/text';
import { TrashIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { webSpace } from '@/lib/session/user-message';
import {
  BasicTool,
  ToolOutputFallback,
  isErrorOutput,
  partOutput,
  partStatus,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { TURN_SPACE, TURN_TYPE, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

export function TaskDeleteTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const palette = useTurnPalette();
  const output = partOutput(part);
  const status = partStatus(part);
  const outputIsError = useMemo(() => isErrorOutput(output), [output]);
  const isError = status === 'completed' && outputIsError;

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={TrashIcon}
      trigger={{ title: 'Delete task', subtitle: isError ? 'failed' : undefined }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      {isError ? (
        <ToolOutputFallback output={output} toolName="task_delete" />
      ) : (
        <Text
          variant="muted"
          style={[
            TURN_TYPE.xsRelaxed,
            { paddingHorizontal: TURN_SPACE.cardPad, paddingVertical: webSpace(2), color: palette.mutedForeground },
          ]}
        >
          Task removed
        </Text>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('task_delete', TaskDeleteTool);
ToolRegistry.register('task-delete', TaskDeleteTool);
