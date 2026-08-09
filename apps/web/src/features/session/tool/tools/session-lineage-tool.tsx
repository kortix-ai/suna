'use client';
import {
  BasicTool,
  isErrorOutput,
  partInput,
  partOutput,
  ToolOutputFallback,
} from '@/features/session/tool/shared/infrastructure';
import { OutputBlock } from '@/features/session/tool/shared/output-block';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { TreeStructureIcon as ListTree } from '@phosphor-icons/react';
import { useMemo } from 'react';

const NO_ARGS: string[] = [];

export function SessionLineageTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const sessionId = (input.session_id as string) || '';
  const sid = sessionId.length > 16 ? `…${sessionId.slice(-12)}` : sessionId;

  const sessionCount = useMemo(() => {
    if (!output) return 0;
    return (output.match(/ses_/g) || []).length;
  }, [output]);

  const args = useMemo(
    () => (sessionCount > 0 ? [`${sessionCount} sessions`] : NO_ARGS),
    [sessionCount],
  );

  return (
    <BasicTool
      icon={<ListTree className="size-3.5 shrink-0" />}
      trigger={{
        title: 'Session history',
        subtitle: sid,
        args,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {isErrorOutput(output) ? (
        <ToolOutputFallback output={output} toolName="session_lineage" />
      ) : output ? (
        <OutputBlock text={output} markdown />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('session_lineage', SessionLineageTool);
ToolRegistry.register('session-lineage', SessionLineageTool);
ToolRegistry.register('oc-session_lineage', SessionLineageTool);
ToolRegistry.register('oc-session-lineage', SessionLineageTool);
