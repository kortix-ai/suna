'use client';

import type { PeerMessageKind, PeerMessagePromptInfo } from '@kortix/shared';
import { peerHandleLabel } from '@kortix/shared';
import {
  ArrowBendDownLeftIcon,
  CaretRightIcon,
  ChatTeardropTextIcon,
  CheckCircleIcon,
  PowerIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useId, useState } from 'react';
import { useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';

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

const KIND_KEY: Record<PeerMessageKind, string> = {
  message: 'message',
  idle_notice: 'idleNotice',
  shutdown_request: 'shutdownRequest',
  shutdown_response: 'shutdownResponse',
};

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

export function PeerMessageRow({ info, actions }: { info: PeerMessagePromptInfo; actions?: React.ReactNode }) {
  const t = useTranslations('multiAgent.peer');
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const KindIcon = KIND_ICON[info.kind];
  const preview = peerMessagePreview(info);
  const headline = t(KIND_KEY[info.kind], { from: peerHandleLabel(info.from) });
  // Nothing more to read than the line says: the row is not a disclosure.
  const expandable = info.text.trim().length > 0 && info.text.trim() !== preview;
  const line = (
    <>
      <KindIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="shrink-0">{headline}</span>
      {preview && (
        <>
          <span aria-hidden className="shrink-0">
            ·
          </span>
          <span className="min-w-0 truncate" title={preview}>
            {preview}
          </span>
        </>
      )}
    </>
  );
  return (
    <div
      data-testid="peer-message-turn"
      data-peer-kind={info.kind}
      data-peer-message-id={info.messageId}
      className="flex min-w-0 flex-col gap-1"
    >
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
          className="text-muted-foreground hover:text-foreground duration-fast flex w-full min-w-0 items-center gap-1.5 text-left text-xs transition-colors"
        >
          {line}
          <CaretRightIcon aria-hidden className={cn('size-3 shrink-0', open && 'rotate-90')} />
          <span className="sr-only">{open ? t('collapse') : t('expand')}</span>
        </button>
      ) : (
        <div className="text-muted-foreground flex w-full min-w-0 items-center gap-1.5 text-xs">{line}</div>
      )}
      {expandable && open && (
        <div
          id={bodyId}
          className="text-muted-foreground border-border ml-1.5 border-l pl-3 text-sm whitespace-pre-wrap wrap-break-word"
        >
          {info.text}
        </div>
      )}
      {actions}
    </div>
  );
}
