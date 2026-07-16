'use client';
import {
  stripMarkupForToolOutput,
} from '@/features/session/tool/tool-renderers-sanitization';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  isErrorOutput,
  ToolOutputFallback,
  partInput,
  partOutput,
  partStatus,
} from '@/features/session/tool/shared/infrastructure';
import {
  Terminal,
} from 'lucide-react';
import {
  useMemo,
} from 'react';


export function PtyKillTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const ptyId = (input.id as string) || (input.pty_id as string) || '';

  const cleanOutput = useMemo(() => {
    if (!output) return '';
    return stripMarkupForToolOutput(output);
  }, [output]);

  return (
    <BasicTool
      icon={<Terminal className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: 'Kill process',
        subtitle: ptyId || undefined,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {isErrorOutput(output) ? (
        <ToolOutputFallback output={output} toolName="pty_kill" />
      ) : cleanOutput ? (
        <div className="text-muted-foreground px-3 py-2 text-xs leading-relaxed">{cleanOutput}</div>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('pty_kill', PtyKillTool);

