'use client';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  isErrorOutput,
  ToolOutputFallback,
  partOutput,
} from '@/features/session/tool/shared/infrastructure';
import { OutputBlock } from '@/features/session/tool/shared/output-block';
import {
  Layers,
} from 'lucide-react';


export function SessionStatsTool({ part }: ToolProps) {
  const output = partOutput(part);

  return (
    <BasicTool
      icon={<Layers className="size-3.5 flex-shrink-0" />}
      trigger={{ title: 'Session Stats', subtitle: '', args: [] }}
    >
      {isErrorOutput(output) ? (
        <ToolOutputFallback output={output} toolName="session_stats" />
      ) : output ? (
        <OutputBlock text={output} markdown />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('session_stats', SessionStatsTool);
ToolRegistry.register('session-stats', SessionStatsTool);
ToolRegistry.register('oc-session_stats', SessionStatsTool);
ToolRegistry.register('oc-session-stats', SessionStatsTool);

