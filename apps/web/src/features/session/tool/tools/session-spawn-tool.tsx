'use client';
import { SubSessionModal } from '@/features/session/sub-session-modal';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  partInput,
  partStatus,
} from '@/features/session/tool/shared/infrastructure';
import { SubAgentActivity, SubAgentStatusBanner } from '@/features/session/tool/shared/sub-agent';
import { useOpenCodeMessages } from '@/hooks/opencode/use-opencode-sessions';
import {
  Cpu,
  ExternalLink,
} from 'lucide-react';
import {
  useMemo,
  useState,
} from 'react';
import {
  getChildSessionId,
  getChildSessionToolParts,
  getToolInfo,
  type MessageWithParts,
} from '@/ui';


export function SessionSpawnTool({ part, forceOpen }: ToolProps) {
  const input = partInput(part);
  const status = partStatus(part);

  const agentName = (input.agent as string) || 'kortix';
  const description = (input.description as string) || '';
  const projectName = (input.project as string) || '';
  const fullPrompt = (input.prompt as string) || '';

  const childSessionId: string | undefined = useMemo(() => getChildSessionId(part), [part]);

  const { data: childMessages } = useOpenCodeMessages(childSessionId ?? '');

  const childToolParts = useMemo(() => {
    if (!childMessages) return [];
    return getChildSessionToolParts(childMessages as MessageWithParts[]);
  }, [childMessages]);

  const [modalOpen, setModalOpen] = useState(false);

  const isRunning = status === 'running' || status === 'pending';
  const isCompleted = status === 'completed';

  const lastActivity = useMemo(() => {
    if (childToolParts.length === 0) return null;
    const last = childToolParts[childToolParts.length - 1];
    const info = getToolInfo(last.tool, partInput(last) as Record<string, any>);
    return info.title + (info.subtitle ? ` · ${info.subtitle}` : '');
  }, [childToolParts]);

  const label = description || projectName || fullPrompt.split('\n')[0]?.slice(0, 80) || '';

  const subtitle = isRunning ? (lastActivity ?? label) : label || undefined;

  return (
    <>
      <BasicTool
        icon={<Cpu />}
        trigger={{
          title: `Worker · ${agentName}`,
          subtitle,
        }}
        onClick={childSessionId ? () => setModalOpen(true) : undefined}
        badge={
          isCompleted && childToolParts.length > 0 ? `${childToolParts.length} steps` : undefined
        }
        rightAccessory={childSessionId ? <ExternalLink /> : undefined}
      >
        {childToolParts.length > 0 ? (
          <SubAgentActivity childSessionId={childSessionId} parts={childToolParts} />
        ) : undefined}
      </BasicTool>
      <SubAgentStatusBanner childSessionId={childSessionId} childMessages={childMessages} />
      {childSessionId && (
        <SubSessionModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          sessionId={childSessionId}
          title={`Worker · ${agentName}${label ? `: ${label}` : ''}`}
        />
      )}
    </>
  );
}
ToolRegistry.register('session_spawn', SessionSpawnTool);
ToolRegistry.register('session-spawn', SessionSpawnTool);
ToolRegistry.register('oc-session_spawn', SessionSpawnTool);
ToolRegistry.register('oc-session-spawn', SessionSpawnTool);
ToolRegistry.register('session_start_background', SessionSpawnTool);
ToolRegistry.register('session-start-background', SessionSpawnTool);
ToolRegistry.register('oc-session_start_background', SessionSpawnTool);
ToolRegistry.register('oc-session-start-background', SessionSpawnTool);

