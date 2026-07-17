'use client';
import { STATUS_TEXT, } from '@/components/ui/status';
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
import { cn } from '@/lib/utils';
import {
  Loader2,
  Scissors,
} from 'lucide-react';
import {
  useContext,
} from 'react';


export function DCPPruneTool({ part }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const isRunning = useContext(ToolRunningContext);
  const ids = input.ids as string[] | undefined;
  const reason = input.reason as string | undefined;

  return (
    <BasicTool
      icon={<Scissors className={cn('size-3.5 flex-shrink-0', STATUS_TEXT.warning)} />}
      trigger={
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="text-foreground text-xs font-medium whitespace-nowrap">Prune</span>
          <span className={cn('text-xs font-medium whitespace-nowrap', STATUS_TEXT.warning)}>
            DCP
          </span>
          {reason && <span className="text-muted-foreground/70 truncate text-xs">{reason}</span>}
          {ids && ids.length > 0 && (
            <span className="text-muted-foreground/60 ml-auto text-xs">{ids.length} tools</span>
          )}
          {isRunning && <Loader2 className="text-muted-foreground ml-auto size-3 animate-spin" />}
        </div>
      }
    >
      {isErrorOutput(output) ? (
        <ToolOutputFallback output={output} toolName="prune" />
      ) : output ? (
        <div className="p-2">
          <OutputBlock text={output} />
        </div>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('prune', DCPPruneTool);

