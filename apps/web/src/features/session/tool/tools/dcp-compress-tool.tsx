'use client';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  isErrorOutput,
  ToolOutputFallback,
  ToolRunningContext,
  partInput,
  partOutput,
} from '@/features/session/tool/shared/infrastructure';
import { OutputBlock } from '@/features/session/tool/shared/output-block';
import {
  Loader2,
  Scissors,
} from 'lucide-react';
import {
  useContext,
} from 'react';


export function DCPCompressTool({ part }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const isRunning = useContext(ToolRunningContext);
  const topic = input.topic as string | undefined;

  return (
    <BasicTool
      icon={<Scissors className="text-muted-foreground/50 size-3.5 flex-shrink-0" />}
      trigger={
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="text-foreground text-xs font-medium whitespace-nowrap">Compress</span>
          <span className="text-muted-foreground/50 text-xs font-medium whitespace-nowrap">
            DCP
          </span>
          {topic && (
            <span className="text-muted-foreground/70 max-w-[200px] truncate text-xs">{topic}</span>
          )}
          {isRunning && <Loader2 className="text-muted-foreground ml-auto size-3 animate-spin" />}
        </div>
      }
    >
      {isErrorOutput(output) ? (
        <ToolOutputFallback output={output} toolName="compress" />
      ) : output ? (
        <div className="p-2">
          <OutputBlock text={output} />
        </div>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('compress', DCPCompressTool);

