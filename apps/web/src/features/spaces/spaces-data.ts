'use client';

/**
 * The one read every spaces surface shares, plus the single SDK gap this
 * feature works around.
 *
 * **The gap.** The API carries `space` on every trigger (spec §6:
 * `GitTriggerSpec.space`, accepted on POST/PATCH `/triggers`), but the
 * published `@kortix/sdk` trigger types — `ProjectTrigger`,
 * `CreateProjectTriggerInput`, `UpdateProjectTriggerInput` — do not declare
 * the field yet. Host code must not raw-fetch, so the three helpers below
 * read and write that ONE field through the SDK's own calls with a local
 * widening. Delete them the moment the SDK declares it; nothing else in
 * `apps/web` knows about the widening.
 *
 * **The second gap.** `AssignmentObjectType` is
 * `'agent' | 'skill' | 'secret' | 'app' | 'trigger'` — it has not been widened
 * with `'space'`, even though `ResourceGrantType` has and the API accepts
 * `object: { type: 'space' }` on `POST /iam/assignments` (spec §5).
 * `SPACE_OBJECT_TYPE` below is the ONE place that asserts it, so there is
 * one line to delete rather than four casts scattered through the access
 * dialog.
 */

import {
  listProjectSpaces,
  type AssignmentObjectType,
  type ProjectTrigger,
} from '@kortix/sdk';
import { contract, qk, useFeatureFlag } from '@kortix/sdk/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

/**
 * Every space the caller may see, sorted by slug by the API.
 * `contract('config')` — manifest data, changed only by this app's own
 * mutations, which invalidate `qk.project.spaces(projectId)`.
 */
export function useProjectSpaces(projectId: string, enabled = true) {
  // The one place the `spaces` flag reaches every picker. Off ⇒ the request is
  // never made and every consumer reads zero spaces, so the composer tray, the
  // schedule modal's picker and the move menu all empty themselves without
  // knowing the flag exists. It reads the same `qk.project.detail` entry the
  // rest of the page already has, so this costs no extra fetch, and it is
  // fail-closed: `false` until that detail resolves.
  //
  // Surfaces that still render something at zero spaces — the sidebar group's
  // "+" for someone who may create, and the move menu's submenu — carry their
  // own check; this hook cannot hide their chrome for them.
  const spacesFlag = useFeatureFlag(projectId, 'spaces');
  return useQuery({
    queryKey: qk.project.spaces(projectId),
    queryFn: () => listProjectSpaces(projectId),
    enabled: enabled && spacesFlag.enabled && !!projectId,
    ...contract('config'),
  });
}

/** Refetch the list AND the single-item entry after a write. Both keys move
 *  together — the page reads one, the sidebar and the pickers read the other. */
export function useInvalidateSpace(projectId: string, slug: string) {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.project.spaces(projectId) }),
      queryClient.invalidateQueries({ queryKey: qk.project.space(projectId, slug) }),
    ]);
  }, [queryClient, projectId, slug]);
}

/** The space a trigger is filed under, or null. See the SDK gap above. */
export function triggerSpace(trigger: ProjectTrigger): string | null {
  return (trigger as { space?: string | null }).space ?? null;
}

/** The triggers filed under `slug`, in the order the API lists them. */
export function triggersForSpace(
  triggers: readonly ProjectTrigger[],
  slug: string,
): ProjectTrigger[] {
  return triggers.filter((trigger) => triggerSpace(trigger) === slug);
}

/**
 * Put `space` on a trigger create/update body. `undefined` leaves the
 * body untouched (the field is not being edited); `null` clears the
 * back-reference, which is what the "None" option in the pickers sends.
 */
export function withTriggerSpace<T extends object>(
  input: T,
  space: string | null | undefined,
): T {
  return space === undefined ? input : ({ ...input, space } as T);
}

/**
 * `'space'` as an assignment object type. See the second SDK gap above:
 * the API takes it, the published union does not list it yet.
 */
export const SPACE_OBJECT_TYPE = 'space' as AssignmentObjectType;
