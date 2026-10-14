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
      /** Capability `member_tokens`: a 15-minute sign-in token for the App, naming the caller. */
      token: (appId: string) => P.createAppToken(projectId, appId),
      authEnv: (appId: string) => P.getAppAuthEnv(projectId, appId),
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
      /** Machines: stable ids across releases; destroying one keeps its volume. */
      machines: {
        list: (appId: string) => P.listAppMachines(projectId, appId),
        start: (appId: string, machineId: string) => P.startAppMachine(projectId, appId, machineId),
        stop: (appId: string, machineId: string) => P.stopAppMachine(projectId, appId, machineId),
        restart: (appId: string, machineId: string) => P.restartAppMachine(projectId, appId, machineId),
        destroy: (appId: string, machineId: string) => P.destroyAppMachine(projectId, appId, machineId),
      },
      /** Machines per process group (0-20). A group with a volume runs one unless `newVolumes`. */
      scale: (...a: DropFirst<Parameters<typeof P.scaleApp>>) => P.scaleApp(projectId, ...a),
      /** Run one command in a machine. Project admins only. */
      exec: (...a: DropFirst<Parameters<typeof P.execInApp>>) => P.execInApp(projectId, ...a),
      /** Volumes: persistent disks that outlive every release; daily snapshots. */
      volumes: {
        list: (appId: string) => P.listAppVolumes(projectId, appId),
        create: (...a: DropFirst<Parameters<typeof P.createAppVolume>>) => P.createAppVolume(projectId, ...a),
        update: (...a: DropFirst<Parameters<typeof P.updateAppVolume>>) => P.updateAppVolume(projectId, ...a),
        destroy: (...a: DropFirst<Parameters<typeof P.destroyAppVolume>>) => P.destroyAppVolume(projectId, ...a),
        snapshots: (...a: DropFirst<Parameters<typeof P.listAppVolumeSnapshots>>) => P.listAppVolumeSnapshots(projectId, ...a),
        snapshot: (...a: DropFirst<Parameters<typeof P.createAppVolumeSnapshot>>) => P.createAppVolumeSnapshot(projectId, ...a),
        restore: (...a: DropFirst<Parameters<typeof P.restoreAppVolume>>) => P.restoreAppVolume(projectId, ...a),
        fork: (...a: DropFirst<Parameters<typeof P.forkAppVolume>>) => P.forkAppVolume(projectId, ...a),
      },
    },
    /** Project-scoped CLI PATs (auto-minted at session-create as `KORTIX_TOKEN`; can also be minted by hand). */
  };
}
