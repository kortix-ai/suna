'use client';

import { BasicTool, partInput } from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { StopCircleIcon as StopCircle } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';

export function AgentStopTool({ part, forceOpen }: ToolProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const input = partInput(part);
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
ToolRegistry.register('agent_stop', AgentStopTool);
ToolRegistry.register('agent-stop', AgentStopTool);
