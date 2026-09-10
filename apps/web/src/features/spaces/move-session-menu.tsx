'use client';

/**
 * "Move to" — file a session under a space, or back at the project level.
 *
 * One `PATCH /projects/:id/sessions/:id { space }`. The server owns every
 * refusal: a space the caller is not granted is a 403, an undeclared one
 * a 400, and so is a move that would land the session's agent somewhere it
 * cannot run. Nothing is pre-validated here beyond hiding the control from
 * someone who could not use it — `can_manage_sharing` is the server's gate
 * too, because a `shared` space makes its sessions readable by everyone
 * granted it.
 *
 * Mounts inside a dropdown's content, so its space read only fires when a
 * menu is actually open.
 */

import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { errorToast, successToast } from '@/components/ui/toast';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import { updateProjectSession, type ProjectSession } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { FolderSimpleIcon } from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useProjectSpaces } from './spaces-data';

/** The radio value standing for "no space" — `''` is not selectable. */
const NO_SPACE = '__project__';

export function MoveSessionMenu({ session }: { session: ProjectSession }) {
  const tSpaces = useI18nTranslations('spaces');
  const projectId = session.project_id;
  const queryClient = useQueryClient();
  const spacesQuery = useProjectSpaces(projectId);
  const spaces = spacesQuery.data?.spaces ?? [];

  const move = useMutation({
    mutationFn: (slug: string | null) =>
      updateProjectSession(projectId, session.session_id, { space: slug }),
    onSuccess: (_result, slug) => {
      const name = spaces.find((s) => s.slug === slug)?.name;
      successToast(name ? tSpaces('move.movedTo', { name }) : tSpaces('move.movedOut'));
      // The row changes list: the sidebar's space folders and its
      // unfiled `Sessions` list read the same inventory entry, and each
      // space's `session_count` moved with it.
      queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) });
      queryClient.invalidateQueries({ queryKey: qk.project.spaces(projectId) });
    },
    onError: (error: Error) => errorToast(error.message || tSpaces('move.failed')),
  });

  // Nothing to move into, or no right to move it.
  if (spaces.length === 0 || session.can_manage_sharing === false) return null;

  const current = session.space ?? NO_SPACE;

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="cursor-pointer">
        <FolderSimpleIcon />
        {tSpaces('move.title')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-56">
        <DropdownMenuRadioGroup
          value={current}
          onValueChange={(next) => {
            if (next === current) return;
            move.mutate(next === NO_SPACE ? null : next);
          }}
        >
          <DropdownMenuRadioItem value={NO_SPACE} disabled={move.isPending}>
            {tSpaces('noSpace')}
          </DropdownMenuRadioItem>
          {spaces.length > 0 ? <DropdownMenuSeparator /> : null}
          {spaces.map((space) => (
            <DropdownMenuRadioItem
              key={space.slug}
              value={space.slug}
              disabled={move.isPending}
            >
              <span className="truncate">{space.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
