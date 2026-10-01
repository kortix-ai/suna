'use client';

import type { SessionParticipant, SessionParticipants } from '@kortix/sdk';
import { useState, type ReactNode } from 'react';

import { AvatarGroup, AvatarGroupCount } from '@/components/ui/avatar';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import Hint from '@/components/ui/hint';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { UserAvatar } from '@/components/ui/user-avatar';
import { useTranslations } from '@/i18n/use-translations';

/** Faces shown in the header before the rest collapse into a count. */
const STACK_LIMIT = 3;

/** What an avatar needs: a participant, or a message's member author. */
type AvatarPerson = Pick<SessionParticipant, 'name' | 'email'> & { avatar_url?: string | null };

/** The display name, else the email local part. The viewer too: every row names a person. */
export function participantLabel(person: AvatarPerson): string {
  return person.name?.trim() || person.email?.split('@')[0] || '';
}

function ParticipantAvatar({ person, size }: { person: AvatarPerson; size: 'sm' | 'md' }) {
  return (
    <UserAvatar
      size={size}
      name={person.name}
      email={person.email ?? ''}
      avatarUrl={person.avatar_url ?? null}
      className="rounded-sm"
    />
  );
}

/**
 * A message in a shared session: its member author's avatar beside the
 * bubble, your own included, bottom edges aligned (`items-end`). A message
 * with no recorded author, or any message in a single-user session, renders
 * alone. The author comes from `.../message-authors`.
 */
export function MessageSenderBeside({
  sender,
  children,
}: {
  sender: AvatarPerson | null | undefined;
  children: ReactNode;
}) {
  const t = useTranslations('sessionParticipants');
  if (!sender) return children;
  const name = participantLabel(sender);
  return (
    <div className="flex max-w-full items-end gap-2">
      {/* `flex`, not a block: no inline line box to pad the bottom edge. */}
      <div className="flex min-w-0">{children}</div>
      <span className="sr-only">{t('sentBy', { name })}</span>
      <Hint label={sender.email ?? name} side="top" delayDuration={300}>
        <span aria-hidden className="flex shrink-0 mb-px">
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
    .map((person) => participantLabel(person))
    .filter(Boolean)
    .join(', ');
  const label = more > 0 ? t('peopleMore', { names, count: more }) : t('people', { names });

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>
        <span role="img" aria-label={label} className="hover:bg-secondary flex h-7 cursor-pointer items-center rounded-md p-0.5">
          <AvatarGroup className="-space-x-1.5">
            {shown.map((person) => (
              <ParticipantAvatar key={person.user_id} person={person} size="sm" />
            ))}
            {more > 0 && (
              <AvatarGroupCount className="size-6 text-xs tabular-nums">
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
                    <span className="truncate leading-tight">{participantLabel(person)}</span>
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
