'use client';

import {
  BasicTool,
  partInput,
  partOutput,
  partStatus,
} from '@/features/session/tool/shared/infrastructure';
import { OutputBlock, ToolSection } from '@/features/session/tool/shared/output-block';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { ChatCircleIcon as MessageCircle } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';

export function SessionMessageTool({ part, forceOpen }: ToolProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const sessionId = (input.session_id as string) || '';
  const message = (input.message as string) || '';
  const sid = sessionId.length > 16 ? `…${sessionId.slice(-12)}` : sessionId;
  const isOk = status === 'completed';

  return (
    <BasicTool
      icon={<MessageCircle className="size-3.5 shrink-0" />}
      trigger={{
        title: tI18nComplete.raw('text0762fc8b575e'),
        subtitle: sid,
        args: isOk ? ['sent'] : status === 'error' ? ['failed'] : [],
      }}
      defaultOpen={false}
      forceOpen={forceOpen}
    >
      {message && (
        <div className="px-3 py-2">
          <ToolSection label={tI18nComplete.raw('text2f77668a9dfb')}>
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
