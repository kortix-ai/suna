'use client';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { UserAvatar } from '@/components/ui/user-avatar';
import { useTranslations } from '@/i18n/use-translations';
import { useProjectSessionHref } from '@/lib/navigation/session-href';
import type { SessionMessageAuthor } from '@kortix/sdk';
import { ChatCircleTextIcon } from '@phosphor-icons/react';

/** The sender as text, or as a link to its session. An agent's name carries
 *  its session's title as the tooltip. */
function SenderName({ sessionId, name, title }: { sessionId?: string; name: string; title?: string }) {
  const sessionHref = useProjectSessionHref();
  const href = sessionId ? sessionHref(sessionId) : null;
  if (!href) return <span className="text-foreground font-medium">{name}</span>;
  return (
    <HoverPrefetchLink
      href={href}
      title={title && title !== name ? title : undefined}
      className="text-foreground font-medium underline-offset-2 hover:underline"
    >
      {name}
    </HoverPrefetchLink>
  );
}

/** The small name line above a bubble in a session several people write in. */
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
      <SenderName
        sessionId={author.session_id}
        name={author.agent || author.name || t('untitledSession')}
        title={author.name}
      />
    </span>
  );
}
