'use client';

import { BasicTool, partInput } from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { Check } from 'lucide-react';

export function TaskDoneTool({ part, forceOpen }: ToolProps) {
  const input = partInput(part);
  const result = (input.result as string) || '';
  return (
    <BasicTool
      icon={
        <span className="bg-kortix-green/15 flex size-5 shrink-0 items-center justify-center rounded-sm">
          <Check className="text-kortix-green size-3 shrink-0" />
        </span>
      }
      trigger={{ title: 'Task done' }}
      forceOpen={forceOpen}
    >
      {result && (
        <div className="text-muted-foreground px-3 py-2 text-xs leading-relaxed text-pretty">
          {result}
        </div>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('task_done', TaskDoneTool);
ToolRegistry.register('task-done', TaskDoneTool);
