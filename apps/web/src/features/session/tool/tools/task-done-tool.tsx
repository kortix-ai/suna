'use client';

import { BasicTool, partInput } from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { CheckIcon as Check } from '@phosphor-icons/react';

export function TaskDoneTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const input = partInput(part);
  const result = (input.result as string) || '';
  return (
    <BasicTool
      icon={
        // `size-4`, not `size-5`: this is the only leading icon in the whole
        // registry that is a tinted chip rather than a bare glyph, and both
        // surfaces size their leading slot at 16px — the inline row's wrapper
        // span and the panel row's icon box. A 20px chip overflowed both
        // (the `[&>svg]:size-4` normalizer only reaches an svg, never a span).
        <span className="bg-kortix-green/15 flex size-4 shrink-0 items-center justify-center rounded-sm">
          <Check className="text-kortix-green size-3 shrink-0" />
        </span>
      }
      trigger={{ title: 'Task done' }}
      defaultOpen={defaultOpen}
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
