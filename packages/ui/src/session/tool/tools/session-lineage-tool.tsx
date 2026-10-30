'use client';

import {
  BasicTool,
  isErrorOutput,
  partInput,
  partOutput,
  ToolOutputFallback,
} from '../shared/infrastructure';
import { OutputBlock } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import type { ToolProps } from '../shared/types';
import { TreeStructureIcon as ListTree } from '@phosphor-icons/react';
import { useTranslations } from '../../../i18n';
import { useMemo } from 'react';

const NO_ARGS: string[] = [];

export function SessionLineageTool({ call, defaultOpen, forceOpen, locked }: ToolProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const input = partInput(call);
  const output = partOutput(call);
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
        title: tI18nComplete.raw('textc1c80b037867'),
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
ToolRegistry.register('session-lineage', SessionLineageTool);
