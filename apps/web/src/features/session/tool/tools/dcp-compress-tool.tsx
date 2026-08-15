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

export function DCPCompressTool({ part }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const isRunning = useContext(ToolRunningContext);
  const topic = input.topic as string | undefined;

  return (
    <BasicTool
      icon={<Scissors className="text-muted-foreground/50 size-3.5 shrink-0" />}
      trigger={
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="text-foreground text-xs font-medium whitespace-nowrap">Compress</span>
          <span className="text-muted-foreground/50 text-xs font-medium whitespace-nowrap">
            DCP
          </span>
          {topic && (
            <span className="text-muted-foreground/70 max-w-[200px] truncate text-xs">{topic}</span>
          )}
          {isRunning && <Loading className="text-muted-foreground ml-auto size-3" />}
        </div>
      }
    >
      {output ? <ToolOutputFallback output={output} toolName="compress" /> : null}
    </BasicTool>
  );
}
ToolRegistry.register('compress', DCPCompressTool);
