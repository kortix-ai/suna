import * as P from '../rest/projects-client';
import { bindProjectMembership } from './project-membership';

import type { DropFirst } from './binding-types';
export function bindProjectAccessSecurity(projectId: string) {
  return {
    tokens: {
      list: () => P.listProjectCliTokens(projectId),
      create: (input?: Parameters<typeof P.createProjectCliToken>[1]) =>
        P.createProjectCliToken(projectId, input),
      revoke: (tokenId: string) => P.revokeProjectCliToken(projectId, tokenId),
    },

    /** Agent-minted setup links — hand a human a link to enter a secret value or 1-click connect an app. */
    setupLinks: {
      requestSecret: (input: Parameters<typeof P.requestProjectSecret>[1]) =>
        P.requestProjectSecret(projectId, input),
      requestConnector: (input: Parameters<typeof P.requestProjectConnector>[1]) =>
        P.requestProjectConnector(projectId, input),
    },

    /** Validate a `kortix.yaml` (or legacy `kortix.toml`) manifest's raw text server-side — format is auto-resolved from the project's manifest path (same schema `kortix ship`/CR-merge use). */
    validateManifest: (raw: string) => P.validateProjectManifest(projectId, raw),

    /** Mint a fresh scoped git push token for a managed project (409 for BYO repos). */
    gitToken: () => P.getProjectGitToken(projectId),

    /** This project's agents as principals (service accounts), for a "Who
     *  can use it" picker. Any project member may read it. */
    agentIdentities: () => P.listProjectAgentIdentities(projectId),

    secrets: {
      list: () => P.listProjectSecrets(projectId),
      upsert: (input: Parameters<typeof P.upsertProjectSecret>[1]) =>
        P.upsertProjectSecret(projectId, input),
      setStrategy: (...a: DropFirst<Parameters<typeof P.setProjectSecretStrategy>>) =>
        P.setProjectSecretStrategy(projectId, ...a),
      broker: (...a: DropFirst<Parameters<typeof P.brokerProjectSecretRequest>>) =>
        P.brokerProjectSecretRequest(projectId, ...a),
      remove: (name: string) => P.deleteProjectSecret(projectId, name),
      setPersonal: (...a: DropFirst<Parameters<typeof P.setPersonalProjectSecret>>) =>
        P.setPersonalProjectSecret(projectId, ...a),
      removePersonal: (name: string) => P.deletePersonalProjectSecret(projectId, name),
      setGitCredential: (input: Parameters<typeof P.upsertProjectGitCredential>[1]) =>
        P.upsertProjectGitCredential(projectId, input),
      /** The provider logins saved on this project (ChatGPT, OpenCode Zen, OpenCode Go). */
      listProviderOAuth: () => P.listProjectProviderOAuth(projectId),
      /** Device-code OAuth flow to connect a subscription-backed provider (e.g. ChatGPT, opencode-go). */
      startProviderOAuth: (...a: DropFirst<Parameters<typeof P.startProjectProviderOAuth>>) =>
        P.startProjectProviderOAuth(projectId, ...a),
      pollProviderOAuth: (...a: DropFirst<Parameters<typeof P.pollProjectProviderOAuth>>) =>
        P.pollProjectProviderOAuth(projectId, ...a),
      removeProviderOAuth: (provider: string) => P.deleteProjectProviderOAuth(projectId, provider),
    },

    access: bindProjectMembership(projectId),
  };
}
