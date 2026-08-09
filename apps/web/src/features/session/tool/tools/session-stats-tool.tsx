'use client';
import {
  BasicTool,
  isErrorOutput,
  partOutput,
  ToolOutputFallback,
} from '@/features/session/tool/shared/infrastructure';
import { OutputBlock } from '@/features/session/tool/shared/output-block';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { StackIcon as Layers } from '@phosphor-icons/react';
import { useMemo } from 'react';

const TRIGGER = { title: 'Session Stats', subtitle: '', args: [] as string[] };

export function SessionStatsTool({ part }: ToolProps) {
  const output = partOutput(part);

  // `isErrorOutput` trims a copy of the whole output and runs `JSON.parse` over
  // it — asked once per render, whether the row is open or collapsed.
  const outputIsError = useMemo(() => isErrorOutput(output), [output]);

  return (
    <BasicTool icon={<Layers className="size-3.5 flex-shrink-0" />} trigger={TRIGGER}>
      {outputIsError ? (
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
