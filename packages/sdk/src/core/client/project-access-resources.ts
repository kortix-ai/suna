import * as P from '../rest/projects-client';

type DropFirst<T extends unknown[]> = T extends [unknown, ...infer R] ? R : [];
export function bindProjectAccessResources(projectId: string) {
  return {
    apps: {
      list: () => P.listApps(projectId),
      create: (input: Parameters<typeof P.createApp>[1]) => P.createApp(projectId, input),
      get: (appId: string) => P.getApp(projectId, appId),
      update: (...a: DropFirst<Parameters<typeof P.updateApp>>) => P.updateApp(projectId, ...a),
      access: {
        get: (...a: DropFirst<Parameters<typeof P.getAppAccess>>) =>
          P.getAppAccess(projectId, ...a),
        update: (...a: DropFirst<Parameters<typeof P.updateAppAccess>>) =>
          P.updateAppAccess(projectId, ...a),
        session: (...a: DropFirst<Parameters<typeof P.createAppAccessSession>>) =>
          P.createAppAccessSession(projectId, ...a),
        /** Agents whose `kortix.yaml` `apps:` grant names this App. Read-only. */
        agents: (appId: string) => P.listAppAgents(projectId, appId),
      },
      remove: (appId: string) => P.deleteApp(projectId, appId),
      artifacts: {
        register: (input: Parameters<typeof P.registerAppArtifact>[1]) =>
          P.registerAppArtifact(projectId, input),
        uploadArchive: (...a: DropFirst<Parameters<typeof P.uploadAppArtifactArchive>>) =>
          P.uploadAppArtifactArchive(projectId, ...a),
        finalize: (...a: DropFirst<Parameters<typeof P.finalizeAppArtifact>>) =>
          P.finalizeAppArtifact(projectId, ...a),
      },
      deployments: {
        create: (...a: DropFirst<Parameters<typeof P.createAppDeployment>>) =>
          P.createAppDeployment(projectId, ...a),
        list: (appId: string) => P.listAppDeployments(projectId, appId),
        get: (...a: DropFirst<Parameters<typeof P.getAppDeployment>>) =>
          P.getAppDeployment(projectId, ...a),
        logs: (...a: DropFirst<Parameters<typeof P.getAppDeploymentLogs>>) =>
          P.getAppDeploymentLogs(projectId, ...a),
      },
      start: (appId: string) => P.startApp(projectId, appId),
      stop: (appId: string) => P.stopApp(projectId, appId),
      rollback: (...a: DropFirst<Parameters<typeof P.rollbackApp>>) =>
        P.rollbackApp(projectId, ...a),
    },

    /** Project-scoped CLI PATs (auto-minted at session-create as `KORTIX_TOKEN`; can also be minted by hand). */
  };
}
