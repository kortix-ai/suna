import * as P from '../rest/projects-client';
import { bindProjectOperationsWorkspace } from './project-operations-workspace';

import type { projectConnections } from './project-connections';
type DropFirst<T extends unknown[]> = T extends [unknown, ...infer R] ? R : [];
export function bindProjectOperationsAdmin(
  projectId: string,
  connections: ReturnType<typeof projectConnections>,
) {
  return {
    policies: {
      list: () => P.listProjectPolicies(projectId),
      set: (...a: DropFirst<Parameters<typeof P.setProjectPolicies>>) =>
        P.setProjectPolicies(projectId, ...a),
    },

    /** Reminders on every session the caller can open — see `listProjectReminders`. */
    reminders: {
      list: () => P.listProjectReminders(projectId),
    },
    triggers: {
      list: () => P.listProjectTriggers(projectId),
      create: (...a: DropFirst<Parameters<typeof P.createProjectTrigger>>) =>
        P.createProjectTrigger(projectId, ...a),
      update: (...a: DropFirst<Parameters<typeof P.updateProjectTrigger>>) =>
        P.updateProjectTrigger(projectId, ...a),
      remove: (...a: DropFirst<Parameters<typeof P.deleteProjectTrigger>>) =>
        P.deleteProjectTrigger(projectId, ...a),
      fire: (...a: DropFirst<Parameters<typeof P.fireProjectTrigger>>) =>
        P.fireProjectTrigger(projectId, ...a),
      setActivation: (...a: DropFirst<Parameters<typeof P.setProjectTriggersActivation>>) =>
        P.setProjectTriggersActivation(projectId, ...a),
    },

    ...bindProjectOperationsWorkspace(projectId),
  };
}
