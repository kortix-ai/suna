'use client';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { UserAvatar } from '@/components/ui/user-avatar';
import { Copy } from '@/features/icon/icons/copy';
import { useCopy } from '@/hooks/use-copy';
import { cn } from '@/lib/utils';
import { useTranslations } from '@/i18n/use-translations';
import { useProjectSessionHref } from '@/lib/navigation/session-href';
import type { SessionMessageAuthor } from '@kortix/sdk';
import { CheckIcon } from '@phosphor-icons/react';
import { KortixLogo } from '@/components/ui/kortix-logo';
import { SourceCard, SourcePill } from './source-pill';

/** The sending session's name, as a link to it when the project route resolves. */
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

/**
 * A prompt another Kortix session sent (`kortix sessions new`, a coordinator,
 * a spawned child): the same source pill a Slack or Teams message gets —
 * Kortix mark · Kortix · sending agent — not a separate icon-and-text line.
 * The hover card links the sending session and shows its `session_id`; a
 * click on the id copies it.
 */
function SessionAuthorLabel({ author }: { author: Extract<SessionMessageAuthor, { kind: 'session' }> }) {
  const t = useTranslations('messageFrom');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const sessionName = author.name || t('untitledSession');
  return (
    <SourcePill
      mark={<KortixLogo variant="icon" size={12} className="shrink-0" />}
      source="Kortix"
      sender={author.agent || sessionName}
      // A `ses_…` id is ~30 mono characters: the default card truncates it.
      cardClassName={author.session_id ? 'w-96' : undefined}
      card={
        <SourceCard
          mark={<KortixLogo variant="icon" size={14} className="shrink-0" />}
          title="Kortix"
          rows={[
            {
              label: tI18nComplete('text6959b4159575'),
              value: <SenderName sessionId={author.session_id} name={sessionName} />,
            },
            { label: tI18nComplete('text11b39c93777e'), value: author.agent },
            {
              label: tI18nComplete('textcb9ac5c561da'),
              value: author.session_id ? <CopySessionId sessionId={author.session_id} /> : null,
            },
          ]}
        />
      }
    />
  );
}

/**
 * The sending session's id, always shown. A copy icon appears after it on
 * hover or focus; a click copies the id and swaps the icon for `CheckIcon` —
 * the confirm the code-block `CopyButton` gives, no toast, no text swap. The
 * id and both glyphs share one 16px line box, so they centre on the y-axis.
 */
function CopySessionId({ sessionId }: { sessionId: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { copied, copy } = useCopy({ toast: false });
  return (
    <button
      type="button"
      onClick={() => void copy(sessionId)}
      aria-label={`${tI18nComplete.raw('texte21f935f11d7')} ${sessionId}`}
      className="group/copy text-foreground focus-visible:ring-ring flex max-w-full items-center gap-1 rounded-sm focus-visible:ring-2 focus-visible:outline-none"
    >
      <span className="truncate font-mono leading-4">{sessionId}</span>
      <span
        aria-hidden
        className={cn(
          'text-muted-foreground flex size-4 shrink-0 items-center justify-center transition-opacity duration-(--duration-normal)',
          copied ? 'opacity-100' : 'opacity-0 group-hover/copy:opacity-100 group-focus-visible/copy:opacity-100',
        )}
      >
        {copied ? <CheckIcon className="text-foreground size-3.5" /> : <Copy className="size-3.5" />}
      </span>
    </button>
  );
}
