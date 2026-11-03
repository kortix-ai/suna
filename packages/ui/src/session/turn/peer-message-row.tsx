'use client';

import type { PeerMessageKind, PeerMessagePromptInfo } from '@kortix/shared';
import { peerHandleLabel } from '@kortix/shared';
import {
  ArrowBendDownLeftIcon,
  ChatTeardropTextIcon,
  CheckCircleIcon,
  PowerIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useTranslations } from '../../i18n';
import { FinishLine } from '../agents/agent-surface';
import { BasicTool } from '../tool/shared/infrastructure';
import { AgentAvatarIcon } from '../tool/tools/multi-agent-tool-bodies';

/**
 * A message another Kortix session sent this one (`send_message`), as Claude
 * Code draws it: one dim line, "Message from @reviewer · Schema migration
 * finished", that opens in place to the full text. The header and the footer
 * the API wrapped around it (`peerMessagePromptText`) are for the agent, not
 * the reader, so neither renders. An idle notice, a shutdown request and a
 * shutdown answer get their own words.
 */

const KIND_ICON: Record<PeerMessageKind, Icon> = {
  message: ChatTeardropTextIcon,
  idle_notice: CheckCircleIcon,
  shutdown_request: PowerIcon,
  shutdown_response: ArrowBendDownLeftIcon,
};

const KIND_KEY = new Map<PeerMessageKind, string>([
  ['message', 'message'],
  ['idle_notice', 'idleNotice'],
  ['shutdown_request', 'shutdownRequest'],
  ['shutdown_response', 'shutdownResponse'],
]);

/**
 * The preview after the sender: the summary, else the first line of the text. CSS cuts it with `…`.
 * An idle notice (`firePeerIdleNotices` in the API) previews its "Its last answer:" line; its
 * first line ("reviewer finished its turn and is idle.") repeats the headline, so it shows only
 * when it says something else (an error).
 */
export function peerMessagePreview(info: Pick<PeerMessagePromptInfo, 'summary' | 'text'> & { kind?: PeerMessageKind }): string {
  if (info.summary?.trim()) return info.summary.trim();
  const lines = info.text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (info.kind === 'idle_notice') {
    const answer = lines.find((line) => line.startsWith('Its last answer:'));
    if (answer) return answer.slice('Its last answer:'.length).trim();
    return lines[0] && !/finished its turn and is idle\.?$/.test(lines[0]) ? lines[0] : '';
  }
  return lines[0] ?? '';
}


/**
 * A message one agent sent another, delivered into this session as a prompt.
 * Nobody here typed it, so it is never a user bubble.
 *
 *   message, shutdown request/answer  a message card: the sender's face, who sent it,
 *                                     the first line; the whole text unfolds in the card
 *   idle notice                       an event, not a message: the finish line
 */
export function PeerMessageRow({ info, actions }: { info: PeerMessagePromptInfo; actions?: React.ReactNode }) {
  const t = useTranslations('multiAgent.peer');
  const KindIcon = KIND_ICON[info.kind];
  const preview = peerMessagePreview(info);
  const from = peerHandleLabel(info.from);
  const headline = t(KIND_KEY.get(info.kind) ?? 'message', { from });
  const expandable = info.text.trim().length > 0 && info.text.trim() !== preview;

  if (info.kind === 'idle_notice') {
    return (
      <div data-testid="peer-message-turn" data-peer-kind={info.kind} data-peer-message-id={info.messageId} className="flex min-w-0 flex-col gap-1.5">
        <FinishLine status="done">
          <span className="text-foreground min-w-0 truncate">{headline}</span>
          {preview && (
            <>
              <span aria-hidden>·</span>
              <span className="min-w-0 truncate" title={preview}>
                {preview}
              </span>
            </>
          )}
        </FinishLine>
        {actions}
      </div>
    );
  }

  // One plain tool row, the sender's face as its icon; the whole text unfolds under it.
  return (
    <div data-testid="peer-message-turn" data-peer-kind={info.kind} data-peer-message-id={info.messageId} className="flex min-w-0 flex-col gap-1.5">
      <BasicTool
        icon={<AgentAvatarIcon handle={info.from} />}
        trigger={
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-sm">
            <span className="text-foreground shrink-0">{headline}</span>
            {info.kind !== 'message' && <KindIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />}
            {preview && (
              <span className="text-muted-foreground min-w-0 flex-1 truncate" title={preview}>
                {preview}
              </span>
            )}
          </div>
        }
      >
        {expandable ? (
          <div className="text-foreground border-border ml-1.5 border-l pl-3 text-sm whitespace-pre-wrap wrap-break-word">{info.text}</div>
        ) : undefined}
      </BasicTool>
      {actions}
    </div>
  );
}
