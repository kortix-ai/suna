'use client';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { UserAvatar } from '@/components/ui/user-avatar';
import { useTranslations } from '@/i18n/use-translations';
import { useProjectSessionHref } from '@/lib/navigation/session-href';
import type { SessionMessageAuthor } from '@kortix/sdk';
import type { SessionMessagePromptInfo } from '@kortix/shared';
import { ArrowBendDownRightIcon, ChatCircleTextIcon, QuestionIcon } from '@phosphor-icons/react';

/**
 * Who the card names. The authors map comes from the server's record of the
 * credential and wins. The header is text an agent or a person could type, so
 * it only fills in a title when the map has nothing.
 */
function senderOf(info: SessionMessagePromptInfo, author?: SessionMessageAuthor) {
  if (author?.kind === 'session') return { sessionId: author.session_id, name: author.name };
  if (author?.kind === 'member') return { name: author.name };
  if (info.sender.kind === 'session') {
    return { sessionId: info.sender.sessionId, name: info.sender.title };
  }
  return { name: info.sender.name };
}

/** The sender as text, or as a link to its session. */
function SenderName({ sessionId, name }: { sessionId?: string; name: string }) {
  const sessionHref = useProjectSessionHref();
  const href = sessionId ? sessionHref(sessionId) : null;
  if (!href) return <span className="text-foreground font-medium">{name}</span>;
  return (
    <HoverPrefetchLink
      href={href}
      className="text-foreground font-medium underline-offset-2 hover:underline"
    >
      {name}
    </HoverPrefetchLink>
  );
}

/**
 * A message the viewer did not type: another session's agent, or the agent
 * that asked people a question. It sits on the left like an assistant turn,
 * under a line that says where it came from. The platform header is stripped
 * from `info.prompt` already.
 */
export function SessionMessageCard({
  info,
  author,
  replyHint,
}: {
  info: SessionMessagePromptInfo;
  author?: SessionMessageAuthor;
  /** The viewer is an addressee of this ask and nobody has answered yet. */
  replyHint?: boolean;
}) {
  const t = useTranslations('messageFrom');
  const sender = senderOf(info, author);
  const isAsk = info.type === 'ask';
  const Icon = isAsk ? QuestionIcon : ChatCircleTextIcon;
  const untitled = t('untitledSession');
  const name = sender.name || untitled;
  return (
    <div
      className="bg-popover flex w-full max-w-xl flex-col gap-1.5 rounded-md border px-4 py-2.5"
      data-testid="session-message-card"
      data-message-kind={info.type}
    >
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        {isAsk ? (
          <>
            <SenderName sessionId={sender.sessionId} name={name} />
            <span>{t('asked')}</span>
            <span className="text-foreground font-medium">
              {info.to.map((p) => p.name || p.email).join(', ')}
            </span>
          </>
        ) : (
          <>
            <span>{t('from')}</span>
            <SenderName sessionId={sender.sessionId} name={name} />
          </>
        )}
      </div>
      {info.prompt && (
        <div className="text-foreground text-sm wrap-break-word">
          <UnifiedMarkdown content={info.prompt} trust="agent" />
        </div>
      )}
      {replyHint && (
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <ArrowBendDownRightIcon className="size-3.5 shrink-0" aria-hidden />
          {t('replyHint')}
        </p>
      )}
    </div>
  );
}

/** The small name line above a bubble in a group chat. */
export function MessageAuthorLabel({ author }: { author: SessionMessageAuthor }) {
  if (author.kind === 'session') {
    return <SessionAuthorLabel author={author} />;
  }
  return (
    <span
      className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium"
      data-testid="message-author"
    >
      <UserAvatar email={author.email ?? ''} name={author.name} size="xs" />
      {author.name}
    </span>
  );
}

function SessionAuthorLabel({ author }: { author: Extract<SessionMessageAuthor, { kind: 'session' }> }) {
  const t = useTranslations('messageFrom');
  return (
    <span
      className="text-muted-foreground flex items-center gap-1.5 text-xs"
      data-testid="message-author"
    >
      <ChatCircleTextIcon className="size-3.5 shrink-0" aria-hidden />
      {t('from')}
      <SenderName sessionId={author.session_id} name={author.name || t('untitledSession')} />
    </span>
  );
}
