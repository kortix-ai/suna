'use client';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  partInput,
  partOutput,
  partStatus,
} from '@/features/session/tool/shared/infrastructure';
import { OutputBlock, ToolSection } from '@/features/session/tool/shared/output-block';
import {
  MessageCircle,
} from 'lucide-react';


export function SessionMessageTool({ part }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const sessionId = (input.session_id as string) || '';
  const message = (input.message as string) || '';
  const sid = sessionId.length > 16 ? `…${sessionId.slice(-12)}` : sessionId;
  const isOk = status === 'completed';

  return (
    <BasicTool
      icon={<MessageCircle className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: 'Message → Session',
        subtitle: sid,
        args: isOk ? ['sent'] : status === 'error' ? ['failed'] : [],
      }}
      defaultOpen={false}
    >
      {message && (
        <div className="px-3 py-2">
          <ToolSection label="Message">
            <OutputBlock text={message.slice(0, 500)} />
          </ToolSection>
        </div>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('session_message', SessionMessageTool);
ToolRegistry.register('session-message', SessionMessageTool);
ToolRegistry.register('oc-session_message', SessionMessageTool);
ToolRegistry.register('oc-session-message', SessionMessageTool);

