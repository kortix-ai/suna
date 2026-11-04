'use client';

import { ApiError, type ProjectSession } from '@kortix/sdk';
import { useFeatureFlag, useMoveProjectSessionToSpace, useProjectSpaces } from '@kortix/sdk/react';
import { ArrowBendUpRightIcon } from '@phosphor-icons/react';

import { useTranslations } from '../../i18n';
import { SolidCheckIcon } from '../../internal/icons/solid-check-icon';
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '../../primitives/dropdown-menu';
import { errorToast, successToast } from '../../primitives/toast';
import { ChannelGlyph } from './channel-glyph';

/**
 * "Move to channel" in a session's menu: the project's live channels, the
 * current one checked, then "No channel". Drawn only with `project_channels`
 * on, for a root session the viewer started (the server refuses anyone else).
 * A session in a private channel stays there: the item is disabled and says so.
 * Moving organizes the session; it does not change who can open it.
 */
export function MoveSessionToSpaceMenu({ projectId, session }: { projectId: string; session: ProjectSession }) {
  const t = useTranslations('spaces.move');
  const channelsOn = useFeatureFlag(projectId, 'project_channels').enabled;
  const spaces = useProjectSpaces(projectId, { enabled: channelsOn });
  const move = useMoveProjectSessionToSpace(projectId);
  if (!channelsOn || !session.is_owner || session.parent_session_id || !spaces.data) return null;

  const current = spaces.data.find((space) => space.space_id === session.space_id) ?? null;
  const channels = spaces.data.filter((space) => space.kind === 'channel' && !space.archived_at);
  const lockedInPrivate = current?.kind === 'channel' && current.visibility === 'private';

  const moveTo = (spaceId: string | null, label: string | null) =>
    move.mutate(
      { sessionId: session.session_id, spaceId },
      {
        onSuccess: () => successToast(label ? t('moved', { place: label }) : t('removed')),
        onError: (error) =>
          errorToast(t(error instanceof ApiError && error.code === 'session_in_private_channel' ? 'privateStays' : 'failed')),
      },
    );

  if (lockedInPrivate) {
    return (
      <DropdownMenuItem disabled>
        <ArrowBendUpRightIcon />
        {t('privateStays')}
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="cursor-pointer">
        <ArrowBendUpRightIcon />
        {t('label')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
        {channels.map((channel) => {
          const label = `#${channel.slug ?? channel.name}`;
          const here = channel.space_id === session.space_id;
          return (
            <DropdownMenuItem
              key={channel.space_id}
              className="cursor-pointer"
              disabled={move.isPending}
              onSelect={() => (here ? undefined : moveTo(channel.space_id, label))}
            >
              <ChannelGlyph visibility={channel.visibility} />
              <span className="min-w-0 flex-1 truncate">{channel.slug ?? channel.name}</span>
              {here ? <SolidCheckIcon className="size-3.5 shrink-0" aria-label={t('current')} /> : null}
            </DropdownMenuItem>
          );
        })}
        {session.space_id ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="cursor-pointer" disabled={move.isPending} onSelect={() => moveTo(null, null)}>
              {t('none')}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
