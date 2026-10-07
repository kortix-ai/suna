import * as P from '../rest/projects-client';

import type { DropFirst } from './binding-types';
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
        /** Delete one non-live deployment, its runtime, and its image. */
        remove: (...a: DropFirst<Parameters<typeof P.deleteAppDeployment>>) =>
          P.deleteAppDeployment(projectId, ...a),
      },
      start: (appId: string) => P.startApp(projectId, appId),
      stop: (appId: string) => P.stopApp(projectId, appId),
      rollback: (...a: DropFirst<Parameters<typeof P.rollbackApp>>) =>
        P.rollbackApp(projectId, ...a),
    },

    backends: {
      list: () => P.listBackends(projectId),
      create: (input: Parameters<typeof P.createBackend>[1]) => P.createBackend(projectId, input),
      get: (backendId: string) => P.getBackend(projectId, backendId),
      waitUntilRunning: (backendId: string, options?: P.WaitForBackendOptions) =>
        P.waitForBackend(projectId, backendId, options),
      resize: (backendId: string, size: P.ProjectBackendSize) => P.resizeBackend(projectId, backendId, size),
      waitForOperation: (backendId: string, options?: P.WaitForBackendOperationOptions) =>
        P.waitForBackendOperation(projectId, backendId, options),
      backups: (backendId: string) => P.getBackendBackups(projectId, backendId),
      snapshot: (backendId: string) => P.createBackendSnapshot(projectId, backendId),
      restore: (backendId: string, snapshotId: string) =>
        P.restoreBackendSnapshot(projectId, backendId, snapshotId),
      credentials: (backendId: string) => P.getBackendCredentials(projectId, backendId),
      token: (backendId: string) => P.getBackendToken(projectId, backendId),
      rotateAdminKey: (backendId: string) => P.rotateBackendAdminKey(projectId, backendId),
      logs: (backendId: string, options?: P.GetBackendLogsOptions) => P.getBackendLogs(projectId, backendId, options),
      remove: (backendId: string) => P.deleteBackend(projectId, backendId),
    },

    /** Project-scoped CLI PATs (auto-minted at session-create as `KORTIX_TOKEN`; can also be minted by hand). */
  };
}
