import * as P from '../rest/projects-client';
import { bindProjectPlatformSettings } from './project-platform-settings';

type DropFirst<T extends unknown[]> = T extends [unknown, ...infer R] ? R : [];
export function bindProjectPlatformSecurity(projectId: string) {
  return {
    channels: {
      slack: {
        installation: () => P.getSlackInstallation(projectId),
        connect: (input: Parameters<typeof P.connectSlack>[1]) => P.connectSlack(projectId, input),
        mode: () => P.getSlackMode(projectId),
        /** Finish an "Add to Slack" install as the signed-in user (web completion page). */
        completeInstall: (input: Parameters<typeof P.completeSlackInstall>[1]) =>
          P.completeSlackInstall(projectId, input),
        manifest: () => P.getSlackManifest(projectId),
        disconnect: () => P.disconnectSlack(projectId),
        /** Download a Slack-hosted file through the server-side proxy (bot token stays server-side). */
        getFile: (url: string) => P.getSlackChannelFile(projectId, url),
        /** Upload a file to Slack through the server-side 3-step external-upload proxy. */
        uploadFile: (input: Parameters<typeof P.uploadSlackChannelFile>[1]) =>
          P.uploadSlackChannelFile(projectId, input),
      },
      teams: {
        /** Finish a Microsoft Teams org install as the signed-in user (web completion page). */
        completeInstall: (input: Parameters<typeof P.completeTeamsInstall>[1]) =>
          P.completeTeamsInstall(projectId, input),
      },
      email: {
        installation: (connectorSlug?: string | null) =>
          P.getEmailInstallation(projectId, connectorSlug),
        mode: () => P.getEmailMode(projectId),
        connect: (input: Parameters<typeof P.connectEmail>[1]) => P.connectEmail(projectId, input),
        disconnect: (connectorSlug?: string | null) => P.disconnectEmail(projectId, connectorSlug),
        updatePolicy: (...a: DropFirst<Parameters<typeof P.updateEmailPolicy>>) =>
          P.updateEmailPolicy(projectId, ...a),
      },
    },

    /** Toggle a feature flag (Customize → Feature flags). Pass `enabled: null` to clear the override. */
    updateFeatureFlag: (...a: DropFirst<Parameters<typeof P.updateFeatureFlag>>) =>
      P.updateFeatureFlag(projectId, ...a),

    /** @deprecated Renamed to `updateFeatureFlag`. Keeps the legacy `/experimental` wire path for older deployed APIs. */
    updateExperimentalFeature: (...a: DropFirst<Parameters<typeof P.updateExperimentalFeature>>) =>
      P.updateExperimentalFeature(projectId, ...a),

    /** Default model preferences (account/agent/project scope, gateway-resolved). */
    ...bindProjectPlatformSettings(projectId),
  };
}
