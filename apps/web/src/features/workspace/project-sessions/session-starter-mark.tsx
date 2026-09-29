'use client';

import { sessionSource } from '@/components/projects/session-label';
import { sessionStarter, type SessionStarter } from '@/components/projects/session-starter';
import { KortixLogo } from '@/components/ui/kortix-logo';
import { UserAvatar } from '@/components/ui/user-avatar';
import { SOURCE_ICONS } from '@/features/workspace/project-sidebar/session-source-icons';
import { useAuth } from '@/features/providers/auth-provider';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { ProjectSession } from '@kortix/sdk';
import { ChatTeardropTextIcon, KeyIcon } from '@phosphor-icons/react';
import { useMemo } from 'react';

/** The session's starter, resolved against the signed-in viewer. */
export function useSessionStarter(session: ProjectSession): SessionStarter {
  const { user } = useAuth();
  const t = useTranslations('sidebar.filter');
  const you = t('ownerValue.you');
  const unknown = t('ownerValue.unknown');
  return useMemo(
    () => sessionStarter(session, user?.id ?? null, { you, unknown }),
    [session, user?.id, you, unknown],
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  if (starter.type === 'member') {
    return (
      <UserAvatar
        size="sm"
        className={avatarClassName}
        name={starter.isViewer ? undefined : starter.label}
        email={starter.isViewer ? '' : (session.owner_email ?? '')}
      />
    );
  }
  if (starter.type === 'system') return <KortixLogo variant="icon" size={12} />;
  let Icon: (typeof SOURCE_ICONS)[keyof typeof SOURCE_ICONS] | typeof KeyIcon = ChatTeardropTextIcon;
  if (starter.type === 'api') Icon = KeyIcon;
  else if (starter.type === 'channel') {
    Icon = SOURCE_ICONS[(starter.id ?? '') as keyof typeof SOURCE_ICONS] ?? ChatTeardropTextIcon;
  } else {
    // A trigger: schedule for cron, webhook otherwise.
    Icon = sessionSource(session, tI18nComplete).kind === 'webhook' ? SOURCE_ICONS.webhook : SOURCE_ICONS.schedule;
  }
  return <Icon className={cn('size-4', iconClassName)} />;
}
