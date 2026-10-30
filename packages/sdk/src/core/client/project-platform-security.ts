import * as P from '../rest/projects-client';
import { bindProjectPlatformSettings } from './project-platform-settings';

import type { DropFirst } from './binding-types';
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
      telegram: {
        installation: () => P.getTelegramInstallation(projectId),
        connect: (input: Parameters<typeof P.connectTelegram>[1]) => P.connectTelegram(projectId, input),
        /** Replace the whole allowed list. Prefer `allowUser` / `removeUser` for one person. */
        setAllowedUsers: (userIds: string[]) => P.setTelegramAllowedUsers(projectId, userIds),
        disconnect: () => P.disconnectTelegram(projectId),
        /** The allowed users and the people who asked for access, with their Telegram names. */
        users: () => P.listTelegramUsers(projectId),
        allowUser: (userId: string) => P.allowTelegramUser(projectId, userId),
        removeUser: (userId: string) => P.removeTelegramUser(projectId, userId),
        dismissAccessRequest: (userId: string) => P.dismissTelegramAccessRequest(projectId, userId),
        /** A user's profile photo through the Kortix API (the bot token stays server-side); null when none. */
        userPhoto: (...a: DropFirst<Parameters<typeof P.getTelegramUserPhoto>>) =>
          P.getTelegramUserPhoto(projectId, ...a),
      },
      email: {
        installation: (connectorSlug?: string | null) =>
          P.getEmailInstallation(projectId, connectorSlug),
        mode: () => P.getEmailMode(projectId),
        connect: (input: Parameters<typeof P.connectEmail>[1]) => P.connectEmail(projectId, input),
        disconnect: (connectorSlug?: string | null) => P.disconnectEmail(projectId, connectorSlug),
        updatePolicy: (...a: DropFirst<Parameters<typeof P.updateEmailPolicy>>) =>
          P.updateEmailPolicy(projectId, ...a),
        /** The domains a Resend API key can create inboxes on (no key: the managed domain). */
        domains: (input?: Parameters<typeof P.listEmailDomains>[1]) => P.listEmailDomains(projectId, input),
        /** Add a custom domain to your Resend account; returns the DNS records to set. */
        addDomain: (input: Parameters<typeof P.addEmailDomain>[1]) => P.addEmailDomain(projectId, input),
        /** Check a custom domain's DNS records again. */
        verifyDomain: (input: Parameters<typeof P.verifyEmailDomain>[1]) => P.verifyEmailDomain(projectId, input),
        /** The inboxes: accounts of the email connector. */
        inboxes: {
          list: () => P.listEmailInboxes(projectId),
          add: (input: Parameters<typeof P.addEmailInbox>[1]) => P.addEmailInbox(projectId, input),
          update: (...a: DropFirst<Parameters<typeof P.updateEmailInbox>>) => P.updateEmailInbox(projectId, ...a),
          remove: (connectionId: string) => P.removeEmailInbox(projectId, connectionId),
        },
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
