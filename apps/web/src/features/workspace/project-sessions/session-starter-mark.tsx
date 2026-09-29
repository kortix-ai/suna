'use client';

import { KortixLogo } from '@/components/ui/kortix-logo';
import { UserAvatar } from '@/components/ui/user-avatar';
import { SOURCE_ICONS } from '@/features/workspace/project-sidebar/session-source-icons';
import { useAuth } from '@/features/providers/auth-provider';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { sessionStarter, type ProjectSession, type SessionStarter } from '@kortix/sdk';
import { ChatTeardropTextIcon, KeyIcon } from '@phosphor-icons/react';
import { useMemo } from 'react';

/** The session's starter, resolved against the signed-in viewer. */
export function useSessionStarter(session: ProjectSession): SessionStarter {
  const { user } = useAuth();
  const t = useTranslations('sidebar.filter');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const you = t('ownerValue.you');
  const member = t('ownerValue.unknown');
  const system = tI18nComplete.raw('textab54cf5e1d9d');
  return useMemo(
    () => sessionStarter(session, user?.id ?? null, { you, member, system }),
    [session, user?.id, you, member, system],
  );
}

/**
 * One glyph per starter type: the member's avatar, the trigger's schedule or
 * webhook icon, the channel's own icon, a key for an API caller, the Kortix
 * mark for the platform. Never an emoji.
 */
export function SessionStarterMark({
  session,
  starter,
  iconClassName,
  avatarClassName,
}: {
  session: ProjectSession;
  starter: SessionStarter;
  iconClassName?: string;
  avatarClassName?: string;
}) {
  const { user } = useAuth();
  if (starter.type === 'member') {
    // The viewer's own row draws the viewer's avatar, never the "You" label's initial.
    const metadataName = user?.user_metadata?.full_name ?? user?.user_metadata?.name;
    return (
      <UserAvatar
        size="sm"
        className={avatarClassName}
        name={starter.isViewer ? (typeof metadataName === 'string' ? metadataName : undefined) : starter.label}
        email={starter.isViewer ? (user?.email ?? '') : (session.owner_email ?? '')}
      />
    );
  }
  if (starter.type === 'system') return <KortixLogo variant="icon" size={12} />;
  // A trigger with no schedule/webhook kind keeps the schedule glyph; an
  // unknown channel keeps the chat glyph.
  const icon = starter.icon === 'trigger' ? 'schedule' : starter.icon;
  const Icon =
    icon === 'api'
      ? KeyIcon
      : icon && icon !== 'channel'
        ? SOURCE_ICONS[icon]
        : ChatTeardropTextIcon;
  return <Icon className={cn('size-4', iconClassName)} />;
}
