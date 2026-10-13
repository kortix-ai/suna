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
 * The leaves and the mapping live in `@kortix/sdk` (`TRIGGER_CONTROL_ACTIONS`,
 * `triggerControlsFrom`), so mobile Schedules shows the same controls. The
 * Triggers page and the Agent page both read this hook.
 */

import { useProjectCans } from '@/lib/use-project-can';
import { TRIGGER_CONTROL_ACTIONS, type TriggerControls, triggerControlsFrom } from '@kortix/sdk';

export { TRIGGER_CONTROL_ACTIONS, type TriggerControls, triggerControlsFrom };

export function useTriggerControls(projectId: string): TriggerControls {
  return triggerControlsFrom(useProjectCans(projectId, TRIGGER_CONTROL_ACTIONS));
}
