import * as P from '../rest/projects-client';
import { bindProjectMembership } from './project-membership';

import type { DropFirst } from './binding-types';
export function bindProjectAccessSecurity(projectId: string) {
  return {
    tokens: {
      list: () => P.listWorkspaceCliTokens(projectId),
      create: (input?: Parameters<typeof P.createWorkspaceCliToken>[1]) =>
        P.createWorkspaceCliToken(projectId, input),
      revoke: (tokenId: string) => P.revokeWorkspaceCliToken(projectId, tokenId),
    },

    /** Agent-minted setup links — hand a human a link to enter a secret value or 1-click connect an app. */
    setupLinks: {
      requestSecret: (input: Parameters<typeof P.requestWorkspaceSecret>[1]) =>
        P.requestWorkspaceSecret(projectId, input),
      requestConnector: (input: Parameters<typeof P.requestWorkspaceConnector>[1]) =>
        P.requestWorkspaceConnector(projectId, input),
    },

    /** Validate a `kortix.yaml` manifest's raw text server-side (same schema `kortix ship`/CR-merge use). */
    validateManifest: (raw: string) => P.validateWorkspaceManifest(projectId, raw),

    /** Mint a fresh scoped git push token for a managed project (409 for BYO repos). */
    gitToken: () => P.getWorkspaceGitToken(projectId),

    /** This project's agents as principals (service accounts), for a "Who
     *  can use it" picker. Any project member may read it. */
    agentIdentities: () => P.listWorkspaceAgentIdentities(projectId),

    secrets: {
      list: () => P.listWorkspaceSecrets(projectId),
      upsert: (input: Parameters<typeof P.upsertWorkspaceSecret>[1]) =>
        P.upsertWorkspaceSecret(projectId, input),
      setStrategy: (...a: DropFirst<Parameters<typeof P.setWorkspaceSecretStrategy>>) =>
        P.setWorkspaceSecretStrategy(projectId, ...a),
      broker: (...a: DropFirst<Parameters<typeof P.brokerWorkspaceSecretRequest>>) =>
        P.brokerWorkspaceSecretRequest(projectId, ...a),
      remove: (name: string) => P.deleteWorkspaceSecret(projectId, name),
      setPersonal: (...a: DropFirst<Parameters<typeof P.setPersonalWorkspaceSecret>>) =>
        P.setPersonalWorkspaceSecret(projectId, ...a),
      removePersonal: (name: string) => P.deletePersonalWorkspaceSecret(projectId, name),
      setGitCredential: (input: Parameters<typeof P.upsertWorkspaceGitCredential>[1]) =>
        P.upsertWorkspaceGitCredential(projectId, input),
      /** The provider logins saved on this project (ChatGPT, OpenCode Zen, OpenCode Go). */
      listProviderOAuth: () => P.listWorkspaceProviderOAuth(projectId),
      /** Device-code OAuth flow to connect a subscription-backed provider (e.g. ChatGPT, opencode-go). */
      startProviderOAuth: (...a: DropFirst<Parameters<typeof P.startWorkspaceProviderOAuth>>) =>
        P.startWorkspaceProviderOAuth(projectId, ...a),
      pollProviderOAuth: (...a: DropFirst<Parameters<typeof P.pollWorkspaceProviderOAuth>>) =>
        P.pollWorkspaceProviderOAuth(projectId, ...a),
      removeProviderOAuth: (provider: string) => P.deleteWorkspaceProviderOAuth(projectId, provider),
    },

    /** The caller's Claude accounts (Claude Pro or Max), stored like ChatGPT accounts. The token is never returned. */
    claudeSubscription: {
      get: () => P.getClaudeSubscription(projectId),
      /** Run `claude setup-token` on the server; open `authorize_url`, approve, then `completeLogin`. */
      startLogin: (target?: Parameters<typeof P.startClaudeSubscriptionLogin>[1]) => P.startClaudeSubscriptionLogin(projectId, target),
      completeLogin: (input: Parameters<typeof P.completeClaudeSubscriptionLogin>[1]) =>
        P.completeClaudeSubscriptionLogin(projectId, input),
      /** Store a token made with `claude setup-token` on the caller's own computer. */
      setToken: (token: string, target?: Parameters<typeof P.setClaudeSubscriptionToken>[2]) => P.setClaudeSubscriptionToken(projectId, token, target),
    },

    access: bindProjectMembership(projectId),
  };
}
