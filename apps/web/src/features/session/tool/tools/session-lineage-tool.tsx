'use client';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  isErrorOutput,
  ToolOutputFallback,
  partInput,
  partOutput,
} from '@/features/session/tool/shared/infrastructure';
import { OutputBlock } from '@/features/session/tool/shared/output-block';
import {
  ListTree,
} from 'lucide-react';
import {
  useMemo,
} from 'react';


export function SessionLineageTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const sessionId = (input.session_id as string) || '';
  const sid = sessionId.length > 16 ? `…${sessionId.slice(-12)}` : sessionId;

  const sessionCount = useMemo(() => {
    if (!output) return 0;
    return (output.match(/ses_/g) || []).length;
  }, [output]);

  return (
    <BasicTool
      icon={<ListTree className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: 'Session Lineage',
        subtitle: sid,
        args: sessionCount > 0 ? [`${sessionCount} sessions`] : [],
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

