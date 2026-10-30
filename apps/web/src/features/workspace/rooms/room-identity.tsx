'use client';

import { EntityAvatar, type EntityAvatarSize } from '@kortix/ui/entity-avatar';
import { STATUS_DOT, type StatusTone } from '@kortix/ui/status';
import { UserAvatar, type UserAvatarSize } from '@kortix/ui/user-avatar';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@kortix/ui';
import { RobotIcon } from '@phosphor-icons/react';

import { sessionDisplay } from './room-text';

export type ParticipantKind = 'session' | 'person';

/** Session status → one dot hue (D5): running is green, a failure red, the rest idle. */
export function sessionStatusTone(status: string | null | undefined): StatusTone {
  if (status === 'running') return 'success';
  if (status === 'failed') return 'destructive';
  return 'neutral';
}

/** The `rooms.status.*` key for a session status. */
export function sessionStatusKey(status: string | null | undefined) {
  switch (status) {
    case 'running':
      return 'status.running' as const;
    case 'failed':
      return 'status.failed' as const;
    case 'queued':
    case 'branching':
    case 'provisioning':
      return 'status.starting' as const;
    default:
      return 'status.stopped' as const;
  }
}

/** A session's status as a dot plus the word for screen readers and the hover label. */
export function StatusDot({ status, className }: { status: string | null | undefined; className?: string }) {
  const t = useTranslations('rooms');
  return (
    <span
      role="img"
      aria-label={t(sessionStatusKey(status))}
      className={cn('size-2 shrink-0 rounded-full', STATUS_DOT[sessionStatusTone(status)], className)}
    />
  );
}

/**
 * One mark per participant kind, used by every rooms surface: a person is a
 * `UserAvatar`, an agent session an `EntityAvatar` with the robot glyph. A
 * session with a known status carries a presence dot on its corner (Slack).
 */
export function ParticipantAvatar({
  kind,
  label,
  userId,
  status,
  size = 'sm',
}: {
  kind: ParticipantKind;
  label: string;
  userId?: string | null;
  status?: string | null;
  size?: UserAvatarSize & EntityAvatarSize;
}) {
  if (kind === 'person') return <UserAvatar email={userId ?? label} name={label} size={size} />;
  const avatar = <EntityAvatar label={sessionDisplay(label).name} icon={RobotIcon} size={size} />;
  if (status === undefined) return avatar;
  return (
    <span className="relative inline-flex shrink-0">
      {avatar}
      <StatusDot status={status} className="ring-background absolute -right-0.5 -bottom-0.5 ring-2" />
    </span>
  );
}
