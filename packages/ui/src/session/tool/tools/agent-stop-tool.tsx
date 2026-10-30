'use client';

import { BasicTool, partInput } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import type { ToolProps } from '../shared/types';
import { StopCircleIcon as StopCircle } from '@phosphor-icons/react';
import { useTranslations } from '../../../i18n';

export function AgentStopTool({ call, forceOpen }: ToolProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const input = partInput(call);
  const agentId = (input.agent_id as string) || '';
  return (
    <BasicTool
      icon={<StopCircle className="size-3.5 shrink-0" />}
      trigger={{
        title: tI18nComplete.raw('texta8b750b1f323'),
        subtitle: agentId ? agentId.slice(-12) : undefined,
        args: ['stopped'],
      }}
      forceOpen={forceOpen}
    />
  );
}
ToolRegistry.register('agent-stop', AgentStopTool);
