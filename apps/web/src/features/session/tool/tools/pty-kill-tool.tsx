'use client';
import {
  BasicTool,
  isErrorOutput,
  partInput,
  partOutput,
  partStatus,
  ToolOutputFallback,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { ToolResultCard } from '@/features/session/tool/shared/result-card';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { stripMarkupForToolOutput } from '@/features/session/tool/tool-renderers-sanitization';
import { TerminalWindowIcon as Terminal } from '@phosphor-icons/react';
import { useMemo } from 'react';

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
      icon={<Terminal className="size-3.5 shrink-0" />}
      trigger={{
        title: 'Stopped process',
        subtitle: ptyId || undefined,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {isErrorOutput(output) ? (
        <ToolOutputFallback output={output} toolName="pty_kill" />
      ) : cleanOutput ? (
        <ToolResultCard>
          <div className="text-muted-foreground px-2 py-1.5 text-xs leading-relaxed">
            {cleanOutput}
          </div>
        </ToolResultCard>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('pty_kill', PtyKillTool);
