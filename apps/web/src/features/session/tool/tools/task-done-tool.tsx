'use client';

import { partInput } from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { Check } from 'lucide-react';

export function TaskDoneTool({ part }: ToolProps) {
  const input = partInput(part);
  const result = (input.result as string) || '';
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="bg-kortix-green/15 flex size-5 shrink-0 items-center justify-center rounded-sm">
        <Check className="text-kortix-green size-3 shrink-0" />
      </span>
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs text-pretty">
        {result || 'Completed'}
      </span>
    </div>
  );
}
ToolRegistry.register('task_done', TaskDoneTool);
ToolRegistry.register('task-done', TaskDoneTool);
