'use client';
import Loading from '@/components/ui/loading';
import {
  BasicTool,
  partInput,
  partOutput,
  ToolOutputFallback,
  ToolRunningContext,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { ScissorsIcon as Scissors } from '@phosphor-icons/react';
import { useContext } from 'react';

export function DCPDistillTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const isRunning = useContext(ToolRunningContext);
  const ids = input.ids as string[] | undefined;

  return (
    <BasicTool
      icon={<Scissors className="text-muted-foreground/50 size-3.5 shrink-0" />}
      trigger={
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="text-foreground text-xs font-medium whitespace-nowrap">Distill</span>
          <span className="text-muted-foreground/50 text-xs font-medium whitespace-nowrap">
            DCP
          </span>
          {ids && ids.length > 0 && (
            <span className="text-muted-foreground/60 ml-auto text-xs">{ids.length} tools</span>
          )}
          {isRunning && <Loading className="text-muted-foreground ml-auto size-3" />}
        </div>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      {output ? <ToolOutputFallback output={output} toolName="distill" /> : null}
    </BasicTool>
  );
}
ToolRegistry.register('distill', DCPDistillTool);
