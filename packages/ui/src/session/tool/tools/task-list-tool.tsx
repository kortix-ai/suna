'use client';

import { UnifiedMarkdown } from '../../../markdown/unified-markdown';
import {
  BasicTool,
  isErrorOutput,
  partOutput,
  ToolOutputFallback,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import type { ToolProps } from '../shared/types';
import { useTranslations } from '../../../i18n';
import type { TriggerTitle } from '../../../internal/session-types';
import { ListChecksIcon as ListTodo } from '@phosphor-icons/react';
import { useMemo } from 'react';

// Fully static, so it does not need rebuilding (object plus a fresh `args` array)
// on every render of every task row in a streaming session.
export function TaskListTool({ call, forceOpen }: ToolProps) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const output = partOutput(call);
  // `isErrorOutput` trims the whole task list and attempts a `JSON.parse` over
  // it, from inside the JSX, on every render.
  const isError = useMemo(() => isErrorOutput(output), [output]);
  return (
    <BasicTool
      icon={<ListTodo className="size-3.5 shrink-0" />}
      trigger={{ title: t.raw('textb3a60e61a523'), subtitle: '', args: [] } satisfies TriggerTitle}
      defaultOpen={false}
      forceOpen={forceOpen}
    >
      {isError ? (
        <ToolOutputFallback output={output} toolName="task_list" />
      ) : output ? (
        <div data-scrollable className="max-h-48 overflow-auto px-3 py-2">
          <div className="text-muted-foreground text-xs whitespace-pre-wrap">
            <UnifiedMarkdown content={output} trust="agent" isStreaming={false} />
          </div>
        </div>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('task-list', TaskListTool);
ToolRegistry.register('task-get', TaskListTool);
ToolRegistry.register('agent-task-get', TaskListTool);
