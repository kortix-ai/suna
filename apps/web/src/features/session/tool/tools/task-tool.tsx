'use client';
import { SubSessionModal } from '@/features/session/sub-session-modal';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  partInput,
  partStatus,
  firstMeaningfulLine,
} from '@/features/session/tool/shared/infrastructure';
import { SubAgentActivity, SubAgentStatusBanner } from '@/features/session/tool/shared/sub-agent';
import { useOpenCodeMessages } from '@/hooks/opencode/use-opencode-sessions';
import {
  ExternalLink,
  SquareKanban,
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


export function TaskTool({ part, forceOpen }: ToolProps) {
  const input = partInput(part);
  const status = partStatus(part);

  const subagentType = (input.subagent_type as string) || 'general';
  const description =
    (input.description as string) ||
    firstMeaningfulLine(input.prompt) ||
    firstMeaningfulLine(input.title, 80);

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

  const subtitle = isRunning ? (lastActivity ?? description) : description || undefined;

  return (
    <>
      <BasicTool
        icon={<SquareKanban className="size-3.5 flex-shrink-0" />}
        trigger={{
          title: `Agent · ${subagentType}`,
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
          title={`Agent · ${subagentType}${description ? `: ${description}` : ''}`}
        />
      )}
    </>
  );
}
ToolRegistry.register('task', TaskTool);

