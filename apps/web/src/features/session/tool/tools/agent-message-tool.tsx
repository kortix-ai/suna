'use client';
import { SubSessionModal } from '@/features/session/sub-session-modal';
import {
  BasicTool,
  isErrorOutput,
  partInput,
  partOutput,
  partStatus,
  ToolOutputFallback,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { getChildSessionId } from '@/ui';
import { ChatCircleIcon as MessageCircle } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

export function AgentMessageTool({ part, forceOpen }: ToolProps) {
  const input = partInput(part);
  const status = partStatus(part);
  const output = partOutput(part);
  const rawMessage = (input.message as string) || '';
  const taskId = (input.id as string) || (input.agent_id as string) || '';
  // `isErrorOutput` trims a copy of the whole output and runs `JSON.parse` over
  // it. Called from the render body it did that on every frame of the stream.
  const isError = useMemo(
    () => status === 'error' || (status === 'completed' && isErrorOutput(output)),
    [status, output],
  );
  const [modalOpen, setModalOpen] = useState(false);

  const childSessionId = useMemo(() => getChildSessionId(part), [part]);
  const hasSession = !!childSessionId;

  return (
    <>
      <BasicTool
        icon={<MessageCircle className="size-3.5 flex-shrink-0" />}
        trigger={{
          title: 'Message agent',
          subtitle: taskId ? taskId.slice(-12) : undefined,
          args: isError ? ['failed'] : undefined,
        }}
        onSubtitleClick={hasSession ? () => setModalOpen(true) : undefined}
        forceOpen={forceOpen}
      >
        {isError ? (
          <ToolOutputFallback output={output} toolName="agent_message" />
        ) : rawMessage ? (
          <div className="text-muted-foreground px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap">
            {rawMessage}
          </div>
        ) : null}
      </BasicTool>

      {hasSession && (
        <SubSessionModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          sessionId={childSessionId}
          title={`Message → ${taskId || 'worker'}`}
        />
      )}
    </>
  );
}
ToolRegistry.register('agent_message', AgentMessageTool);
ToolRegistry.register('agent-message', AgentMessageTool);
