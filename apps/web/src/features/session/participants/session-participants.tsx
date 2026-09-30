'use client';

import { sessionMessageSender, type SessionParticipant, type SessionParticipants } from '@kortix/sdk';
import { useState, type ReactNode } from 'react';

import { AvatarGroup, AvatarGroupCount } from '@/components/ui/avatar';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import Hint from '@/components/ui/hint';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { UserAvatar } from '@/components/ui/user-avatar';
import { useTranslations } from '@/i18n/use-translations';

/** Faces shown in the header before the rest collapse into a count. */
const STACK_LIMIT = 3;

/** "You" for the viewer, else the display name, else the email local part. */
export function participantLabel(person: SessionParticipant, you: string): string {
  if (person.is_viewer) return you;
  return person.name?.trim() || person.email?.split('@')[0] || '';
}

/**
 * The person to show beside a message: its sender, unless that is the viewer.
 * Your own messages carry no avatar, in a shared session as in a private one.
 */
export function otherSender(
  participants: SessionParticipants | undefined,
  messageId: string,
): SessionParticipant | null {
  const sender = sessionMessageSender(participants, messageId);
  return sender?.is_viewer ? null : sender;
}

function ParticipantAvatar({ person, size }: { person: SessionParticipant; size: 'sm' | 'md' }) {
  return (
    <UserAvatar
      size={size}
      shape="circle"
      name={person.name}
      email={person.email ?? ''}
      avatarUrl={person.avatar_url}
      className="rounded-sm"
    />
  );
}

/**
 * Another person's message, in a shared session: their avatar beside the
 * bubble, level with its last line. The viewer's own messages pass no
 * sender and render unchanged.
 */
export function MessageSenderBeside({
  sender,
  children,
}: {
  sender: SessionParticipant | null | undefined;
  children: ReactNode;
}) {
  const t = useTranslations('sessionParticipants');
  if (!sender) return children;
  const name = participantLabel(sender, t('you'));
  return (
    <div className="flex max-w-full items-end gap-2">
      <div className="min-w-0">{children}</div>
      <span className="sr-only">{t('sentBy', { name })}</span>
      <Hint label={sender.email ?? name} side="top" delayDuration={300}>
        <span aria-hidden className="flex shrink-0">
          <ParticipantAvatar person={sender} size="sm" />
        </span>
      </Hint>
    </div>
  );
}

/**
 * The people who can open the session: overlapping avatars in the header.
 * Hover lists them in the sub-agent card's layout. Read-only: nothing in it
 * is clickable. Renders nothing unless two or more people can open it.
 */
export function SessionParticipantStack({
  participants,
}: {
  participants: SessionParticipants | undefined;
}) {
  const t = useTranslations('sessionParticipants');
  const [open, setOpen] = useState(false);
  if (!participants?.multi_user || participants.total < 2) return null;

  const shown = participants.participants.slice(0, STACK_LIMIT);
  const more = participants.total - shown.length;
  const names = shown
    .map((person) => participantLabel(person, t('you')))
    .filter(Boolean)
    .join(', ');
  const label = more > 0 ? t('peopleMore', { names, count: more }) : t('people', { names });

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>
        <span role="img" aria-label={label} className="flex h-7 items-center px-1">
          <AvatarGroup className="-space-x-1.5">
            {shown.map((person) => (
              <ParticipantAvatar key={person.user_id} person={person} size="sm" />
            ))}
            {more > 0 && (
              <AvatarGroupCount className="size-6 rounded-full text-xs tabular-nums">
                +{more}
              </AvatarGroupCount>
            )}
          </AvatarGroup>
        </span>
      </HoverCardTrigger>
      {/* Same card as `SubagentHoverCard`: a label and count, then rows in a
          capped scroll area. Not animated, for the same reason. Read-only. */}
      <HoverCardContent
        side="bottom"
        align="end"
        sideOffset={6}
        animated={false}
        className="w-72 overflow-hidden p-0"
        onEscapeKeyDown={() => setOpen(false)}
      >
        <div className="text-muted-foreground flex items-center justify-between px-3.5 pt-2.5 pb-1 text-xs">
          <span>{t('title')}</span>
          <span className="tabular-nums">{participants.total}</span>
        </div>
        <FadedScrollArea fadeColor="from-popover" fadeSize="6" className="max-h-64 overscroll-contain">
          <ul className="p-1 pt-0">
            {/* Plain rows, no hover highlight: nothing here is clickable. */}
            {participants.participants.map((person) => (
              <li key={person.user_id}>
                <div className="text-foreground flex min-h-9 items-center gap-2.5 px-2 py-1 text-sm">
                  <ParticipantAvatar person={person} size="md" />
                  {/* Name and email read as one block: tight leading, no gap. */}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate leading-tight">{participantLabel(person, t('you'))}</span>
                    {person.email ? (
                      <span className="text-muted-foreground truncate text-xs leading-tight">
                        {person.email}
                      </span>
                    ) : null}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </FadedScrollArea>
      </HoverCardContent>
    </HoverCard>
  );
}
