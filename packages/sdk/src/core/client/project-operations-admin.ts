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
    /** Conversations between sessions and people (flag `agent_rooms`) — see `listRooms`. */
    rooms: {
      list: (...a: DropFirst<Parameters<typeof P.listRooms>>) => P.listRooms(projectId, ...a),
      create: (...a: DropFirst<Parameters<typeof P.createRoom>>) => P.createRoom(projectId, ...a),
      get: (...a: DropFirst<Parameters<typeof P.getRoom>>) => P.getRoom(projectId, ...a),
      update: (...a: DropFirst<Parameters<typeof P.updateRoom>>) => P.updateRoom(projectId, ...a),
      direct: (...a: DropFirst<Parameters<typeof P.openDirectConversation>>) => P.openDirectConversation(projectId, ...a),
      messages: (...a: DropFirst<Parameters<typeof P.listRoomMessages>>) => P.listRoomMessages(projectId, ...a),
      post: (...a: DropFirst<Parameters<typeof P.postRoomMessage>>) => P.postRoomMessage(projectId, ...a),
      markRead: (...a: DropFirst<Parameters<typeof P.markRoomRead>>) => P.markRoomRead(projectId, ...a),
      addSession: (...a: DropFirst<Parameters<typeof P.addRoomSession>>) => P.addRoomSession(projectId, ...a),
      removeSession: (...a: DropFirst<Parameters<typeof P.removeRoomSession>>) => P.removeRoomSession(projectId, ...a),
      addPerson: (...a: DropFirst<Parameters<typeof P.addRoomPerson>>) => P.addRoomPerson(projectId, ...a),
      removePerson: (...a: DropFirst<Parameters<typeof P.removeRoomPerson>>) => P.removeRoomPerson(projectId, ...a),
      people: (...a: DropFirst<Parameters<typeof P.listRoomPeople>>) => P.listRoomPeople(projectId, ...a),
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
        (
          slug: string,
          options?: P.FireProjectTriggerOptions & { dryRun?: false },
        ): Promise<P.FireProjectTriggerResponse>;
        (
          slug: string,
          options?: P.FireProjectTriggerOptions,
        ): Promise<P.FireProjectTriggerResponse | P.ProjectTriggerDryRunResult>;
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
