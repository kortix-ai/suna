'use client';

import { peerMessagePreview } from '@kortix/sdk';
import type { PeerMessagePromptInfo } from '@kortix/shared';
import { peerHandleLabel } from '@kortix/shared';
import { useTranslations } from '../../i18n';
import { UnifiedMarkdown } from '../../markdown/unified-markdown';
import { AgentFace, AgentRowBody, AgentRowScope, AgentStatus, AgentTrigger } from '../agents/agent-surface';
import { BasicTool } from '../tool/shared/infrastructure';

/**
 * A message another Kortix session sent this one (`send_message`). Nobody here
 * typed it, so it is never a bubble: it is an agent row, the sender's face and
 * handle, then the message on the rail, open, because a message is there to be
 * read. The header and the footer the API wrapped around it
 * (`peerMessagePromptText`) are for the agent, not the reader.
 *
 *   [face] reviewer  Review done, 2 comments
 *          │ Rebased and reviewed. Two comments: …
 *
 * An idle notice says only that a teammate finished: one row like an agent's
 * finish, that opens to the rest. A shutdown request and its answer say so on the right.
 */

/** An idle notice's text without the line that repeats the state, and its answer without the "Its last answer:" label. */
export function idleNoticeBody(text: string): string {
  // Only the platform's two lines change; the answer itself keeps its Markdown (indents, blank lines).
  return text
    .split('\n')
    .filter((line) => !/finished its turn and is idle\.?\s*$/.test(line))
    .map((line) => line.replace(/^(\s*)Its last answer:\s?/, '$1'))
    .join('\n')
    .trim();
}

export function PeerMessageRow({ info, actions }: { info: PeerMessagePromptInfo; actions?: React.ReactNode }) {
  const t = useTranslations('multiAgent.peer');
  const from = info.from;
  const name = peerHandleLabel(from).replace(/^@/, '');
  const idle = info.kind === 'idle_notice';
  const preview = peerMessagePreview(info);
  const text = info.text.trim();
  // An idle notice's first line repeats the state word: its body is the answer, without its label.
  const body = idle ? idleNoticeBody(text) : text;
  const kindWord =
    info.kind === 'shutdown_request'
      ? t('kind.shutdownRequest')
      : info.kind === 'shutdown_response'
        ? t('kind.shutdownResponse')
        : idle
          ? t('kind.finished')
          : t('kind.message');
  return (
    <div data-testid="peer-message-turn" data-peer-kind={info.kind} data-peer-message-id={info.messageId} className="flex min-w-0 flex-col gap-1">
      <AgentRowScope>
        <BasicTool
          icon={<AgentFace handle={from} />}
          trigger={<AgentTrigger title={name} subtitle={idle ? preview : info.summary?.trim()} />}
          triggerAction={<AgentStatus status={idle ? 'done' : undefined} label={kindWord} opens={!!body} />}
          defaultOpen={!idle}
        >
          {body ? (
            <AgentRowBody>
              <div data-slot="peer-message-body" className="min-w-0">
                <UnifiedMarkdown content={body} trust="agent" isStreaming={false} />
              </div>
            </AgentRowBody>
          ) : undefined}
        </BasicTool>
      </AgentRowScope>
      {actions}
    </div>
  );
}
