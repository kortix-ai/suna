'use client';

/**
 * "Move to" — file a session under a subproject, or back at the project level.
 *
 * One `PATCH /projects/:id/sessions/:id { subproject }`. The server owns every
 * refusal: a subproject the caller is not granted is a 403, an undeclared one
 * a 400, and so is a move that would land the session's agent somewhere it
 * cannot run. Nothing is pre-validated here beyond hiding the control from
 * someone who could not use it — `can_manage_sharing` is the server's gate
 * too, because a `shared` subproject makes its sessions readable by everyone
 * granted it.
 *
 * Mounts inside a dropdown's content, so its subproject read only fires when a
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
import { updateProjectSession, type ProjectSession } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { FolderSimpleIcon } from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useProjectSubprojects } from './subprojects-data';

/** The radio value standing for "no subproject" — `''` is not selectable. */
const NO_SUBPROJECT = '__project__';

export function MoveSessionMenu({ session }: { session: ProjectSession }) {
  const projectId = session.project_id;
  const queryClient = useQueryClient();
  const subprojectsQuery = useProjectSubprojects(projectId);
  const subprojects = subprojectsQuery.data?.subprojects ?? [];

  const move = useMutation({
    mutationFn: (slug: string | null) =>
      updateProjectSession(projectId, session.session_id, { subproject: slug }),
    onSuccess: (_result, slug) => {
      const name = subprojects.find((s) => s.slug === slug)?.name;
      successToast(name ? `Moved to ${name}` : 'Moved out of the subproject');
      // The row changes list: the sidebar's subproject folders and its
      // unfiled `Sessions` list read the same inventory entry, and each
      // subproject's `session_count` moved with it.
      queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) });
      queryClient.invalidateQueries({ queryKey: qk.project.subprojects(projectId) });
    },
    onError: (error: Error) => errorToast(error.message || 'Could not move the session'),
  });

  // Nothing to move into, or no right to move it.
  if (subprojects.length === 0 || session.can_manage_sharing === false) return null;

  const current = session.subproject ?? NO_SUBPROJECT;

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="cursor-pointer">
        <FolderSimpleIcon />
        Move to
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-56">
        <DropdownMenuRadioGroup
          value={current}
          onValueChange={(next) => {
            if (next === current) return;
            move.mutate(next === NO_SUBPROJECT ? null : next);
          }}
        >
          <DropdownMenuRadioItem value={NO_SUBPROJECT} disabled={move.isPending}>
            No subproject
          </DropdownMenuRadioItem>
          {subprojects.length > 0 ? <DropdownMenuSeparator /> : null}
          {subprojects.map((subproject) => (
            <DropdownMenuRadioItem
              key={subproject.slug}
              value={subproject.slug}
              disabled={move.isPending}
            >
              <span className="truncate">{subproject.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
