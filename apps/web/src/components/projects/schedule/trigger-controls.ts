'use client';

/**
 * Which trigger controls a viewer gets, one leaf per control (KRTX-1720):
 * each matches the route it calls (`apps/api/src/projects/routes/triggers.ts`).
 *
 * - create: New trigger (`project.trigger.create`)
 * - fire: Run now (`project.trigger.fire`): a built-in member holds it
 * - update: edit, Pause and Resume (`project.trigger.update`)
 * - delete: Delete (`project.trigger.delete`)
 *
 * The Triggers page and the Agent page both read this. They used to gate every
 * control on one flag derived from a different leaf on each page.
 */

import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { type CanResult, useProjectCans } from '@/lib/use-project-can';

export const TRIGGER_CONTROL_ACTIONS = [
  PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_DELETE,
] as const;

export interface TriggerControls {
  canCreate: boolean;
  canFire: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

/** A control shows only on an explicit allow: an unresolved probe hides it. */
export function triggerControlsFrom(cans: Partial<Record<string, Pick<CanResult, 'allowed'>>>): TriggerControls {
  const allowed = (action: string) => cans[action]?.allowed === true;
  return {
    canCreate: allowed(PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE),
    canFire: allowed(PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE),
    canUpdate: allowed(PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE),
    canDelete: allowed(PROJECT_ACTIONS.PROJECT_TRIGGER_DELETE),
  };
}

export function useTriggerControls(projectId: string): TriggerControls {
  return triggerControlsFrom(useProjectCans(projectId, TRIGGER_CONTROL_ACTIONS));
}
