'use client';

import { SubSessionModal } from '../../sub-session-modal';
import {
  BasicTool,
  isErrorOutput,
  partInput,
  partOutput,
  partStatus,
  ToolOutputFallback,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import type { ToolProps } from '../shared/types';
import { useTranslations } from '../../../i18n';
import { getChildSessionId } from '../../../shared/ui';
import { ChatCircleIcon as MessageCircle } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

export function AgentMessageTool({ call, defaultOpen, forceOpen }: ToolProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const input = partInput(call);
  const status = partStatus(call);
  const output = partOutput(call);
  const rawMessage = (input.message as string) || '';
  const taskId = (input.id as string) || (input.agent_id as string) || '';
  // `isErrorOutput` trims a copy of the whole output and runs `JSON.parse` over
  // it. Called from the render body it did that on every frame of the stream.
  const isError = useMemo(
    () => status === 'error' || (status === 'completed' && isErrorOutput(output)),
    [status, output],
  );
  const [modalOpen, setModalOpen] = useState(false);

  const childSessionId = useMemo(() => getChildSessionId(call), [call]);
  const hasSession = !!childSessionId;

  return (
    <>
      <BasicTool
        icon={<MessageCircle className="size-3.5 shrink-0" />}
        trigger={{
          title: tI18nComplete.raw('text8833ce4e6595'),
          subtitle: taskId ? taskId.slice(-12) : undefined,
          args: isError ? ['failed'] : undefined,
        }}
        onSubtitleClick={hasSession ? () => setModalOpen(true) : undefined}
        defaultOpen={defaultOpen}
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
          title={tI18nComplete('text8116da8fa64c', { value0: taskId || 'worker' })}
        />
      )}
    </>
  );
}
ToolRegistry.register('agent-message', AgentMessageTool);
