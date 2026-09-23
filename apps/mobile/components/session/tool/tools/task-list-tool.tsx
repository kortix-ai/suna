/**
 * `task_list` / `task_get` / `agent_task_get`. Port of apps/web `tool/tools/task-list-tool.tsx`:
 * `ListChecks` · "Tasks", closed by default; body is the error fallback, or the
 * list as markdown in a `max-h-48 px-3 py-2` scroll area.
 */

import { useMemo } from 'react';
import { ScrollView } from 'react-native';
import { ListChecksIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { webSpace } from '@/lib/session/user-message';
import {
  BasicTool,
  ToolMarkdown,
  ToolOutputFallback,
  isErrorOutput,
  partOutput,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { TURN_SPACE } from '../shared/styles';
import type { ToolProps } from '../shared/types';
import { ToolScroll } from '../shared/surface';

const NO_ARGS: string[] = [];

export function TaskListTool({ part, forceOpen }: ToolProps) {
  const output = partOutput(part);
  const isError = useMemo(() => isErrorOutput(output), [output]);
  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={ListChecksIcon}
      trigger={{ title: 'Tasks', subtitle: '', args: NO_ARGS }}
      defaultOpen={false}
      forceOpen={forceOpen}
    >
      {isError ? (
        <ToolOutputFallback output={output} toolName="task_list" />
      ) : output ? (
        <ToolScroll maxHeight={webSpace(48)} contentContainerStyle={{ paddingHorizontal: TURN_SPACE.cardPad, paddingVertical: webSpace(2) }}>
          <ToolMarkdown content={output} />
        </ToolScroll>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('task_list', TaskListTool);
ToolRegistry.register('task-list', TaskListTool);
ToolRegistry.register('task_get', TaskListTool);
ToolRegistry.register('task-get', TaskListTool);
ToolRegistry.register('agent_task_get', TaskListTool);
ToolRegistry.register('agent-task-get', TaskListTool);
