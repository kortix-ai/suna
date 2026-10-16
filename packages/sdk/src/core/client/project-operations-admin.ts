import * as P from '../rest/projects-client';
import { bindProjectOperationsWorkspace } from './project-operations-workspace';

import type { DropFirst } from './binding-types';
export function bindProjectOperationsAdmin(projectId: string) {
  return {
    policies: {
      list: () => P.listProjectPolicies(projectId),
      set: (...a: DropFirst<Parameters<typeof P.setProjectPolicies>>) =>
        P.setProjectPolicies(projectId, ...a),
    },

    /** Reminders on every session the caller can open — see `listProjectReminders`. */
    reminders: {
      list: () => P.listProjectReminders(projectId),
      /** Pause or resume a selection — see `updateSessionReminders`. */
      updateMany: (...a: DropFirst<Parameters<typeof P.updateSessionReminders>>) =>
        P.updateSessionReminders(projectId, ...a),
      /** Remove a selection — see `deleteSessionReminders`. */
      removeMany: (...a: DropFirst<Parameters<typeof P.deleteSessionReminders>>) =>
        P.deleteSessionReminders(projectId, ...a),
    },
    triggers: {
      list: () => P.listProjectTriggers(projectId),
      eventApps: () => P.listProjectTriggerEventApps(projectId),
      eventTypes: (...a: DropFirst<Parameters<typeof P.listProjectTriggerEventTypes>>) =>
        P.listProjectTriggerEventTypes(projectId, ...a),
      create: (...a: DropFirst<Parameters<typeof P.createProjectTrigger>>) =>
        P.createProjectTrigger(projectId, ...a),
      update: (...a: DropFirst<Parameters<typeof P.updateProjectTrigger>>) =>
        P.updateProjectTrigger(projectId, ...a),
      remove: (...a: DropFirst<Parameters<typeof P.deleteProjectTrigger>>) =>
        P.deleteProjectTrigger(projectId, ...a),
      fire: ((slug: string, options?: P.FireProjectTriggerOptions) =>
        P.fireProjectTrigger(projectId, slug, options)) as {
        (slug: string, options: P.FireProjectTriggerOptions & { dryRun: true }): Promise<P.ProjectTriggerDryRunResult>;
        (slug: string, options?: P.FireProjectTriggerOptions): Promise<P.FireProjectTriggerResponse>;
      },
      /** One trigger's runs, newest first — see `listTriggerRuns`. */
      runs: (...a: DropFirst<Parameters<typeof P.listTriggerRuns>>) => P.listTriggerRuns(projectId, ...a),
      /** Every run of the project — see `listProjectTriggerRuns`. */
      projectRuns: (...a: DropFirst<Parameters<typeof P.listProjectTriggerRuns>>) =>
        P.listProjectTriggerRuns(projectId, ...a),
      /** Fire again with a past run's payload — see `replayTriggerRun`. */
      replay: (...a: DropFirst<Parameters<typeof P.replayTriggerRun>>) => P.replayTriggerRun(projectId, ...a),
      setActivation: (...a: DropFirst<Parameters<typeof P.setProjectTriggersActivation>>) =>
        P.setProjectTriggersActivation(projectId, ...a),
    },

    ...bindProjectOperationsWorkspace(projectId),
  };
}
