'use client';

/**
 * The one read every subprojects surface shares, plus the single SDK gap this
 * feature works around.
 *
 * **The gap.** The API carries `subproject` on every trigger (spec §6:
 * `GitTriggerSpec.subproject`, accepted on POST/PATCH `/triggers`), but the
 * published `@kortix/sdk` trigger types — `ProjectTrigger`,
 * `CreateProjectTriggerInput`, `UpdateProjectTriggerInput` — do not declare
 * the field yet. Host code must not raw-fetch, so the three helpers below
 * read and write that ONE field through the SDK's own calls with a local
 * widening. Delete them the moment the SDK declares it; nothing else in
 * `apps/web` knows about the widening.
 *
 * **The second gap.** `AssignmentObjectType` is
 * `'agent' | 'skill' | 'secret' | 'app' | 'trigger'` — it has not been widened
 * with `'subproject'`, even though `ResourceGrantType` has and the API accepts
 * `object: { type: 'subproject' }` on `POST /iam/assignments` (spec §5).
 * `SUBPROJECT_OBJECT_TYPE` below is the ONE place that asserts it, so there is
 * one line to delete rather than four casts scattered through the access
 * dialog.
 */

import {
  listProjectSubprojects,
  type AssignmentObjectType,
  type ProjectTrigger,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

/**
 * Every subproject the caller may see, sorted by slug by the API.
 * `contract('config')` — manifest data, changed only by this app's own
 * mutations, which invalidate `qk.project.subprojects(projectId)`.
 */
export function useProjectSubprojects(projectId: string, enabled = true) {
  return useQuery({
    queryKey: qk.project.subprojects(projectId),
    queryFn: () => listProjectSubprojects(projectId),
    enabled: enabled && !!projectId,
    ...contract('config'),
  });
}

/** The subproject a trigger is filed under, or null. See the SDK gap above. */
export function triggerSubproject(trigger: ProjectTrigger): string | null {
  return (trigger as { subproject?: string | null }).subproject ?? null;
}

/** The triggers filed under `slug`, in the order the API lists them. */
export function triggersForSubproject(
  triggers: readonly ProjectTrigger[],
  slug: string,
): ProjectTrigger[] {
  return triggers.filter((trigger) => triggerSubproject(trigger) === slug);
}

/**
 * Put `subproject` on a trigger create/update body. `undefined` leaves the
 * body untouched (the field is not being edited); `null` clears the
 * back-reference, which is what the "None" option in the pickers sends.
 */
export function withTriggerSubproject<T extends object>(
  input: T,
  subproject: string | null | undefined,
): T {
  return subproject === undefined ? input : ({ ...input, subproject } as T);
}

/**
 * `'subproject'` as an assignment object type. See the second SDK gap above:
 * the API takes it, the published union does not list it yet.
 */
export const SUBPROJECT_OBJECT_TYPE = 'subproject' as AssignmentObjectType;
