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

function parseTaskRows(
  output: string,
): Array<{ id: string; title: string; status: string; sessionId?: string }> {
  if (!output) return [];
  const rows: Array<{ id: string; title: string; status: string; sessionId?: string }> = [];

  const lines = output.split('\n').filter((l) => l.trim());
  for (const line of lines) {
    const m = line.match(/\*\*(task-[a-z0-9]+)\*\*\s+(.+?)\s+—\s+(\w+)/);
    if (m) {
      const sessionMatch = line.match(/\bses_[a-zA-Z0-9]+/);
      rows.push({ id: m[1], title: m[2], status: m[3], sessionId: sessionMatch?.[0] });
    }
  }
  return rows;
}
