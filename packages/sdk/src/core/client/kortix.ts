import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
/**
 * createKortix — the single opinionated entry point to the Kortix data layer.
 *
 * One client. Every action a method. The host app imports ONLY from `@kortix/sdk`
 * — never `@opencode-ai/sdk`, never `backendApi`/`authenticatedFetch` directly.
 *
 *   const kortix = createKortix({ getToken });
 *   await kortix.projects.list();
 *   await kortix.project(pid).secrets.upsert({ name, value });
 *   const s = kortix.session(pid, sid);
 *   await s.start();
 *   s.runtime.session.prompt({ sessionID: sid, parts });   // typed opencode, via the SDK
 *
 * REST methods are direct references to the platform client, so they keep their
 * exact types with zero re-typing. The `project()`/`session()` handles bind ids
 * for ergonomics. Reactive data still comes from `@kortix/sdk/react` hooks.
 */
import * as F from '../files/client';
import { getClient, getClientForUrl } from '../runtime/client';
import { ApiError } from '../http/api/errors';
import { type KortixPlatformConfig, configureKortix, platformConfig } from '../http/config';
import * as P from '../rest/projects-client';
import * as W from '../rest/workspaces-client';
import { getSessionHealth } from '../session/health';
import { type SubdomainUrlOptions, proxyLocalhostUrl, rewriteLocalhostUrl } from '../session/url';
import { setCurrentRuntime } from '../session/current-runtime';
import {
  clearSessionRuntime,
  getSessionRuntime,
  type SessionRuntimeEntry,
} from '../session/session-runtime-registry';
import { getSandboxUrlForExternalId } from '../session/server-store/url-helpers';
import {
  openEventStream,
  type EventStreamHandle,
  type OpenCodeEvent,
} from '../stream/event-stream';

/** A model the agent can run, as the opencode runtime identifies it. */
export type SessionModel = { providerID: string; modelID: string };

/** The opencode runtime client for the currently-active sandbox (set by the host). */
function runtime(): OpencodeClient {
  return getClient();
}

/**
 * Thrown by a session handle's runtime-scoped operations (`.runtime`,
 * `.health()`, `.previewUrl()`, `.proxyUrl()`) when called before the handle
 * has resolved its own sandbox runtime. These never fall back to whatever
 * sandbox happens to be globally active (a different session's runtime) —
 * the caller must resolve THIS handle's runtime first.
 */
/**
 * Dedupes concurrent `ensureReady()` calls that would otherwise both drive a
 * `/start` long-poll for the SAME (workspaceId, sessionId) — e.g. two session
 * handles for the same session (or the facade racing the React `useSession`
 * hook) both calling `ensureReady()`/`start()` before either has resolved a
 * runtime. Keyed by `${workspaceId}\n${sessionId}` (not the process-global
 * "active runtime" — every other handle for a DIFFERENT session gets its own
 * entry and is unaffected). Cleared on settle (success or failure) so a
 * transient failure doesn't wedge the key — the next call issues a fresh
 * `/start` instead of replaying a stale rejected promise forever.
 */
const inFlightSessionStarts = new Map<string, Promise<SessionRuntimeEntry>>();

export class SessionNotReadyError extends Error {
  constructor(action: string) {
    super(
      `Session runtime not ready — call \`await session.ensureReady()\` (it drives \`start()\` to completion and resolves this session's own sandbox runtime) before calling \`${action}\`.`,
    );
    this.name = 'SessionNotReadyError';
  }
}

export function createKortix(config: KortixPlatformConfig, opts?: { global?: boolean }) {
  // Wire the platform seam once. All wrapped functions read it.
  //
  // `opts.global === false` (used by `@kortix/sdk/server`'s `createScopedKortix`)
  // skips the process-wide write entirely — that caller relies solely on the
  // `AsyncLocalStorage` scope `createScopedKortix` wraps every method call in,
  // so this returned facade never touches (or is affected by) the module-global
  // singleton other concurrent `createKortix()` calls in the same process share.
  configureKortix(config, opts);

  /**
   * Parse `backendUrl` for its port (used by the subdomain preview scheme).
   * `backendUrl` is normally absolute, but the BFF pattern — a Next.js API
   * route (or any same-origin proxy) fronting the real Kortix API — legitimately
   * configures it as a relative path like `/api/kortix`. `new URL()` throws on
   * a bare relative string (no base to resolve against). In a browser that's
   * recoverable: resolve it against the page's own origin. Server-side there
   * is no implicit origin, so a relative `backendUrl` is a real misconfiguration
   * — fail loudly instead of silently defaulting to port 80.
   */
  function parseBackendUrlForPort(apiBaseUrl: string): URL | null {
    try {
      return new URL(apiBaseUrl);
    } catch {
      if (typeof window !== 'undefined' && window.location?.origin) {
        try {
          return new URL(apiBaseUrl, window.location.origin);
        } catch {
          return null;
        }
      }
      throw new ApiError(
        `Kortix SDK: backendUrl must be an absolute URL outside the browser (got ${JSON.stringify(apiBaseUrl)}). Relative paths like "/api/kortix" only resolve against a page origin — configure an absolute backendUrl for server-side hosts.`,
        { code: 'INVALID_BACKEND_URL' },
      );
    }
  }

  /**
   * Resolve the proxy/preview URL context (sandboxId + api base) from config +
   * a THIS-handle's own resolved sandbox id, so a session's `previewUrl`/
   * `proxyUrl` never make the host name a sandbox — and never reads whichever
   * sandbox happens to be globally active (which may belong to a different
   * session handle).
   */
  function resolvePreviewOptsForSandbox(sandboxId: string): SubdomainUrlOptions {
    // Read the LIVE platform config, not the `config` captured at
    // `createKortix()` time: a host may re-point the seam after creation
    // (calling `configureKortix()` again — e.g. the whitelabel app switching
    // its `backendUrl` to a same-origin BFF proxy once it learns wrapper mode
    // is on), and preview/proxy URLs must follow the reconfigured base like
    // every other call path already does.
    const apiBaseUrl = platformConfig().backendUrl ?? config.backendUrl;
    let backendPort = 80;
    const u = parseBackendUrlForPort(apiBaseUrl);
    if (u) {
      backendPort = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    }
    return { sandboxId, backendPort, apiBaseUrl };
  }

  /** Account-scoped operations. */
  const accounts = {
    list: W.listAccounts,
    get: W.getAccount,
    create: W.createAccount,
    updateName: W.updateAccountName,
    leave: W.leaveAccount,
    members: W.listAccountMembers,
    invite: W.inviteAccountMember,
    removeMember: W.removeAccountMember,
    updateMemberRole: W.updateAccountMemberRole,
    invites: W.listAccountInvites,
    /** Cancel a pending account invite (accountId still known/scoped). */
    cancelInvite: W.cancelAccountInvite,
    /** Resend a pending account invite (accountId still known/scoped). */
    resendInvite: W.resendAccountInvite,
    /** CLI PAT minting — account-scoped personal access tokens (`kortix_pat_...`). */
    tokens: {
      list: W.listAccountTokens,
      create: W.createAccountToken,
      revoke: W.revokeAccountToken,
    },
    /** Enterprise audit log — events + CSV/JSONL export + SIEM webhooks. */
    audit: {
      log: W.listAccountAudit,
      export: W.exportAccountAudit,
      webhooks: {
        list: W.listAccountAuditWebhooks,
        create: W.createAccountAuditWebhook,
        update: W.updateAccountAuditWebhook,
        remove: W.removeAccountAuditWebhook,
      },
    },
  };

  /**
   * Billing read surface — credits, subscription, tier, and transaction
   * history for entitlement-gating + a billing/usage UI. Checkout/portal/
   * credit-purchase/subscription MUTATIONS stay app-owned (Stripe flows) —
   * this is reads only.
   */
  const billing = {
    accountState: W.getAccountState,
    accountStateMinimal: W.getAccountStateMinimal,
    transactions: W.listBillingTransactions,
    transactionsSummary: W.getBillingTransactionsSummary,
    creditBreakdown: W.getBillingCreditBreakdown,
    usageHistory: W.getBillingUsageHistory,
    /** Usage rollup (/v1/usage), optionally grouped by model, provider, or day. */
    usageRollup: W.getUsageRollup,
    /** Unified finalized LLM and compute cost by session. */
    sessionCosts: {
      list: W.listSessionCosts,
      get: W.getSessionCostRecord,
    },
    tierConfigurations: W.getBillingTierConfigurations,

    /** Stripe checkout — start a subscription and confirm it post-redirect. */
    checkout: {
      createSession: (input: Parameters<typeof W.createCheckoutSession>[0]) =>
        W.createCheckoutSession(input),
      confirmSession: (sessionId: string, accountId?: string) =>
        W.confirmCheckoutSession(sessionId, accountId),
    },

    /** Manage an existing subscription (portal, cancel/reactivate, downgrade). */
    subscription: {
      createPortalSession: (returnUrl: string, accountId?: string) =>
        W.createPortalSession(returnUrl, accountId),
      cancel: (feedback?: string, accountId?: string) => W.cancelSubscription(feedback, accountId),
      reactivate: (accountId?: string) => W.reactivateSubscription(accountId),
      scheduleDowngrade: (targetTierKey: string, commitmentType?: string, accountId?: string) =>
        W.scheduleDowngrade(targetTierKey, commitmentType, accountId),
      cancelScheduledChange: (accountId?: string) => W.cancelScheduledChange(accountId),
      prorationPreview: (newPriceId: string, accountId?: string) =>
        W.getProrationPreview(newPriceId, accountId),
    },

    /** One-off credit purchases + recurring auto-topup configuration. */
    credits: {
      purchase: (input: Parameters<typeof W.purchaseCredits>[0]) => W.purchaseCredits(input),
      autoTopupSettings: (accountId?: string) => W.getAutoTopupSettings(accountId),
      configureAutoTopup: (input: Parameters<typeof W.configureAutoTopup>[0]) =>
        W.configureAutoTopup(input),
    },
  };

  /**
   * Account-invite lifecycle reached by invite token alone — accept/decline/
   * describe are called by the invitee (who may not be an account member, or
   * even signed into this account, yet), so they take only `inviteId` and
   * genuinely don't fit account- or project-scoping.
   */
  const accountInvites = {
    describe: W.describeAccountInvite,
    accept: W.acceptAccountInvite,
    decline: W.declineAccountInvite,
  };

  /** Top-level project operations (not bound to an id). */
  const projects = {
    list: P.listProjects,
    listForAccount: P.listProjectsForAccount,
    get: P.getProject,
    detail: P.getProjectDetail,
    create: P.createProject,
    /** Create a project backed by a brand-new Kortix-managed GitHub repo. */
    createRepo: P.createProjectRepo,
    provision: P.provisionProject,
    update: P.updateProject,
    archive: P.archiveProject,
    llmCatalog: P.getProjectLlmCatalog,
    modelPicker: P.getProjectModelPicker,
    sandboxHealth: P.getProjectSandboxHealth,
    sandboxTemplates: P.listProjectSandboxTemplates,
    sessions: P.listProjectSessions,
    createSession: P.createProjectSession,
  };

  /** Canonical top-level Workspace operations. */
  const workspaces = {
    list: W.listWorkspaces,
    listForAccount: W.listWorkspacesForAccount,
    get: W.getWorkspace,
    detail: W.getWorkspaceDetail,
    create: W.createWorkspace,
    /** Create a workspace backed by a brand-new Kortix-managed Git repository. */
    createRepo: W.createWorkspaceRepo,
    provision: W.provisionWorkspace,
    update: W.updateWorkspace,
    archive: W.archiveWorkspace,
    llmCatalog: W.getWorkspaceLlmCatalog,
    modelPicker: W.getWorkspaceModelPicker,
    sandboxHealth: W.getWorkspaceSandboxHealth,
    sandboxTemplates: W.listWorkspaceSandboxTemplates,
    sessions: W.listWorkspaceSessions,
    createSession: W.createWorkspaceSession,
  };

  /** GitHub App installation + repository linking — account-scoped, not project-scoped. */
  const github = {
    linkRepository: W.linkRepository,
    getInstallation: W.getGitHubInstallation,
    listInstallations: W.listGitHubInstallations,
    listLinkableInstallations: W.listLinkableGitHubInstallations,
    listRepositories: W.listGitHubRepositories,
    listRepositoryBranches: W.listGitHubRepositoryBranches,
    linkInstallation: W.linkGitHubInstallation,
    saveInstallation: W.saveGitHubInstallation,
    deleteInstallation: W.deleteGitHubInstallation,
  };

  /** Public share links for a sandbox port (`/v1/p/share`) — sandbox-scoped, not project-scoped. */
  const sandboxShares = {
    list: W.listSandboxShares,
    create: W.createSandboxShare,
    revoke: W.revokeSandboxShare,
  };

  /** Deployment-wide flag: is the easy-connect (Pipedream) provider configured? Not project-scoped. */
  const connectStatus = W.getConnectStatus;

  /**
   * Public marketplace catalog browse (`/v1/marketplace/*`) — top-level and
   * distinct from `project(id).marketplace`, which is install-scoped (commits
   * an item onto a specific project's branch). This is read-only browsing +
   * the authed "add a marketplace source" surface.
   */
  const marketplace = {
    items: (options?: Parameters<typeof W.listMarketplaceCatalogItems>[0]) =>
      W.listMarketplaceCatalogItems(options),
    item: (id: string) => W.getMarketplaceCatalogItem(id),
    itemFile: (id: string, path: string) => W.getMarketplaceCatalogItemFile(id, path),
    marketplaces: () => W.listMarketplaces(),
    featured: () => W.listFeaturedMarketplaces(),
    sources: {
      list: () => W.listMarketplaceSources(),
      add: (input: Parameters<typeof W.addMarketplaceSource>[0]) => W.addMarketplaceSource(input),
      remove: (id: string) => W.removeMarketplaceSource(id),
    },
  };

  /** Id-bound handle for one Workspace: every sub-resource has workspaceId pre-applied. */
  function connectorDataPlane(workspaceId?: string) {
    return {
      /** Callable catalog for this Workspace or token scope. */
      catalog: () => W.getConnectorCatalog(workspaceId),
      /** Flattened `<connector>.<action>` tool list. */
      tools: () => W.listConnectorTools(workspaceId),
      /** Search callable tools by id and description. */
      search: (...a: DropFirst<Parameters<typeof W.searchConnectorTools>>) =>
        W.searchConnectorTools(workspaceId, ...a),
      /** Describe one `<connector>.<action>` tool. */
      describe: (...a: DropFirst<Parameters<typeof W.describeConnectorTool>>) =>
        W.describeConnectorTool(workspaceId, ...a),
      /** Call one `<connector>.<action>` tool. */
      call: <T = unknown>(...a: DropFirst<Parameters<typeof W.callConnector<T>>>) =>
        W.callConnector<T>(workspaceId, ...a),
      /** Upload bytes for use by a later connector call. */
      uploadAttachment: (...a: DropFirst<Parameters<typeof W.uploadConnectorAttachment>>) =>
        W.uploadConnectorAttachment(workspaceId, ...a),
    };
  }

  /** Deprecated Project connector transport. */
  function projectConnectorDataPlane(projectId?: string) {
    return {
      catalog: () => P.getConnectorCatalog(projectId),
      tools: () => P.listConnectorTools(projectId),
      search: (...a: DropFirst<Parameters<typeof P.searchConnectorTools>>) =>
        P.searchConnectorTools(projectId, ...a),
      describe: (...a: DropFirst<Parameters<typeof P.describeConnectorTool>>) =>
        P.describeConnectorTool(projectId, ...a),
      call: <T = unknown>(...a: DropFirst<Parameters<typeof P.callConnector<T>>>) =>
        P.callConnector<T>(projectId, ...a),
      uploadAttachment: (...a: DropFirst<Parameters<typeof P.uploadConnectorAttachment>>) =>
        P.uploadConnectorAttachment(projectId, ...a),
    };
  }

  function project(workspaceId: string) {
    const connections = {
      list: () => P.listConnections(workspaceId),
      listAll: () => P.listAllConnections(workspaceId),
      reconcile: (...a: DropFirst<Parameters<typeof P.reconcileConnection>>) =>
        P.reconcileConnection(workspaceId, ...a),
      reconcileMember: (...a: DropFirst<Parameters<typeof P.reconcileMemberConnection>>) =>
        P.reconcileMemberConnection(workspaceId, ...a),
      updateCredential: (...a: DropFirst<Parameters<typeof P.updateConnectionCredential>>) =>
        P.updateConnectionCredential(workspaceId, ...a),
      revoke: (...a: DropFirst<Parameters<typeof P.revokeConnection>>) =>
        P.revokeConnection(workspaceId, ...a),
      activate: (...a: DropFirst<Parameters<typeof P.activateConnection>>) =>
        P.activateConnection(workspaceId, ...a),
      setDefault: (...a: DropFirst<Parameters<typeof P.setDefaultConnection>>) =>
        P.setDefaultConnection(workspaceId, ...a),
      pipedreamConnect: (...a: DropFirst<Parameters<typeof P.pipedreamConnectConnection>>) =>
        P.pipedreamConnectConnection(workspaceId, ...a),
      pipedreamFinalize: (...a: DropFirst<Parameters<typeof P.pipedreamFinalizeConnection>>) =>
        P.pipedreamFinalizeConnection(workspaceId, ...a),
    };
    return {
      get: (opts?: Parameters<typeof P.getProject>[1]) => P.getProject(workspaceId, opts),
      detail: () => P.getProjectDetail(workspaceId),
      /** Canonical project-scoped audit timeline. */
      audit: (options?: Parameters<typeof P.listProjectAudit>[1]) =>
        P.listProjectAudit(workspaceId, options),
      update: (input: Parameters<typeof P.updateProject>[1]) => P.updateProject(workspaceId, input),
      archive: () => P.archiveProject(workspaceId),
      llmCatalog: () => P.getProjectLlmCatalog(workspaceId),
      modelPicker: () => P.getProjectModelPicker(workspaceId),
      sandboxHealth: () => P.getProjectSandboxHealth(workspaceId),
      onboardingComplete: (...a: DropFirst<Parameters<typeof P.setProjectOnboardingComplete>>) =>
        P.setProjectOnboardingComplete(workspaceId, ...a),

      /** Provider-neutral serverless Apps owned by this project. */
      apps: {
        list: () => P.listApps(workspaceId),
        create: (input: Parameters<typeof P.createApp>[1]) => P.createApp(workspaceId, input),
        get: (appId: string) => P.getApp(workspaceId, appId),
        update: (...a: DropFirst<Parameters<typeof P.updateApp>>) => P.updateApp(workspaceId, ...a),
        access: {
          get: (...a: DropFirst<Parameters<typeof P.getAppAccess>>) => P.getAppAccess(workspaceId, ...a),
          update: (...a: DropFirst<Parameters<typeof P.updateAppAccess>>) => P.updateAppAccess(workspaceId, ...a),
          session: (...a: DropFirst<Parameters<typeof P.createAppAccessSession>>) =>
            P.createAppAccessSession(workspaceId, ...a),
        },
        remove: (appId: string) => P.deleteApp(workspaceId, appId),
        artifacts: {
          register: (input: Parameters<typeof P.registerAppArtifact>[1]) =>
            P.registerAppArtifact(workspaceId, input),
          uploadArchive: (...a: DropFirst<Parameters<typeof P.uploadAppArtifactArchive>>) =>
            P.uploadAppArtifactArchive(workspaceId, ...a),
          finalize: (...a: DropFirst<Parameters<typeof P.finalizeAppArtifact>>) =>
            P.finalizeAppArtifact(workspaceId, ...a),
        },
        deployments: {
          create: (...a: DropFirst<Parameters<typeof P.createAppDeployment>>) =>
            P.createAppDeployment(workspaceId, ...a),
          list: (appId: string) => P.listAppDeployments(workspaceId, appId),
          get: (...a: DropFirst<Parameters<typeof P.getAppDeployment>>) =>
            P.getAppDeployment(workspaceId, ...a),
          logs: (...a: DropFirst<Parameters<typeof P.getAppDeploymentLogs>>) =>
            P.getAppDeploymentLogs(workspaceId, ...a),
        },
        start: (appId: string) => P.startApp(workspaceId, appId),
        stop: (appId: string) => P.stopApp(workspaceId, appId),
        rollback: (...a: DropFirst<Parameters<typeof P.rollbackApp>>) =>
          P.rollbackApp(workspaceId, ...a),
      },

      /** Project-scoped CLI PATs (auto-minted at session-create as `KORTIX_TOKEN`; can also be minted by hand). */
      tokens: {
        list: () => P.listProjectCliTokens(workspaceId),
        create: (input?: Parameters<typeof P.createProjectCliToken>[1]) =>
          P.createProjectCliToken(workspaceId, input),
        revoke: (tokenId: string) => P.revokeProjectCliToken(workspaceId, tokenId),
      },

      /** Agent-minted setup links — hand a human a link to enter a secret value or 1-click connect an app. */
      setupLinks: {
        requestSecret: (input: Parameters<typeof P.requestProjectSecret>[1]) =>
          P.requestProjectSecret(workspaceId, input),
        requestConnector: (input: Parameters<typeof P.requestProjectConnector>[1]) =>
          P.requestProjectConnector(workspaceId, input),
      },

      /** Validate a `kortix.yaml` (or legacy `kortix.toml`) manifest's raw text server-side — format is auto-resolved from the project's manifest path (same schema `kortix ship`/CR-merge use). */
      validateManifest: (raw: string) => P.validateProjectManifest(workspaceId, raw),

      /** Mint a fresh scoped git push token for a managed project (409 for BYO repos). */
      gitToken: () => P.getProjectGitToken(workspaceId),

      secrets: {
        list: () => P.listProjectSecrets(workspaceId),
        upsert: (input: Parameters<typeof P.upsertProjectSecret>[1]) =>
          P.upsertProjectSecret(workspaceId, input),
        setStrategy: (...a: DropFirst<Parameters<typeof P.setProjectSecretStrategy>>) =>
          P.setProjectSecretStrategy(workspaceId, ...a),
        broker: (...a: DropFirst<Parameters<typeof P.brokerProjectSecretRequest>>) =>
          P.brokerProjectSecretRequest(workspaceId, ...a),
        remove: (name: string) => P.deleteProjectSecret(workspaceId, name),
        setPersonal: (...a: DropFirst<Parameters<typeof P.setPersonalProjectSecret>>) =>
          P.setPersonalProjectSecret(workspaceId, ...a),
        removePersonal: (name: string) => P.deletePersonalProjectSecret(workspaceId, name),
        setGitCredential: (input: Parameters<typeof P.upsertProjectGitCredential>[1]) =>
          P.upsertProjectGitCredential(workspaceId, input),
        /** Device-code OAuth flow to connect a subscription-backed provider (e.g. ChatGPT). */
        startProviderOAuth: (...a: DropFirst<Parameters<typeof P.startProjectProviderOAuth>>) =>
          P.startProjectProviderOAuth(workspaceId, ...a),
        pollProviderOAuth: (...a: DropFirst<Parameters<typeof P.pollProjectProviderOAuth>>) =>
          P.pollProjectProviderOAuth(workspaceId, ...a),
        removeProviderOAuth: (provider: string) =>
          P.deleteProjectProviderOAuth(workspaceId, provider),
      },

      access: {
        list: () => P.listProjectAccess(workspaceId),
        invite: (...a: DropFirst<Parameters<typeof P.inviteProjectMember>>) =>
          P.inviteProjectMember(workspaceId, ...a),
        update: (...a: DropFirst<Parameters<typeof P.updateProjectAccess>>) =>
          P.updateProjectAccess(workspaceId, ...a),
        revoke: (userId: string) => P.revokeProjectAccess(workspaceId, userId),
        pendingInvites: () => P.listPendingProjectInvites(workspaceId),
        resendInvite: (...a: DropFirst<Parameters<typeof P.resendPendingProjectInvite>>) =>
          P.resendPendingProjectInvite(workspaceId, ...a),
        revokeInvite: (...a: DropFirst<Parameters<typeof P.revokePendingProjectInvite>>) =>
          P.revokePendingProjectInvite(workspaceId, ...a),
        requests: () => P.listProjectAccessRequests(workspaceId),
        approveRequest: (...a: DropFirst<Parameters<typeof P.approveProjectAccessRequest>>) =>
          P.approveProjectAccessRequest(workspaceId, ...a),
        rejectRequest: (...a: DropFirst<Parameters<typeof P.rejectProjectAccessRequest>>) =>
          P.rejectProjectAccessRequest(workspaceId, ...a),
        groupGrants: () => P.listProjectGroupGrants(workspaceId),
        attachGroupGrant: (...a: DropFirst<Parameters<typeof P.attachGroupToProject>>) =>
          P.attachGroupToProject(workspaceId, ...a),
        updateGroupGrant: (...a: DropFirst<Parameters<typeof P.updateProjectGroupGrant>>) =>
          P.updateProjectGroupGrant(workspaceId, ...a),
        detachGroupGrant: (groupId: string) => P.detachGroupFromProject(workspaceId, groupId),
        /** Per-resource (agent/skill/secret) grants to a member or a group. */
        resourceGrants: {
          list: () => P.listProjectResourceGrants(workspaceId),
          create: (input: Parameters<typeof P.createProjectResourceGrant>[1]) =>
            P.createProjectResourceGrant(workspaceId, input),
          remove: (grantId: string) => P.deleteProjectResourceGrant(workspaceId, grantId),
        },
      },

      connectors: {
        ...projectConnectorDataPlane(workspaceId),
        list: () => P.listConnectors(workspaceId),
        config: (...a: DropFirst<Parameters<typeof P.getConnectorConfig>>) =>
          P.getConnectorConfig(workspaceId, ...a),
        create: (...a: DropFirst<Parameters<typeof P.createConnector>>) =>
          P.createConnector(workspaceId, ...a),
        remove: (...a: DropFirst<Parameters<typeof P.deleteConnector>>) =>
          P.deleteConnector(workspaceId, ...a),
        sync: () => P.syncConnectors(workspaceId),
        auth: {
          discover: (...a: DropFirst<Parameters<typeof P.discoverConnectorAuth>>) =>
            P.discoverConnectorAuth(workspaceId, ...a),
        },
        setName: (...a: DropFirst<Parameters<typeof P.setConnectorName>>) =>
          P.setConnectorName(workspaceId, ...a),
        setCredentialMode: (...a: DropFirst<Parameters<typeof P.setConnectorCredentialMode>>) =>
          P.setConnectorCredentialMode(workspaceId, ...a),
        setAuthorizationStrategy: (
          ...a: DropFirst<Parameters<typeof P.setConnectorAuthorizationStrategy>>
        ) => P.setConnectorAuthorizationStrategy(workspaceId, ...a),
        setCredential: (...a: DropFirst<Parameters<typeof P.setConnectorCredential>>) =>
          P.setConnectorCredential(workspaceId, ...a),
        setSensitive: (...a: DropFirst<Parameters<typeof P.setConnectorSensitive>>) =>
          P.setConnectorSensitive(workspaceId, ...a),
        connections,
        policies: {
          get: (...a: DropFirst<Parameters<typeof P.getConnectorPolicies>>) =>
            P.getConnectorPolicies(workspaceId, ...a),
          set: (...a: DropFirst<Parameters<typeof P.setConnectorPolicies>>) =>
            P.setConnectorPolicies(workspaceId, ...a),
        },
        /** Easy-connect (Pipedream): app catalog + connect/finalize handshake. */
        pipedream: {
          listApps: (...a: DropFirst<Parameters<typeof P.listPipedreamApps>>) =>
            P.listPipedreamApps(workspaceId, ...a),
          connect: (...a: DropFirst<Parameters<typeof P.pipedreamConnect>>) =>
            P.pipedreamConnect(workspaceId, ...a),
          finalize: (...a: DropFirst<Parameters<typeof P.pipedreamFinalize>>) =>
            P.pipedreamFinalize(workspaceId, ...a),
        },
        /** Direct connector catalogue and normalized domain surfaces. */
        discover: {
          list: (...a: DropFirst<Parameters<typeof P.listDiscoverConnectors>>) =>
            P.listDiscoverConnectors(workspaceId, ...a),
          detail: (...a: DropFirst<Parameters<typeof P.getDiscoverConnector>>) =>
            P.getDiscoverConnector(workspaceId, ...a),
        },
      },

      policies: {
        list: () => P.listProjectPolicies(workspaceId),
        set: (...a: DropFirst<Parameters<typeof P.setProjectPolicies>>) =>
          P.setProjectPolicies(workspaceId, ...a),
      },

      triggers: {
        list: () => P.listProjectTriggers(workspaceId),
        create: (...a: DropFirst<Parameters<typeof P.createProjectTrigger>>) =>
          P.createProjectTrigger(workspaceId, ...a),
        update: (...a: DropFirst<Parameters<typeof P.updateProjectTrigger>>) =>
          P.updateProjectTrigger(workspaceId, ...a),
        remove: (...a: DropFirst<Parameters<typeof P.deleteProjectTrigger>>) =>
          P.deleteProjectTrigger(workspaceId, ...a),
        fire: (...a: DropFirst<Parameters<typeof P.fireProjectTrigger>>) =>
          P.fireProjectTrigger(workspaceId, ...a),
        setActivation: (...a: DropFirst<Parameters<typeof P.setProjectTriggersActivation>>) =>
          P.setProjectTriggersActivation(workspaceId, ...a),
      },

      files: {
        list: (options?: Parameters<typeof P.listProjectFiles>[1]) =>
          P.listProjectFiles(workspaceId, options),
        read: (path: string, ref?: string) => P.readProjectFile(workspaceId, path, ref),
        search: (...a: DropFirst<Parameters<typeof P.searchProjectFiles>>) =>
          P.searchProjectFiles(workspaceId, ...a),
        archive: (...a: DropFirst<Parameters<typeof P.fetchProjectArchive>>) =>
          P.fetchProjectArchive(workspaceId, ...a),
        history: (...a: DropFirst<Parameters<typeof P.getProjectFileHistory>>) =>
          P.getProjectFileHistory(workspaceId, ...a),
      },

      git: {
        commits: () => P.listProjectCommits(workspaceId),
        commit: (sha: string) => P.getProjectCommit(workspaceId, sha),
        commitDiff: (sha: string) => P.getProjectCommitDiff(workspaceId, sha),
        branches: () => P.listProjectBranches(workspaceId),
        versionDiff: (...a: DropFirst<Parameters<typeof P.getVersionDiff>>) =>
          P.getVersionDiff(workspaceId, ...a),
        /** Invite a GitHub user as a collaborator on a Kortix-managed repo. */
        inviteCollaborator: (...a: DropFirst<Parameters<typeof P.inviteRepoCollaborator>>) =>
          P.inviteRepoCollaborator(workspaceId, ...a),
      },

      changeRequests: {
        list: () => P.listChangeRequests(workspaceId),
        get: (crId: string) => P.getChangeRequest(workspaceId, crId),
        diff: (crId: string) => P.getChangeRequestDiff(workspaceId, crId),
        mergePreview: (crId: string) => P.getChangeRequestMergePreview(workspaceId, crId),
        open: (...a: DropFirst<Parameters<typeof P.openChangeRequest>>) =>
          P.openChangeRequest(workspaceId, ...a),
        merge: (...a: DropFirst<Parameters<typeof P.mergeChangeRequest>>) =>
          P.mergeChangeRequest(workspaceId, ...a),
        close: (...a: DropFirst<Parameters<typeof P.closeChangeRequest>>) =>
          P.closeChangeRequest(workspaceId, ...a),
        reopen: (...a: DropFirst<Parameters<typeof P.reopenChangeRequest>>) =>
          P.reopenChangeRequest(workspaceId, ...a),
        /** Request changes on a CR (Review Center) — records feedback + optionally delivers it back to the originating session. */
        requestChanges: (...a: DropFirst<Parameters<typeof P.requestChangesOnChangeRequest>>) =>
          P.requestChangesOnChangeRequest(workspaceId, ...a),
      },

      sessions: {
        list: (options?: Parameters<typeof P.listProjectSessions>[1]) =>
          P.listProjectSessions(workspaceId, options),
        create: (input?: Parameters<typeof P.createProjectSession>[1]) =>
          P.createProjectSession(workspaceId, input),
        ensureWarm: () => P.ensureWarmProjectSession(workspaceId),
        claimWarm: (input: Parameters<typeof P.claimWarmProjectSession>[1]) =>
          P.claimWarmProjectSession(workspaceId, input),
      },

      /** Review Center — the per-project human-in-the-loop inbox (change requests, tool approvals, agent outputs/decisions). */
      review: {
        list: (params?: Parameters<typeof P.listReviewItems>[1]) =>
          P.listReviewItems(workspaceId, params),
        get: (reviewItemId: string) => P.getReviewItem(workspaceId, reviewItemId),
        submit: (input: Parameters<typeof P.submitReviewItem>[1]) =>
          P.submitReviewItem(workspaceId, input),
        act: (...a: DropFirst<Parameters<typeof P.actReviewItem>>) =>
          P.actReviewItem(workspaceId, ...a),
        bulkAct: (input: Parameters<typeof P.bulkActReviewItems>[1]) =>
          P.bulkActReviewItems(workspaceId, input),
      },

      /** The manager inbox of connector-gated actions awaiting approve/deny (APPROVE / ASK / BLOCK). */
      approvals: {
        list: (options?: Parameters<typeof P.listPendingApprovals>[1]) =>
          P.listPendingApprovals(workspaceId, options),
        resolve: (...a: DropFirst<Parameters<typeof P.resolveApproval>>) =>
          P.resolveApproval(workspaceId, ...a),
        sessionsNeedingInput: (options?: Parameters<typeof P.listSessionsNeedingInput>[1]) =>
          P.listSessionsNeedingInput(workspaceId, options),
      },

      /** Gateway observability — LLM request logs, cost/latency rollups, budgets, gateway API keys. */
      gateway: {
        logs: (opts?: Parameters<typeof P.listGatewayLogs>[1]) =>
          P.listGatewayLogs(workspaceId, opts),
        log: (logId: string) => P.getGatewayLog(workspaceId, logId),
        overview: (days?: number) => P.getGatewayOverview(workspaceId, days),
        series: (days?: number) => P.getGatewaySeries(workspaceId, days),
        breakdown: (days?: number) => P.getGatewayBreakdown(workspaceId, days),
        sessions: (days?: number) => P.getGatewaySessions(workspaceId, days),
        errors: (days?: number) => P.getGatewayErrors(workspaceId, days),
        budgets: () => P.getGatewayBudgets(workspaceId),
        setBudget: (input: Parameters<typeof P.setGatewayBudget>[1]) =>
          P.setGatewayBudget(workspaceId, input),
        deleteBudget: (budgetId: string) => P.deleteGatewayBudget(workspaceId, budgetId),
        keys: () => P.getGatewayKeys(workspaceId),
        createKey: (name: string) => P.createGatewayKey(workspaceId, name),
        revokeKey: (keyId: string) => P.revokeGatewayKey(workspaceId, keyId),
        routing: {
          get: () => P.getGatewayRoutingPolicy(workspaceId),
          set: (policy: Parameters<typeof P.setGatewayRoutingPolicy>[1]) =>
            P.setGatewayRoutingPolicy(workspaceId, policy),
          reset: () => P.resetGatewayRoutingPolicy(workspaceId),
          preview: (input: Parameters<typeof P.previewGatewayRoute>[1]) =>
            P.previewGatewayRoute(workspaceId, input),
        },
        /** Run one prompt against up to 6 models side by side (a model-comparison playground). */
        playground: (prompt: string, models: string[], system?: string) =>
          P.runGatewayPlayground(workspaceId, prompt, models, system),
      },

      /** Slack + email + Meet channel connections. */
      channels: {
        slack: {
          installation: () => P.getSlackInstallation(workspaceId),
          connect: (input: Parameters<typeof P.connectSlack>[1]) =>
            P.connectSlack(workspaceId, input),
          mode: () => P.getSlackMode(workspaceId),
          manifest: () => P.getSlackManifest(workspaceId),
          disconnect: () => P.disconnectSlack(workspaceId),
          /** Download a Slack-hosted file through the server-side proxy (bot token stays server-side). */
          getFile: (url: string) => P.getSlackChannelFile(workspaceId, url),
          /** Upload a file to Slack through the server-side 3-step external-upload proxy. */
          uploadFile: (input: Parameters<typeof P.uploadSlackChannelFile>[1]) =>
            P.uploadSlackChannelFile(workspaceId, input),
        },
        email: {
          installation: (connectorSlug?: string | null) =>
            P.getEmailInstallation(workspaceId, connectorSlug),
          mode: () => P.getEmailMode(workspaceId),
          connect: (input: Parameters<typeof P.connectEmail>[1]) =>
            P.connectEmail(workspaceId, input),
          disconnect: (connectorSlug?: string | null) =>
            P.disconnectEmail(workspaceId, connectorSlug),
          updatePolicy: (...a: DropFirst<Parameters<typeof P.updateEmailPolicy>>) =>
            P.updateEmailPolicy(workspaceId, ...a),
        },
        voice: {
          setBotName: (name: string) => P.setMeetBotName(workspaceId, name),
        },
      },

      /** Toggle a feature flag (Customize → Feature flags). Pass `enabled: null` to clear the override. */
      updateFeatureFlag: (...a: DropFirst<Parameters<typeof P.updateFeatureFlag>>) =>
        P.updateFeatureFlag(workspaceId, ...a),

      /** @deprecated Renamed to `updateFeatureFlag`. Keeps the legacy `/experimental` wire path for older deployed APIs. */
      updateExperimentalFeature: (
        ...a: DropFirst<Parameters<typeof P.updateExperimentalFeature>>
      ) => P.updateExperimentalFeature(workspaceId, ...a),

      /** Default model preferences (account/agent/project scope, gateway-resolved). */
      modelDefaults: {
        get: () => P.getModelDefaults(workspaceId),
        set: (input: Parameters<typeof P.setModelDefault>[1]) =>
          P.setModelDefault(workspaceId, input),
        clear: (params: Parameters<typeof P.clearModelDefault>[1]) =>
          P.clearModelDefault(workspaceId, params),
      },

      /** Set the agent used when a new project session does not name one explicitly. */
      setDefaultAgent: (agentName: string) => P.updateProjectDefaultAgent(workspaceId, agentName),

      /** Sandbox templates + snapshot builds — Dockerfile/image/warm-pool config, beyond `sandboxHealth`/`sandboxTemplates`. */
      sandbox: {
        list: () => P.listProjectSandboxes(workspaceId),
        snapshots: () => P.listProjectSnapshots(workspaceId),
        rebuildSnapshot: (slug?: string) => P.rebuildProjectSnapshot(workspaceId, slug),
        fixWithAgent: () => P.fixSandboxWithAgent(workspaceId),
        createTemplate: (input: Parameters<typeof P.createSandboxTemplate>[1]) =>
          P.createSandboxTemplate(workspaceId, input),
        updateTemplate: (...a: DropFirst<Parameters<typeof P.updateSandboxTemplate>>) =>
          P.updateSandboxTemplate(workspaceId, ...a),
        removeTemplate: (templateId: string) => P.deleteSandboxTemplate(workspaceId, templateId),
        buildTemplate: (templateId: string) => P.buildSandboxTemplate(workspaceId, templateId),
        /** Pin/clear the per-project sandbox provider (null = follow the platform default). */
        setProvider: (provider: Parameters<typeof P.updateProjectSandboxProvider>[1]) =>
          P.updateProjectSandboxProvider(workspaceId, provider),
      },

      /** Bind specific secrets + connectors to an agent (the inheritance pyramid's declaration step). */
      setAgentScope: (...a: DropFirst<Parameters<typeof P.setAgentScope>>) =>
        P.setAgentScope(workspaceId, ...a),

      session: (sessionId: string) => projectSession(workspaceId, sessionId),
    };
  }

  /** Canonical Workspace handle. */
  function workspace(workspaceId: string) {
    const connections = {
      list: () => W.listConnections(workspaceId),
      listAll: () => W.listAllConnections(workspaceId),
      reconcile: (...a: DropFirst<Parameters<typeof W.reconcileConnection>>) =>
        W.reconcileConnection(workspaceId, ...a),
      reconcileMember: (...a: DropFirst<Parameters<typeof W.reconcileMemberConnection>>) =>
        W.reconcileMemberConnection(workspaceId, ...a),
      updateCredential: (...a: DropFirst<Parameters<typeof W.updateConnectionCredential>>) =>
        W.updateConnectionCredential(workspaceId, ...a),
      revoke: (...a: DropFirst<Parameters<typeof W.revokeConnection>>) =>
        W.revokeConnection(workspaceId, ...a),
      activate: (...a: DropFirst<Parameters<typeof W.activateConnection>>) =>
        W.activateConnection(workspaceId, ...a),
      setDefault: (...a: DropFirst<Parameters<typeof W.setDefaultConnection>>) =>
        W.setDefaultConnection(workspaceId, ...a),
      pipedreamConnect: (...a: DropFirst<Parameters<typeof W.pipedreamConnectConnection>>) =>
        W.pipedreamConnectConnection(workspaceId, ...a),
      pipedreamFinalize: (...a: DropFirst<Parameters<typeof W.pipedreamFinalizeConnection>>) =>
        W.pipedreamFinalizeConnection(workspaceId, ...a),
    };
    return {
      get: (opts?: Parameters<typeof W.getWorkspace>[1]) => W.getWorkspace(workspaceId, opts),
      detail: () => W.getWorkspaceDetail(workspaceId),
      /** Canonical workspace-scoped audit timeline. */
      audit: (options?: Parameters<typeof W.listWorkspaceAudit>[1]) =>
        W.listWorkspaceAudit(workspaceId, options),
      update: (input: Parameters<typeof W.updateWorkspace>[1]) => W.updateWorkspace(workspaceId, input),
      archive: () => W.archiveWorkspace(workspaceId),
      llmCatalog: () => W.getWorkspaceLlmCatalog(workspaceId),
      modelPicker: () => W.getWorkspaceModelPicker(workspaceId),
      sandboxHealth: () => W.getWorkspaceSandboxHealth(workspaceId),
      onboardingComplete: (...a: DropFirst<Parameters<typeof W.setWorkspaceOnboardingComplete>>) =>
        W.setWorkspaceOnboardingComplete(workspaceId, ...a),

      /** Provider-neutral serverless Apps owned by this workspace. */
      apps: {
        list: () => W.listApps(workspaceId),
        create: (input: Parameters<typeof W.createApp>[1]) => W.createApp(workspaceId, input),
        get: (appId: string) => W.getApp(workspaceId, appId),
        update: (...a: DropFirst<Parameters<typeof W.updateApp>>) => W.updateApp(workspaceId, ...a),
        access: {
          get: (...a: DropFirst<Parameters<typeof W.getAppAccess>>) => W.getAppAccess(workspaceId, ...a),
          update: (...a: DropFirst<Parameters<typeof W.updateAppAccess>>) => W.updateAppAccess(workspaceId, ...a),
          session: (...a: DropFirst<Parameters<typeof W.createAppAccessSession>>) =>
            W.createAppAccessSession(workspaceId, ...a),
        },
        remove: (appId: string) => W.deleteApp(workspaceId, appId),
        artifacts: {
          register: (input: Parameters<typeof W.registerAppArtifact>[1]) =>
            W.registerAppArtifact(workspaceId, input),
          uploadArchive: (...a: DropFirst<Parameters<typeof W.uploadAppArtifactArchive>>) =>
            W.uploadAppArtifactArchive(workspaceId, ...a),
          finalize: (...a: DropFirst<Parameters<typeof W.finalizeAppArtifact>>) =>
            W.finalizeAppArtifact(workspaceId, ...a),
        },
        deployments: {
          create: (...a: DropFirst<Parameters<typeof W.createAppDeployment>>) =>
            W.createAppDeployment(workspaceId, ...a),
          list: (appId: string) => W.listAppDeployments(workspaceId, appId),
          get: (...a: DropFirst<Parameters<typeof W.getAppDeployment>>) =>
            W.getAppDeployment(workspaceId, ...a),
          logs: (...a: DropFirst<Parameters<typeof W.getAppDeploymentLogs>>) =>
            W.getAppDeploymentLogs(workspaceId, ...a),
        },
        start: (appId: string) => W.startApp(workspaceId, appId),
        stop: (appId: string) => W.stopApp(workspaceId, appId),
        rollback: (...a: DropFirst<Parameters<typeof W.rollbackApp>>) =>
          W.rollbackApp(workspaceId, ...a),
      },

      /** Workspace-scoped CLI PATs (auto-minted at session-create as `KORTIX_TOKEN`; can also be minted by hand). */
      tokens: {
        list: () => W.listWorkspaceCliTokens(workspaceId),
        create: (input?: Parameters<typeof W.createWorkspaceCliToken>[1]) =>
          W.createWorkspaceCliToken(workspaceId, input),
        revoke: (tokenId: string) => W.revokeWorkspaceCliToken(workspaceId, tokenId),
      },

      /** Agent-minted setup links — hand a human a link to enter a secret value or 1-click connect an app. */
      setupLinks: {
        requestSecret: (input: Parameters<typeof W.requestWorkspaceSecret>[1]) =>
          W.requestWorkspaceSecret(workspaceId, input),
        requestConnector: (input: Parameters<typeof W.requestWorkspaceConnector>[1]) =>
          W.requestWorkspaceConnector(workspaceId, input),
      },

      /** Validate a `kortix.yaml` (or legacy `kortix.toml`) manifest's raw text server-side — format is auto-resolved from the workspace's manifest path (same schema `kortix ship`/CR-merge use). */
      validateManifest: (raw: string) => W.validateWorkspaceManifest(workspaceId, raw),

      /** Mint a fresh scoped git push token for a managed workspace (409 for BYO repos). */
      gitToken: () => W.getWorkspaceGitToken(workspaceId),

      secrets: {
        list: () => W.listWorkspaceSecrets(workspaceId),
        upsert: (input: Parameters<typeof W.upsertWorkspaceSecret>[1]) =>
          W.upsertWorkspaceSecret(workspaceId, input),
        setStrategy: (...a: DropFirst<Parameters<typeof W.setWorkspaceSecretStrategy>>) =>
          W.setWorkspaceSecretStrategy(workspaceId, ...a),
        broker: (...a: DropFirst<Parameters<typeof W.brokerWorkspaceSecretRequest>>) =>
          W.brokerWorkspaceSecretRequest(workspaceId, ...a),
        remove: (name: string) => W.deleteWorkspaceSecret(workspaceId, name),
        setPersonal: (...a: DropFirst<Parameters<typeof W.setPersonalWorkspaceSecret>>) =>
          W.setPersonalWorkspaceSecret(workspaceId, ...a),
        removePersonal: (name: string) => W.deletePersonalWorkspaceSecret(workspaceId, name),
        setGitCredential: (input: Parameters<typeof W.upsertWorkspaceGitCredential>[1]) =>
          W.upsertWorkspaceGitCredential(workspaceId, input),
        /** Device-code OAuth flow to connect a subscription-backed provider (e.g. ChatGPT). */
        startProviderOAuth: (...a: DropFirst<Parameters<typeof W.startWorkspaceProviderOAuth>>) =>
          W.startWorkspaceProviderOAuth(workspaceId, ...a),
        pollProviderOAuth: (...a: DropFirst<Parameters<typeof W.pollWorkspaceProviderOAuth>>) =>
          W.pollWorkspaceProviderOAuth(workspaceId, ...a),
        removeProviderOAuth: (provider: string) =>
          W.deleteWorkspaceProviderOAuth(workspaceId, provider),
      },

      access: {
        list: () => W.listWorkspaceAccess(workspaceId),
        invite: (...a: DropFirst<Parameters<typeof W.inviteWorkspaceMember>>) =>
          W.inviteWorkspaceMember(workspaceId, ...a),
        update: (...a: DropFirst<Parameters<typeof W.updateWorkspaceAccess>>) =>
          W.updateWorkspaceAccess(workspaceId, ...a),
        revoke: (userId: string) => W.revokeWorkspaceAccess(workspaceId, userId),
        pendingInvites: () => W.listPendingWorkspaceInvites(workspaceId),
        resendInvite: (...a: DropFirst<Parameters<typeof W.resendPendingWorkspaceInvite>>) =>
          W.resendPendingWorkspaceInvite(workspaceId, ...a),
        revokeInvite: (...a: DropFirst<Parameters<typeof W.revokePendingWorkspaceInvite>>) =>
          W.revokePendingWorkspaceInvite(workspaceId, ...a),
        requests: () => W.listWorkspaceAccessRequests(workspaceId),
        approveRequest: (...a: DropFirst<Parameters<typeof W.approveWorkspaceAccessRequest>>) =>
          W.approveWorkspaceAccessRequest(workspaceId, ...a),
        rejectRequest: (...a: DropFirst<Parameters<typeof W.rejectWorkspaceAccessRequest>>) =>
          W.rejectWorkspaceAccessRequest(workspaceId, ...a),
        groupGrants: () => W.listWorkspaceGroupGrants(workspaceId),
        attachGroupGrant: (...a: DropFirst<Parameters<typeof W.attachGroupToWorkspace>>) =>
          W.attachGroupToWorkspace(workspaceId, ...a),
        updateGroupGrant: (...a: DropFirst<Parameters<typeof W.updateWorkspaceGroupGrant>>) =>
          W.updateWorkspaceGroupGrant(workspaceId, ...a),
        detachGroupGrant: (groupId: string) => W.detachGroupFromWorkspace(workspaceId, groupId),
        /** Per-resource (agent/skill/secret) grants to a member or a group. */
        resourceGrants: {
          list: () => W.listWorkspaceResourceGrants(workspaceId),
          create: (input: Parameters<typeof W.createWorkspaceResourceGrant>[1]) =>
            W.createWorkspaceResourceGrant(workspaceId, input),
          remove: (grantId: string) => W.deleteWorkspaceResourceGrant(workspaceId, grantId),
        },
      },

      connectors: {
        ...connectorDataPlane(workspaceId),
        list: () => W.listConnectors(workspaceId),
        config: (...a: DropFirst<Parameters<typeof W.getConnectorConfig>>) =>
          W.getConnectorConfig(workspaceId, ...a),
        create: (...a: DropFirst<Parameters<typeof W.createConnector>>) =>
          W.createConnector(workspaceId, ...a),
        remove: (...a: DropFirst<Parameters<typeof W.deleteConnector>>) =>
          W.deleteConnector(workspaceId, ...a),
        sync: () => W.syncConnectors(workspaceId),
        auth: {
          discover: (...a: DropFirst<Parameters<typeof W.discoverConnectorAuth>>) =>
            W.discoverConnectorAuth(workspaceId, ...a),
        },
        setName: (...a: DropFirst<Parameters<typeof W.setConnectorName>>) =>
          W.setConnectorName(workspaceId, ...a),
        setCredentialMode: (...a: DropFirst<Parameters<typeof W.setConnectorCredentialMode>>) =>
          W.setConnectorCredentialMode(workspaceId, ...a),
        setAuthorizationStrategy: (
          ...a: DropFirst<Parameters<typeof W.setConnectorAuthorizationStrategy>>
        ) => W.setConnectorAuthorizationStrategy(workspaceId, ...a),
        setCredential: (...a: DropFirst<Parameters<typeof W.setConnectorCredential>>) =>
          W.setConnectorCredential(workspaceId, ...a),
        setSensitive: (...a: DropFirst<Parameters<typeof W.setConnectorSensitive>>) =>
          W.setConnectorSensitive(workspaceId, ...a),
        connections,
        policies: {
          get: (...a: DropFirst<Parameters<typeof W.getConnectorPolicies>>) =>
            W.getConnectorPolicies(workspaceId, ...a),
          set: (...a: DropFirst<Parameters<typeof W.setConnectorPolicies>>) =>
            W.setConnectorPolicies(workspaceId, ...a),
        },
        /** Easy-connect (Pipedream): app catalog + connect/finalize handshake. */
        pipedream: {
          listApps: (...a: DropFirst<Parameters<typeof W.listPipedreamApps>>) =>
            W.listPipedreamApps(workspaceId, ...a),
          connect: (...a: DropFirst<Parameters<typeof W.pipedreamConnect>>) =>
            W.pipedreamConnect(workspaceId, ...a),
          finalize: (...a: DropFirst<Parameters<typeof W.pipedreamFinalize>>) =>
            W.pipedreamFinalize(workspaceId, ...a),
        },
        /** Direct connector catalogue and normalized domain surfaces. */
        discover: {
          list: (...a: DropFirst<Parameters<typeof W.listDiscoverConnectors>>) =>
            W.listDiscoverConnectors(workspaceId, ...a),
          detail: (...a: DropFirst<Parameters<typeof W.getDiscoverConnector>>) =>
            W.getDiscoverConnector(workspaceId, ...a),
        },
      },

      policies: {
        list: () => W.listWorkspacePolicies(workspaceId),
        set: (...a: DropFirst<Parameters<typeof W.setWorkspacePolicies>>) =>
          W.setWorkspacePolicies(workspaceId, ...a),
      },

      triggers: {
        list: () => W.listWorkspaceTriggers(workspaceId),
        create: (...a: DropFirst<Parameters<typeof W.createWorkspaceTrigger>>) =>
          W.createWorkspaceTrigger(workspaceId, ...a),
        update: (...a: DropFirst<Parameters<typeof W.updateWorkspaceTrigger>>) =>
          W.updateWorkspaceTrigger(workspaceId, ...a),
        remove: (...a: DropFirst<Parameters<typeof W.deleteWorkspaceTrigger>>) =>
          W.deleteWorkspaceTrigger(workspaceId, ...a),
        fire: (...a: DropFirst<Parameters<typeof W.fireWorkspaceTrigger>>) =>
          W.fireWorkspaceTrigger(workspaceId, ...a),
        setActivation: (...a: DropFirst<Parameters<typeof W.setWorkspaceTriggersActivation>>) =>
          W.setWorkspaceTriggersActivation(workspaceId, ...a),
      },

      files: {
        list: (options?: Parameters<typeof W.listWorkspaceFiles>[1]) =>
          W.listWorkspaceFiles(workspaceId, options),
        read: (path: string, ref?: string) => W.readWorkspaceFile(workspaceId, path, ref),
        search: (...a: DropFirst<Parameters<typeof W.searchWorkspaceFiles>>) =>
          W.searchWorkspaceFiles(workspaceId, ...a),
        archive: (...a: DropFirst<Parameters<typeof W.fetchWorkspaceArchive>>) =>
          W.fetchWorkspaceArchive(workspaceId, ...a),
        history: (...a: DropFirst<Parameters<typeof W.getWorkspaceFileHistory>>) =>
          W.getWorkspaceFileHistory(workspaceId, ...a),
      },

      git: {
        commits: () => W.listWorkspaceCommits(workspaceId),
        commit: (sha: string) => W.getWorkspaceCommit(workspaceId, sha),
        commitDiff: (sha: string) => W.getWorkspaceCommitDiff(workspaceId, sha),
        branches: () => W.listWorkspaceBranches(workspaceId),
        versionDiff: (...a: DropFirst<Parameters<typeof W.getVersionDiff>>) =>
          W.getVersionDiff(workspaceId, ...a),
        /** Invite a GitHub user as a collaborator on a Kortix-managed repo. */
        inviteCollaborator: (...a: DropFirst<Parameters<typeof W.inviteRepoCollaborator>>) =>
          W.inviteRepoCollaborator(workspaceId, ...a),
      },

      changeRequests: {
        list: () => W.listChangeRequests(workspaceId),
        get: (crId: string) => W.getChangeRequest(workspaceId, crId),
        diff: (crId: string) => W.getChangeRequestDiff(workspaceId, crId),
        mergePreview: (crId: string) => W.getChangeRequestMergePreview(workspaceId, crId),
        open: (...a: DropFirst<Parameters<typeof W.openChangeRequest>>) =>
          W.openChangeRequest(workspaceId, ...a),
        merge: (...a: DropFirst<Parameters<typeof W.mergeChangeRequest>>) =>
          W.mergeChangeRequest(workspaceId, ...a),
        close: (...a: DropFirst<Parameters<typeof W.closeChangeRequest>>) =>
          W.closeChangeRequest(workspaceId, ...a),
        reopen: (...a: DropFirst<Parameters<typeof W.reopenChangeRequest>>) =>
          W.reopenChangeRequest(workspaceId, ...a),
        /** Request changes on a CR (Review Center) — records feedback + optionally delivers it back to the originating session. */
        requestChanges: (...a: DropFirst<Parameters<typeof W.requestChangesOnChangeRequest>>) =>
          W.requestChangesOnChangeRequest(workspaceId, ...a),
      },

      sessions: {
        list: (options?: Parameters<typeof W.listWorkspaceSessions>[1]) =>
          W.listWorkspaceSessions(workspaceId, options),
        create: (input?: Parameters<typeof W.createWorkspaceSession>[1]) =>
          W.createWorkspaceSession(workspaceId, input),
        ensureWarm: () => W.ensureWarmWorkspaceSession(workspaceId),
        claimWarm: (input: Parameters<typeof W.claimWarmWorkspaceSession>[1]) =>
          W.claimWarmWorkspaceSession(workspaceId, input),
      },

      /** Review Center — the per-workspace human-in-the-loop inbox (change requests, tool approvals, agent outputs/decisions). */
      review: {
        list: (params?: Parameters<typeof W.listReviewItems>[1]) =>
          W.listReviewItems(workspaceId, params),
        get: (reviewItemId: string) => W.getReviewItem(workspaceId, reviewItemId),
        submit: (input: Parameters<typeof W.submitReviewItem>[1]) =>
          W.submitReviewItem(workspaceId, input),
        act: (...a: DropFirst<Parameters<typeof W.actReviewItem>>) =>
          W.actReviewItem(workspaceId, ...a),
        bulkAct: (input: Parameters<typeof W.bulkActReviewItems>[1]) =>
          W.bulkActReviewItems(workspaceId, input),
      },

      /** The manager inbox of connector-gated actions awaiting approve/deny (APPROVE / ASK / BLOCK). */
      approvals: {
        list: (options?: Parameters<typeof W.listPendingApprovals>[1]) =>
          W.listPendingApprovals(workspaceId, options),
        resolve: (...a: DropFirst<Parameters<typeof W.resolveApproval>>) =>
          W.resolveApproval(workspaceId, ...a),
        sessionsNeedingInput: (options?: Parameters<typeof W.listSessionsNeedingInput>[1]) =>
          W.listSessionsNeedingInput(workspaceId, options),
      },

      /** Gateway observability — LLM request logs, cost/latency rollups, budgets, gateway API keys. */
      gateway: {
        logs: (opts?: Parameters<typeof W.listGatewayLogs>[1]) =>
          W.listGatewayLogs(workspaceId, opts),
        log: (logId: string) => W.getGatewayLog(workspaceId, logId),
        overview: (days?: number) => W.getGatewayOverview(workspaceId, days),
        series: (days?: number) => W.getGatewaySeries(workspaceId, days),
        breakdown: (days?: number) => W.getGatewayBreakdown(workspaceId, days),
        sessions: (days?: number) => W.getGatewaySessions(workspaceId, days),
        errors: (days?: number) => W.getGatewayErrors(workspaceId, days),
        budgets: () => W.getGatewayBudgets(workspaceId),
        setBudget: (input: Parameters<typeof W.setGatewayBudget>[1]) =>
          W.setGatewayBudget(workspaceId, input),
        deleteBudget: (budgetId: string) => W.deleteGatewayBudget(workspaceId, budgetId),
        keys: () => W.getGatewayKeys(workspaceId),
        createKey: (name: string) => W.createGatewayKey(workspaceId, name),
        revokeKey: (keyId: string) => W.revokeGatewayKey(workspaceId, keyId),
        routing: {
          get: () => W.getGatewayRoutingPolicy(workspaceId),
          set: (policy: Parameters<typeof W.setGatewayRoutingPolicy>[1]) =>
            W.setGatewayRoutingPolicy(workspaceId, policy),
          reset: () => W.resetGatewayRoutingPolicy(workspaceId),
          preview: (input: Parameters<typeof W.previewGatewayRoute>[1]) =>
            W.previewGatewayRoute(workspaceId, input),
        },
        /** Run one prompt against up to 6 models side by side (a model-comparison playground). */
        playground: (prompt: string, models: string[], system?: string) =>
          W.runGatewayPlayground(workspaceId, prompt, models, system),
      },

      /** Slack + email + Meet channel connections. */
      channels: {
        slack: {
          installation: () => W.getSlackInstallation(workspaceId),
          connect: (input: Parameters<typeof W.connectSlack>[1]) =>
            W.connectSlack(workspaceId, input),
          mode: () => W.getSlackMode(workspaceId),
          manifest: () => W.getSlackManifest(workspaceId),
          disconnect: () => W.disconnectSlack(workspaceId),
          /** Download a Slack-hosted file through the server-side proxy (bot token stays server-side). */
          getFile: (url: string) => W.getSlackChannelFile(workspaceId, url),
          /** Upload a file to Slack through the server-side 3-step external-upload proxy. */
          uploadFile: (input: Parameters<typeof W.uploadSlackChannelFile>[1]) =>
            W.uploadSlackChannelFile(workspaceId, input),
        },
        email: {
          installation: (connectorSlug?: string | null) =>
            W.getEmailInstallation(workspaceId, connectorSlug),
          mode: () => W.getEmailMode(workspaceId),
          connect: (input: Parameters<typeof W.connectEmail>[1]) =>
            W.connectEmail(workspaceId, input),
          disconnect: (connectorSlug?: string | null) =>
            W.disconnectEmail(workspaceId, connectorSlug),
          updatePolicy: (...a: DropFirst<Parameters<typeof W.updateEmailPolicy>>) =>
            W.updateEmailPolicy(workspaceId, ...a),
        },
        voice: {
          setBotName: (name: string) => W.setMeetBotName(workspaceId, name),
        },
      },

      /** Toggle a feature flag (Customize → Feature flags). Pass `enabled: null` to clear the override. */
      updateFeatureFlag: (...a: DropFirst<Parameters<typeof W.updateFeatureFlag>>) =>
        W.updateFeatureFlag(workspaceId, ...a),

      /** @deprecated Renamed to `updateFeatureFlag`. Keeps the legacy `/experimental` wire path for older deployed APIs. */
      updateExperimentalFeature: (
        ...a: DropFirst<Parameters<typeof W.updateExperimentalFeature>>
      ) => W.updateExperimentalFeature(workspaceId, ...a),

      /** Default model preferences (account/agent/workspace scope, gateway-resolved). */
      modelDefaults: {
        get: () => W.getModelDefaults(workspaceId),
        set: (input: Parameters<typeof W.setModelDefault>[1]) =>
          W.setModelDefault(workspaceId, input),
        clear: (params: Parameters<typeof W.clearModelDefault>[1]) =>
          W.clearModelDefault(workspaceId, params),
      },

      /** Set the agent used when a new workspace session does not name one explicitly. */
      setDefaultAgent: (agentName: string) => W.updateWorkspaceDefaultAgent(workspaceId, agentName),

      /** Sandbox templates + snapshot builds — Dockerfile/image/warm-pool config, beyond `sandboxHealth`/`sandboxTemplates`. */
      sandbox: {
        list: () => W.listWorkspaceSandboxes(workspaceId),
        snapshots: () => W.listWorkspaceSnapshots(workspaceId),
        rebuildSnapshot: (slug?: string) => W.rebuildWorkspaceSnapshot(workspaceId, slug),
        fixWithAgent: () => W.fixSandboxWithAgent(workspaceId),
        createTemplate: (input: Parameters<typeof W.createSandboxTemplate>[1]) =>
          W.createSandboxTemplate(workspaceId, input),
        updateTemplate: (...a: DropFirst<Parameters<typeof W.updateSandboxTemplate>>) =>
          W.updateSandboxTemplate(workspaceId, ...a),
        removeTemplate: (templateId: string) => W.deleteSandboxTemplate(workspaceId, templateId),
        buildTemplate: (templateId: string) => W.buildSandboxTemplate(workspaceId, templateId),
        /** Pin/clear the per-workspace sandbox provider (null = follow the platform default). */
        setProvider: (provider: Parameters<typeof W.updateWorkspaceSandboxProvider>[1]) =>
          W.updateWorkspaceSandboxProvider(workspaceId, provider),
      },

      /** Bind specific secrets + connectors to an agent (the inheritance pyramid's declaration step). */
      setAgentScope: (...a: DropFirst<Parameters<typeof W.setAgentScope>>) =>
        W.setAgentScope(workspaceId, ...a),

      session: (sessionId: string) => workspaceSession(workspaceId, sessionId),
    };
  }

  /** Id-bound handle for a single session: lifecycle (REST) + runtime (opencode). */
  function projectSession(workspaceId: string, sessionId: string) {
    // Opinionated-action state, scoped to THIS handle. The opencode runtime is
    // keyed by the OpenCode session id (resolved server-side at /start), NOT the
    // Kortix `sessionId` — they differ. We resolve+cache it once (including the
    // resolved runtime URL + sandbox id), and remember a chosen model so `send`
    // carries it. Every runtime-scoped operation below reads ONLY this cached
    // record — never the module-global "currently active" runtime — so two
    // session handles pointed at two different sandboxes never cross wires.
    let _ready: SessionRuntimeEntry | null = null;
    let _model: SessionModel | undefined;
    let _agent: string | undefined;
    let _persistedPromptDefaults: Promise<{
      model?: SessionModel;
      agent?: string;
    }> | null = null;

    /**
     * Resolve the server-owned prompt defaults once per handle.
     *
     * A stateful snapshot can contain an existing OpenCode session. OpenCode
     * then reuses that session's last model unless every prompt specifies the
     * current project-session model. Read the persisted Kortix session so the
     * first SDK prompt cannot inherit stale snapshot configuration.
     */
    async function persistedPromptDefaults(): Promise<{
      model?: SessionModel;
      agent?: string;
    }> {
      if (!_persistedPromptDefaults) {
        _persistedPromptDefaults = P.getProjectSession(workspaceId, sessionId, {
          showErrors: false,
        }).then((projectSession) => {
          const modelReference =
            typeof projectSession.metadata?.opencode_model === 'string'
              ? projectSession.metadata.opencode_model.trim()
              : '';
          const separator = modelReference.indexOf('/');
          const model =
            separator > 0 && separator < modelReference.length - 1
              ? {
                  providerID: modelReference.slice(0, separator),
                  modelID: modelReference.slice(separator + 1),
                }
              : undefined;
          const agent = projectSession.agent_name?.trim() || undefined;
          return { model, agent };
        });
      }
      try {
        return await _persistedPromptDefaults;
      } catch (error) {
        // A transient read must not poison every later send on this handle.
        _persistedPromptDefaults = null;
        throw error;
      }
    }

    /**
     * Adopt an already-resolved runtime for THIS (workspaceId, sessionId) from
     * the shared session-runtime registry, if this handle hasn't resolved one
     * itself yet. This is what lets a brand-new `kortix.session(pid, sid)`
     * handle — e.g. a one-off poll tick, or a handle created independently of
     * the one that actually drove `/start` — use a session another handle (or
     * the React `useSession` hook) already brought up, instead of throwing
     * `SessionNotReadyError` or re-provisioning.
     */
    function tryResolveReady(): SessionRuntimeEntry | null {
      if (_ready) return _ready;
      const cached = getSessionRuntime(workspaceId, sessionId);
      if (cached) _ready = cached;
      return _ready;
    }

    /**
     * Make this session's runtime reachable and return its OpenCode session id
     * (plus this handle's own resolved runtime URL + sandbox id). Idempotent:
     * adopts the registry entry if another handle already resolved this
     * session; otherwise `start` provisions/resumes the sandbox (long-poll
     * until ready) — which itself populates the registry on success — and we
     * cache the resolved runtime for THIS handle. Also points the app's shared
     * "current runtime" store there, for React hosts that still read it.
     */
    async function ensureReady(opts?: { readyTimeoutMs?: number }): Promise<SessionRuntimeEntry> {
      const cached = tryResolveReady();
      if (cached) return cached;
      const readyTimeoutMs = opts?.readyTimeoutMs ?? 180_000;

      // Dedup concurrent starts for this (workspaceId, sessionId) — see
      // `inFlightSessionStarts`'s doc comment. If another call (this handle or
      // a different one) already kicked off `/start`, ride its result instead
      // of issuing a second POST.
      const key = `${workspaceId}\n${sessionId}`;
      const inFlight = inFlightSessionStarts.get(key);
      if (inFlight) {
        _ready = await inFlight;
        return _ready;
      }

      const startPromise = (async (): Promise<SessionRuntimeEntry> => {
        // Poll /start (each call long-polls up to 30s) until the runtime is
        // ready. `/start` returns `retriable: true` while the sandbox is still
        // provisioning/starting — a cold start can outlast a single long-poll —
        // so keep polling until it's ready, hits a terminal stage, or the
        // deadline. A single check would spuriously throw RUNTIME_UNAVAILABLE
        // on a slow boot, which is exactly what a backend waiting to send the
        // first turn must not do.
        const deadline = Date.now() + readyTimeoutMs;
        // Cap each server long-poll (and the inter-poll pause) to the time left
        // so the total honors readyTimeoutMs — a fixed 30s wait would overshoot
        // the deadline by up to ~30s on the final iteration.
        const remainingMs = () => Math.max(0, deadline - Date.now());
        let started = await P.startProjectSession(
          workspaceId,
          sessionId,
          Math.min(30_000, remainingMs()),
        );
        // Keep polling while the runtime is still coming up. A `null` result is
        // a TRANSIENT tick, not a terminal state: startProjectSession returns
        // null for a 5xx/408/429/network blip AND the create→start 404 race
        // (row not yet visible on the read path) — the exact cases a backend
        // hits calling ensureReady() right after create(). Only a resolved
        // provisioning/starting+retriable result or the deadline keeps/ends the
        // loop; ready/failed/stopped fall through to the guard below.
        while (
          Date.now() < deadline &&
          (started == null ||
            ((started.stage === 'provisioning' || started.stage === 'starting') &&
              started.retriable))
        ) {
          await new Promise((r) => setTimeout(r, Math.min(1_000, remainingMs())));
          started = await P.startProjectSession(
            workspaceId,
            sessionId,
            Math.min(30_000, remainingMs()),
          );
        }
        if (
          !started ||
          started.stage !== 'ready' ||
          !started.sandbox ||
          !started.opencode_session_id
        ) {
          throw new ApiError(`Session runtime not ready (stage: ${started?.stage ?? 'unknown'})`, {
            code: 'RUNTIME_UNAVAILABLE',
          });
        }
        const externalId = (started.sandbox as { external_id?: string | null }).external_id;
        if (!externalId) {
          throw new ApiError(
            'Session sandbox has no external_id — cannot resolve its runtime URL',
            {
              code: 'RUNTIME_UNAVAILABLE',
            },
          );
        }
        const runtimeUrl = getSandboxUrlForExternalId(externalId);
        // Point the app's shared runtime store at this session too, so React
        // hosts (which read the global current-runtime) keep working — but this
        // handle's own operations never read it back, only `_ready` below.
        setCurrentRuntime(runtimeUrl, externalId);
        return {
          opencodeSessionId: started.opencode_session_id,
          runtimeUrl,
          sandboxId: externalId,
        };
      })();

      inFlightSessionStarts.set(key, startPromise);
      try {
        _ready = await startPromise;
        return _ready;
      } finally {
        if (inFlightSessionStarts.get(key) === startPromise) {
          inFlightSessionStarts.delete(key);
        }
      }
    }

    /** Throw `SessionNotReadyError` if neither this handle nor the registry has resolved a runtime yet. */
    function requireReady(action: string): SessionRuntimeEntry {
      const ready = tryResolveReady();
      if (!ready) throw new SessionNotReadyError(action);
      return ready;
    }

    /** Clear this handle's cached runtime + the shared registry entry (restart/delete). */
    function forgetReady(): void {
      _ready = null;
      clearSessionRuntime(workspaceId, sessionId);
    }

    return {
      // ── lifecycle (Kortix REST) ──────────────────────────────────────────
      get: (opts?: { showErrors?: boolean }) => P.getProjectSession(workspaceId, sessionId, opts),
      /** Unified finalized LLM and compute cost for this session. */
      cost: () => P.getSessionCostRecord(sessionId, { workspaceId }),
      update: (input: Parameters<typeof P.updateProjectSession>[2]) =>
        P.updateProjectSession(workspaceId, sessionId, input),
      delete: () => {
        // A deleted session's sandbox is gone — never let a later handle for
        // this (workspaceId, sessionId) resolve a runtime that no longer exists.
        forgetReady();
        return P.deleteProjectSession(workspaceId, sessionId);
      },
      start: (...a: DropFirst2<Parameters<typeof P.startProjectSession>>) =>
        P.startProjectSession(workspaceId, sessionId, ...a),
      restart: () => {
        // Restart preserves the established sandbox identity, but readiness
        // and the proxy connection must still be resolved again after reboot.
        forgetReady();
        return P.restartProjectSession(workspaceId, sessionId);
      },
      stop: () => {
        forgetReady();
        return P.stopProjectSession(workspaceId, sessionId);
      },
      /** Is this session still running the config the manifest compiles to? */
      configState: () => P.getProjectSessionConfigState(workspaceId, sessionId),
      /**
       * Recompile the agent config from git into this running session.
       *
       * Restarts opencode to rebuild its config, so readiness has to be
       * resolved again — same reason `restart` forgets it.
       */
      reloadConfig: (input?: Parameters<typeof P.reloadProjectSessionConfig>[2]) => {
        forgetReady();
        return P.reloadProjectSessionConfig(workspaceId, sessionId, input);
      },
      setSharing: (intent: Parameters<typeof P.setProjectSessionSharing>[2]) =>
        P.setProjectSessionSharing(workspaceId, sessionId, intent),
      previews: () => P.getSessionPreviewCandidates(workspaceId, sessionId),
      commit: (input?: Parameters<typeof P.commitSessionChanges>[2]) =>
        P.commitSessionChanges(workspaceId, sessionId, input),
      publicShares: {
        list: () => P.listSessionPublicShares(workspaceId, sessionId),
        create: (...a: DropFirst2<Parameters<typeof P.createSessionPublicShare>>) =>
          P.createSessionPublicShare(workspaceId, sessionId, ...a),
        revoke: (...a: DropFirst2<Parameters<typeof P.revokeSessionPublicShare>>) =>
          P.revokeSessionPublicShare(workspaceId, sessionId, ...a),
      },
      /** Per-session audit trail of connector-gated agent actions. */
      audit: (limit?: number, options?: Parameters<typeof P.getSessionAudit>[3]) =>
        P.getSessionAudit(workspaceId, sessionId, limit, options),
      /** Compact server-side transcript read (text + tool calls, no tool inputs/outputs) — callable with project-scoped session tokens. */
      transcript: (options?: Parameters<typeof P.getSessionTranscript>[2]) =>
        P.getSessionTranscript(workspaceId, sessionId, options),
      /** This session's live voice-call transcript (spoken turns + ask_kortix/run_command calls). */
      voiceTranscript: (options?: Parameters<typeof P.getVoiceTranscript>[2]) =>
        P.getVoiceTranscript(workspaceId, sessionId, options),

      /**
       * Resolve THIS handle's own runtime (idempotent): provisions/resumes the
       * sandbox (long-poll until ready) and caches the resolved OpenCode session
       * id + runtime URL + sandbox id for every other call on this handle. Call
       * this (or `send`/`abort`, which call it internally) before `.runtime`,
       * `.health()`, `.previewUrl()`, or `.proxyUrl()` — those throw
       * `SessionNotReadyError` instead of falling back to whatever sandbox
       * happens to be globally active.
       */
      ensureReady,

      // ── runtime health + preview (the session owns its runtime) ──────────
      /**
       * Liveness/readiness of THIS session's runtime (`GET /kortix/health`).
       * Unlike `.previewUrl()`/`.proxyUrl()`/`.runtime`, this never throws
       * `SessionNotReadyError` — a health poller (e.g. a header dot ticking
       * every 15s on a fresh inline handle) needs to be callable BEFORE the
       * session has ever resolved a runtime. It degrades to the same graceful
       * `{ status: 0, ok: false }` shape `getSessionHealth` already returns for
       * "no URL yet", instead of forcing every caller to guard with `ensureReady()`.
       */
      health: (init?: RequestInit) => getSessionHealth(tryResolveReady()?.runtimeUrl ?? null, init),
      /** Proxy/preview URL for a port THIS session's runtime exposes. */
      previewUrl: (port: number, path = '/') =>
        rewriteLocalhostUrl(
          port,
          path,
          resolvePreviewOptsForSandbox(requireReady('previewUrl').sandboxId),
        ),
      /** Rewrite a localhost URL the agent printed into a reachable proxy URL. */
      proxyUrl: (url?: string) =>
        proxyLocalhostUrl(url, resolvePreviewOptsForSandbox(requireReady('proxyUrl').sandboxId)),

      // ── agent actions (opinionated wrappers over the runtime) ────────────
      // These do the right thing end-to-end for scripts/non-React hosts: ensure
      // the runtime is up, resolve the OpenCode session id, and act through a
      // client bound to THIS handle's own runtime URL (never the module-global
      // "active" one, so parallel handles on different sandboxes never cross
      // wires). React hosts use `@kortix/sdk/react` hooks instead, which bind to
      // the same resolved id reactively (see the white-label reference app).
      /** Pick the model `send` will use for subsequent prompts (until changed). */
      setModel: (model: SessionModel | undefined) => {
        _model = model;
      },
      /**
       * PERSIST a new model for this session server-side, re-pointing the
       * running sandbox. Distinct from `setModel`, which only chooses what the
       * NEXT local `send` asks for and never leaves this handle.
       *
       * Restarting the runtime is how the change takes effect, so an in-flight
       * turn ends. `applied_live` reports whether a running session took it now
       * or whether it applies at next start.
       */
      changeModel: async (model: string) => {
        const result = await P.setProjectSessionModel(workspaceId, sessionId, model);
        _persistedPromptDefaults = null;
        return result;
      },
      /** Read the authoritative secret allowlist and connections. */
      scope: () => P.getProjectSessionScope(workspaceId, sessionId),
      /** Re-scope a running session — set semantics; see setProjectSessionScope. */
      rescope: (scope: P.SessionScopeInput) =>
        P.setProjectSessionScope(workspaceId, sessionId, scope),
      /** Pick the agent `send` will use for subsequent prompts (until changed). */
      setAgent: (agent: string | undefined) => {
        _agent = agent;
      },
      /**
       * Provision/resume if needed, then send a text prompt to the agent. A
       * per-call `{ model, agent }` overrides the sticky setModel/setAgent
       * choices for this message only.
       */
      send: async (text: string, opts?: { model?: SessionModel; agent?: string }) => {
        const { opencodeSessionId, runtimeUrl } = await ensureReady();
        const selectedModel = opts?.model ?? _model;
        const selectedAgent = opts?.agent ?? _agent;
        const persisted = selectedModel && selectedAgent ? {} : await persistedPromptDefaults();
        const model = selectedModel ?? persisted.model;
        const agent = selectedAgent ?? persisted.agent;
        return getClientForUrl(runtimeUrl).session.prompt({
          sessionID: opencodeSessionId,
          parts: [{ type: 'text', text }],
          ...(model ? { model } : {}),
          ...(agent ? { agent } : {}),
        });
      },
      /** Abort the agent's current run in this session. */
      abort: async () => {
        const { opencodeSessionId, runtimeUrl } = await ensureReady();
        return getClientForUrl(runtimeUrl).session.abort({
          sessionID: opencodeSessionId,
        });
      },
      /**
       * Stage a reversible rollback at one user message on this same canonical
       * OpenCode session. The next prompt commits the new path.
       */
      rewind: async (messageId: string) => {
        const { opencodeSessionId, runtimeUrl } = await ensureReady();
        return getClientForUrl(runtimeUrl).session.revert({
          sessionID: opencodeSessionId,
          messageID: messageId,
        });
      },
      /** Restore the path removed by `rewind()` before another prompt commits it. */
      restoreRewind: async () => {
        const { opencodeSessionId, runtimeUrl } = await ensureReady();
        return getClientForUrl(runtimeUrl).session.unrevert({
          sessionID: opencodeSessionId,
        });
      },
      /**
       * Live SSE stream of THIS session's runtime events (message/part
       * updates, session status, permissions/questions, lsp diagnostics, …).
       * A thin facade over the framework-free `openEventStream` primitive
       * (`@kortix/sdk`'s `openEventStream`, also used verbatim by
       * `@kortix/sdk/react`'s `useOpenCodeEventStream`): resolves THIS
       * handle's own runtime first (`ensureReady()`), then connects a client
       * bound to that runtime URL — never the module-global "active" one, so
       * two session handles on two different sandboxes never cross wires.
       * Framework-free — safe to call from a server-side "Kortix as a
       * Backend" wrapper (Node/Bun), a worker, a CLI, or any non-React host.
       *
       * Handles connect/reconnect/backoff, a 15s heartbeat watchdog, and
       * event coalescing internally. Call `handle.close()` to stop.
       *
       *   const handle = await session.stream({ onEvent: (e) => console.log(e) });
       *   // later
       *   handle.close();
       */
      stream: async (opts: {
        onEvent: (event: OpenCodeEvent) => void;
        onGapRehydrate?: (gapMs: number) => void;
        signal?: AbortSignal;
      }): Promise<EventStreamHandle> => {
        const { runtimeUrl } = await ensureReady();
        return openEventStream({
          client: getClientForUrl(runtimeUrl),
          onEvent: opts.onEvent,
          onGapRehydrate: opts.onGapRehydrate,
          signal: opts.signal,
        });
      },

      // ── runtime (opencode v2, THIS session's own sandbox) ────────────────
      // The typed opencode client, reached ONLY through the SDK. The host never
      // imports `@opencode-ai/sdk`. Opinionated wrappers (prompt/abort/setModel
      // with server-owned side-effects) layer on top of this as they land.
      get runtime(): OpencodeClient {
        return getClientForUrl(requireReady('runtime').runtimeUrl);
      },

      /**
       * Workspace file operations (daemon `/file` + `/find`) bound to THIS
       * session's own resolved runtime — never the module-global "active"
       * sandbox the top-level `@kortix/sdk` `files` export follows. Fixes a
       * cross-session bleed: a host juggling multiple open sessions (e.g. a
       * server wrapping several concurrent agent sessions) that called the
       * global `files.list()` while a DIFFERENT session was "active" would
       * silently read/write the wrong sandbox. Each call here auto-provisions
       * via `ensureReady()` (same as `send`/`abort`/`stream`), then runs
       * against this handle's own runtime URL. Same 12-op surface as the
       * global `files` namespace, built from the same parameterized core
       * (`@kortix/sdk/files`'s exports all take an optional trailing
       * `baseUrl` — this just always supplies THIS session's).
       */
      files: {
        list: async (dirPath: string) => F.listFiles(dirPath, (await ensureReady()).runtimeUrl),
        read: async (filePath: string) => F.readFile(filePath, (await ensureReady()).runtimeUrl),
        readBlob: async (filePath: string) =>
          F.readBlob(filePath, (await ensureReady()).runtimeUrl),
        status: async () => F.getFileStatus((await ensureReady()).runtimeUrl),
        findFiles: async (
          query: string,
          options?: { type?: 'file' | 'directory'; limit?: number },
        ) => F.findFiles(query, options, (await ensureReady()).runtimeUrl),
        findText: async (pattern: string) => F.findText(pattern, (await ensureReady()).runtimeUrl),
        upload: async (file: File | Blob, targetPath?: string, filename?: string) =>
          F.uploadFile(file, targetPath, filename, (await ensureReady()).runtimeUrl),
        create: async (filePath: string) =>
          F.createFile(filePath, (await ensureReady()).runtimeUrl),
        copy: async (sourcePath: string, destPath: string) =>
          F.copyFile(sourcePath, destPath, (await ensureReady()).runtimeUrl),
        remove: async (filePath: string) =>
          F.deleteFile(filePath, (await ensureReady()).runtimeUrl),
        mkdir: async (dirPath: string) => F.mkdir(dirPath, (await ensureReady()).runtimeUrl),
        rename: async (from: string, to: string) =>
          F.renameFile(from, to, (await ensureReady()).runtimeUrl),
      },
    };
  }

  /** Canonical Workspace session handle. */
  /** Id-bound handle for a single session: lifecycle (REST) + runtime (opencode). */
  function workspaceSession(workspaceId: string, sessionId: string) {
    // Opinionated-action state, scoped to THIS handle. The opencode runtime is
    // keyed by the OpenCode session id (resolved server-side at /start), NOT the
    // Kortix `sessionId` — they differ. We resolve+cache it once (including the
    // resolved runtime URL + sandbox id), and remember a chosen model so `send`
    // carries it. Every runtime-scoped operation below reads ONLY this cached
    // record — never the module-global "currently active" runtime — so two
    // session handles pointed at two different sandboxes never cross wires.
    let _ready: SessionRuntimeEntry | null = null;
    let _model: SessionModel | undefined;
    let _agent: string | undefined;
    let _persistedPromptDefaults: Promise<{
      model?: SessionModel;
      agent?: string;
    }> | null = null;

    /**
     * Resolve the server-owned prompt defaults once per handle.
     *
     * A stateful snapshot can contain an existing OpenCode session. OpenCode
     * then reuses that session's last model unless every prompt specifies the
     * current workspace-session model. Read the persisted Kortix session so the
     * first SDK prompt cannot inherit stale snapshot configuration.
     */
    async function persistedPromptDefaults(): Promise<{
      model?: SessionModel;
      agent?: string;
    }> {
      if (!_persistedPromptDefaults) {
        _persistedPromptDefaults = W.getWorkspaceSession(workspaceId, sessionId, {
          showErrors: false,
        }).then((workspaceSession) => {
          const modelReference =
            typeof workspaceSession.metadata?.opencode_model === 'string'
              ? workspaceSession.metadata.opencode_model.trim()
              : '';
          const separator = modelReference.indexOf('/');
          const model =
            separator > 0 && separator < modelReference.length - 1
              ? {
                  providerID: modelReference.slice(0, separator),
                  modelID: modelReference.slice(separator + 1),
                }
              : undefined;
          const agent = workspaceSession.agent_name?.trim() || undefined;
          return { model, agent };
        });
      }
      try {
        return await _persistedPromptDefaults;
      } catch (error) {
        // A transient read must not poison every later send on this handle.
        _persistedPromptDefaults = null;
        throw error;
      }
    }

    /**
     * Adopt an already-resolved runtime for THIS (workspaceId, sessionId) from
     * the shared session-runtime registry, if this handle hasn't resolved one
     * itself yet. This is what lets a brand-new `kortix.session(pid, sid)`
     * handle — e.g. a one-off poll tick, or a handle created independently of
     * the one that actually drove `/start` — use a session another handle (or
     * the React `useSession` hook) already brought up, instead of throwing
     * `SessionNotReadyError` or re-provisioning.
     */
    function tryResolveReady(): SessionRuntimeEntry | null {
      if (_ready) return _ready;
      const cached = getSessionRuntime(workspaceId, sessionId);
      if (cached) _ready = cached;
      return _ready;
    }

    /**
     * Make this session's runtime reachable and return its OpenCode session id
     * (plus this handle's own resolved runtime URL + sandbox id). Idempotent:
     * adopts the registry entry if another handle already resolved this
     * session; otherwise `start` provisions/resumes the sandbox (long-poll
     * until ready) — which itself populates the registry on success — and we
     * cache the resolved runtime for THIS handle. Also points the app's shared
     * "current runtime" store there, for React hosts that still read it.
     */
    async function ensureReady(opts?: { readyTimeoutMs?: number }): Promise<SessionRuntimeEntry> {
      const cached = tryResolveReady();
      if (cached) return cached;
      const readyTimeoutMs = opts?.readyTimeoutMs ?? 180_000;

      // Dedup concurrent starts for this (workspaceId, sessionId) — see
      // `inFlightSessionStarts`'s doc comment. If another call (this handle or
      // a different one) already kicked off `/start`, ride its result instead
      // of issuing a second POST.
      const key = `${workspaceId}\n${sessionId}`;
      const inFlight = inFlightSessionStarts.get(key);
      if (inFlight) {
        _ready = await inFlight;
        return _ready;
      }

      const startPromise = (async (): Promise<SessionRuntimeEntry> => {
        // Poll /start (each call long-polls up to 30s) until the runtime is
        // ready. `/start` returns `retriable: true` while the sandbox is still
        // provisioning/starting — a cold start can outlast a single long-poll —
        // so keep polling until it's ready, hits a terminal stage, or the
        // deadline. A single check would spuriously throw RUNTIME_UNAVAILABLE
        // on a slow boot, which is exactly what a backend waiting to send the
        // first turn must not do.
        const deadline = Date.now() + readyTimeoutMs;
        // Cap each server long-poll (and the inter-poll pause) to the time left
        // so the total honors readyTimeoutMs — a fixed 30s wait would overshoot
        // the deadline by up to ~30s on the final iteration.
        const remainingMs = () => Math.max(0, deadline - Date.now());
        let started = await W.startWorkspaceSession(
          workspaceId,
          sessionId,
          Math.min(30_000, remainingMs()),
        );
        // Keep polling while the runtime is still coming up. A `null` result is
        // a TRANSIENT tick, not a terminal state: startWorkspaceSession returns
        // null for a 5xx/408/429/network blip AND the create→start 404 race
        // (row not yet visible on the read path) — the exact cases a backend
        // hits calling ensureReady() right after create(). Only a resolved
        // provisioning/starting+retriable result or the deadline keeps/ends the
        // loop; ready/failed/stopped fall through to the guard below.
        while (
          Date.now() < deadline &&
          (started == null ||
            ((started.stage === 'provisioning' || started.stage === 'starting') &&
              started.retriable))
        ) {
          await new Promise((r) => setTimeout(r, Math.min(1_000, remainingMs())));
          started = await W.startWorkspaceSession(
            workspaceId,
            sessionId,
            Math.min(30_000, remainingMs()),
          );
        }
        if (
          !started ||
          started.stage !== 'ready' ||
          !started.sandbox ||
          !started.opencode_session_id
        ) {
          throw new ApiError(`Session runtime not ready (stage: ${started?.stage ?? 'unknown'})`, {
            code: 'RUNTIME_UNAVAILABLE',
          });
        }
        const externalId = (started.sandbox as { external_id?: string | null }).external_id;
        if (!externalId) {
          throw new ApiError(
            'Session sandbox has no external_id — cannot resolve its runtime URL',
            {
              code: 'RUNTIME_UNAVAILABLE',
            },
          );
        }
        const runtimeUrl = getSandboxUrlForExternalId(externalId);
        // Point the app's shared runtime store at this session too, so React
        // hosts (which read the global current-runtime) keep working — but this
        // handle's own operations never read it back, only `_ready` below.
        setCurrentRuntime(runtimeUrl, externalId);
        return {
          opencodeSessionId: started.opencode_session_id,
          runtimeUrl,
          sandboxId: externalId,
        };
      })();

      inFlightSessionStarts.set(key, startPromise);
      try {
        _ready = await startPromise;
        return _ready;
      } finally {
        if (inFlightSessionStarts.get(key) === startPromise) {
          inFlightSessionStarts.delete(key);
        }
      }
    }

    /** Throw `SessionNotReadyError` if neither this handle nor the registry has resolved a runtime yet. */
    function requireReady(action: string): SessionRuntimeEntry {
      const ready = tryResolveReady();
      if (!ready) throw new SessionNotReadyError(action);
      return ready;
    }

    /** Clear this handle's cached runtime + the shared registry entry (restart/delete). */
    function forgetReady(): void {
      _ready = null;
      clearSessionRuntime(workspaceId, sessionId);
    }

    return {
      // ── lifecycle (Kortix REST) ──────────────────────────────────────────
      get: (opts?: { showErrors?: boolean }) => W.getWorkspaceSession(workspaceId, sessionId, opts),
      /** Unified finalized LLM and compute cost for this session. */
      cost: () => W.getSessionCostRecord(sessionId, { workspaceId }),
      update: (input: Parameters<typeof W.updateWorkspaceSession>[2]) =>
        W.updateWorkspaceSession(workspaceId, sessionId, input),
      delete: () => {
        // A deleted session's sandbox is gone — never let a later handle for
        // this (workspaceId, sessionId) resolve a runtime that no longer exists.
        forgetReady();
        return W.deleteWorkspaceSession(workspaceId, sessionId);
      },
      start: (...a: DropFirst2<Parameters<typeof W.startWorkspaceSession>>) =>
        W.startWorkspaceSession(workspaceId, sessionId, ...a),
      restart: () => {
        // Restart preserves the established sandbox identity, but readiness
        // and the proxy connection must still be resolved again after reboot.
        forgetReady();
        return W.restartWorkspaceSession(workspaceId, sessionId);
      },
      stop: () => {
        forgetReady();
        return W.stopWorkspaceSession(workspaceId, sessionId);
      },
      /** Is this session still running the config the manifest compiles to? */
      configState: () => W.getWorkspaceSessionConfigState(workspaceId, sessionId),
      /**
       * Recompile the agent config from git into this running session.
       *
       * Restarts opencode to rebuild its config, so readiness has to be
       * resolved again — same reason `restart` forgets it.
       */
      reloadConfig: (input?: Parameters<typeof W.reloadWorkspaceSessionConfig>[2]) => {
        forgetReady();
        return W.reloadWorkspaceSessionConfig(workspaceId, sessionId, input);
      },
      setSharing: (intent: Parameters<typeof W.setWorkspaceSessionSharing>[2]) =>
        W.setWorkspaceSessionSharing(workspaceId, sessionId, intent),
      previews: () => W.getSessionPreviewCandidates(workspaceId, sessionId),
      commit: (input?: Parameters<typeof W.commitSessionChanges>[2]) =>
        W.commitSessionChanges(workspaceId, sessionId, input),
      publicShares: {
        list: () => W.listSessionPublicShares(workspaceId, sessionId),
        create: (...a: DropFirst2<Parameters<typeof W.createSessionPublicShare>>) =>
          W.createSessionPublicShare(workspaceId, sessionId, ...a),
        revoke: (...a: DropFirst2<Parameters<typeof W.revokeSessionPublicShare>>) =>
          W.revokeSessionPublicShare(workspaceId, sessionId, ...a),
      },
      /** Per-session audit trail of connector-gated agent actions. */
      audit: (limit?: number, options?: Parameters<typeof W.getSessionAudit>[3]) =>
        W.getSessionAudit(workspaceId, sessionId, limit, options),
      /** Compact server-side transcript read (text + tool calls, no tool inputs/outputs) — callable with workspace-scoped session tokens. */
      transcript: (options?: Parameters<typeof W.getSessionTranscript>[2]) =>
        W.getSessionTranscript(workspaceId, sessionId, options),
      /** This session's live voice-call transcript (spoken turns + ask_kortix/run_command calls). */
      voiceTranscript: (options?: Parameters<typeof W.getVoiceTranscript>[2]) =>
        W.getVoiceTranscript(workspaceId, sessionId, options),

      /**
       * Resolve THIS handle's own runtime (idempotent): provisions/resumes the
       * sandbox (long-poll until ready) and caches the resolved OpenCode session
       * id + runtime URL + sandbox id for every other call on this handle. Call
       * this (or `send`/`abort`, which call it internally) before `.runtime`,
       * `.health()`, `.previewUrl()`, or `.proxyUrl()` — those throw
       * `SessionNotReadyError` instead of falling back to whatever sandbox
       * happens to be globally active.
       */
      ensureReady,

      // ── runtime health + preview (the session owns its runtime) ──────────
      /**
       * Liveness/readiness of THIS session's runtime (`GET /kortix/health`).
       * Unlike `.previewUrl()`/`.proxyUrl()`/`.runtime`, this never throws
       * `SessionNotReadyError` — a health poller (e.g. a header dot ticking
       * every 15s on a fresh inline handle) needs to be callable BEFORE the
       * session has ever resolved a runtime. It degrades to the same graceful
       * `{ status: 0, ok: false }` shape `getSessionHealth` already returns for
       * "no URL yet", instead of forcing every caller to guard with `ensureReady()`.
       */
      health: (init?: RequestInit) => getSessionHealth(tryResolveReady()?.runtimeUrl ?? null, init),
      /** Proxy/preview URL for a port THIS session's runtime exposes. */
      previewUrl: (port: number, path = '/') =>
        rewriteLocalhostUrl(
          port,
          path,
          resolvePreviewOptsForSandbox(requireReady('previewUrl').sandboxId),
        ),
      /** Rewrite a localhost URL the agent printed into a reachable proxy URL. */
      proxyUrl: (url?: string) =>
        proxyLocalhostUrl(url, resolvePreviewOptsForSandbox(requireReady('proxyUrl').sandboxId)),

      // ── agent actions (opinionated wrappers over the runtime) ────────────
      // These do the right thing end-to-end for scripts/non-React hosts: ensure
      // the runtime is up, resolve the OpenCode session id, and act through a
      // client bound to THIS handle's own runtime URL (never the module-global
      // "active" one, so parallel handles on different sandboxes never cross
      // wires). React hosts use `@kortix/sdk/react` hooks instead, which bind to
      // the same resolved id reactively (see the white-label reference app).
      /** Pick the model `send` will use for subsequent prompts (until changed). */
      setModel: (model: SessionModel | undefined) => {
        _model = model;
      },
      /**
       * PERSIST a new model for this session server-side, re-pointing the
       * running sandbox. Distinct from `setModel`, which only chooses what the
       * NEXT local `send` asks for and never leaves this handle.
       *
       * Restarting the runtime is how the change takes effect, so an in-flight
       * turn ends. `applied_live` reports whether a running session took it now
       * or whether it applies at next start.
       */
      changeModel: async (model: string) => {
        const result = await W.setWorkspaceSessionModel(workspaceId, sessionId, model);
        _persistedPromptDefaults = null;
        return result;
      },
      /** Read the authoritative secret allowlist and connections. */
      scope: () => W.getWorkspaceSessionScope(workspaceId, sessionId),
      /** Re-scope a running session — set semantics; see setWorkspaceSessionScope. */
      rescope: (scope: W.SessionScopeInput) =>
        W.setWorkspaceSessionScope(workspaceId, sessionId, scope),
      /** Pick the agent `send` will use for subsequent prompts (until changed). */
      setAgent: (agent: string | undefined) => {
        _agent = agent;
      },
      /**
       * Provision/resume if needed, then send a text prompt to the agent. A
       * per-call `{ model, agent }` overrides the sticky setModel/setAgent
       * choices for this message only.
       */
      send: async (text: string, opts?: { model?: SessionModel; agent?: string }) => {
        const { opencodeSessionId, runtimeUrl } = await ensureReady();
        const selectedModel = opts?.model ?? _model;
        const selectedAgent = opts?.agent ?? _agent;
        const persisted = selectedModel && selectedAgent ? {} : await persistedPromptDefaults();
        const model = selectedModel ?? persisted.model;
        const agent = selectedAgent ?? persisted.agent;
        return getClientForUrl(runtimeUrl).session.prompt({
          sessionID: opencodeSessionId,
          parts: [{ type: 'text', text }],
          ...(model ? { model } : {}),
          ...(agent ? { agent } : {}),
        });
      },
      /** Abort the agent's current run in this session. */
      abort: async () => {
        const { opencodeSessionId, runtimeUrl } = await ensureReady();
        return getClientForUrl(runtimeUrl).session.abort({
          sessionID: opencodeSessionId,
        });
      },
      /**
       * Stage a reversible rollback at one user message on this same canonical
       * OpenCode session. The next prompt commits the new path.
       */
      rewind: async (messageId: string) => {
        const { opencodeSessionId, runtimeUrl } = await ensureReady();
        return getClientForUrl(runtimeUrl).session.revert({
          sessionID: opencodeSessionId,
          messageID: messageId,
        });
      },
      /** Restore the path removed by `rewind()` before another prompt commits it. */
      restoreRewind: async () => {
        const { opencodeSessionId, runtimeUrl } = await ensureReady();
        return getClientForUrl(runtimeUrl).session.unrevert({
          sessionID: opencodeSessionId,
        });
      },
      /**
       * Live SSE stream of THIS session's runtime events (message/part
       * updates, session status, permissions/questions, lsp diagnostics, …).
       * A thin facade over the framework-free `openEventStream` primitive
       * (`@kortix/sdk`'s `openEventStream`, also used verbatim by
       * `@kortix/sdk/react`'s `useOpenCodeEventStream`): resolves THIS
       * handle's own runtime first (`ensureReady()`), then connects a client
       * bound to that runtime URL — never the module-global "active" one, so
       * two session handles on two different sandboxes never cross wires.
       * Framework-free — safe to call from a server-side "Kortix as a
       * Backend" wrapper (Node/Bun), a worker, a CLI, or any non-React host.
       *
       * Handles connect/reconnect/backoff, a 15s heartbeat watchdog, and
       * event coalescing internally. Call `handle.close()` to stop.
       *
       *   const handle = await session.stream({ onEvent: (e) => console.log(e) });
       *   // later
       *   handle.close();
       */
      stream: async (opts: {
        onEvent: (event: OpenCodeEvent) => void;
        onGapRehydrate?: (gapMs: number) => void;
        signal?: AbortSignal;
      }): Promise<EventStreamHandle> => {
        const { runtimeUrl } = await ensureReady();
        return openEventStream({
          client: getClientForUrl(runtimeUrl),
          onEvent: opts.onEvent,
          onGapRehydrate: opts.onGapRehydrate,
          signal: opts.signal,
        });
      },

      // ── runtime (opencode v2, THIS session's own sandbox) ────────────────
      // The typed opencode client, reached ONLY through the SDK. The host never
      // imports `@opencode-ai/sdk`. Opinionated wrappers (prompt/abort/setModel
      // with server-owned side-effects) layer on top of this as they land.
      get runtime(): OpencodeClient {
        return getClientForUrl(requireReady('runtime').runtimeUrl);
      },

      /**
       * Workspace file operations (daemon `/file` + `/find`) bound to THIS
       * session's own resolved runtime — never the module-global "active"
       * sandbox the top-level `@kortix/sdk` `files` export follows. Fixes a
       * cross-session bleed: a host juggling multiple open sessions (e.g. a
       * server wrapping several concurrent agent sessions) that called the
       * global `files.list()` while a DIFFERENT session was "active" would
       * silently read/write the wrong sandbox. Each call here auto-provisions
       * via `ensureReady()` (same as `send`/`abort`/`stream`), then runs
       * against this handle's own runtime URL. Same 12-op surface as the
       * global `files` namespace, built from the same parameterized core
       * (`@kortix/sdk/files`'s exports all take an optional trailing
       * `baseUrl` — this just always supplies THIS session's).
       */
      files: {
        list: async (dirPath: string) => F.listFiles(dirPath, (await ensureReady()).runtimeUrl),
        read: async (filePath: string) => F.readFile(filePath, (await ensureReady()).runtimeUrl),
        readBlob: async (filePath: string) =>
          F.readBlob(filePath, (await ensureReady()).runtimeUrl),
        status: async () => F.getFileStatus((await ensureReady()).runtimeUrl),
        findFiles: async (
          query: string,
          options?: { type?: 'file' | 'directory'; limit?: number },
        ) => F.findFiles(query, options, (await ensureReady()).runtimeUrl),
        findText: async (pattern: string) => F.findText(pattern, (await ensureReady()).runtimeUrl),
        upload: async (file: File | Blob, targetPath?: string, filename?: string) =>
          F.uploadFile(file, targetPath, filename, (await ensureReady()).runtimeUrl),
        create: async (filePath: string) =>
          F.createFile(filePath, (await ensureReady()).runtimeUrl),
        copy: async (sourcePath: string, destPath: string) =>
          F.copyFile(sourcePath, destPath, (await ensureReady()).runtimeUrl),
        remove: async (filePath: string) =>
          F.deleteFile(filePath, (await ensureReady()).runtimeUrl),
        mkdir: async (dirPath: string) => F.mkdir(dirPath, (await ensureReady()).runtimeUrl),
        rename: async (from: string, to: string) =>
          F.renameFile(from, to, (await ensureReady()).runtimeUrl),
      },
    };
  }

  return {
    /** The platform config in effect (for diagnostics). */
    config,
    accounts,
    /** Account-invite lifecycle reached by invite token alone (accept/decline/describe). */
    accountInvites,
    projects,
    workspaces,
    /** Connector calls scoped by an agent/session token when no project id is available. */
    connectors: connectorDataPlane(),
    project,
    workspace,
    session: workspaceSession,
    /** GitHub App installation + repository linking (account-scoped). */
    github,
    /** Billing read surface, including unified session costs. */
    billing,
    /** Public share links for a sandbox port (`/v1/p/share`, sandbox-scoped). */
    sandboxShares,
    /** Speech-to-text transcription (`/transcription` — not project-scoped). */
    transcribe: W.transcribeAudio,
    /** Deployment-wide Pipedream/easy-connect availability flag (not project-scoped). */
    connectStatus,
    /** Public marketplace catalog browse + sources (`/v1/marketplace/*`, not project-scoped). */
    marketplace,
    /** The pasted-API-key UX check — `GET /accounts/me`, never throws. */
    validateToken: W.validateToken,
    /** Escape hatch: the typed opencode client for the active sandbox. */
    runtime,
  };
}

export type Kortix = ReturnType<typeof createKortix>;
/** The id-bound project handle returned by `kortix.project(id)`. */
export type ProjectHandle = ReturnType<Kortix['project']>;
/** The canonical id-bound Workspace handle returned by `kortix.workspace(id)`. */
export type WorkspaceHandle = ReturnType<Kortix['workspace']>;
/** The id-bound session handle returned by `kortix.session(pid, sid)`. */
export type SessionHandle = ReturnType<Kortix['session']>;

// ── tiny tuple helpers: bind the leading id arg(s) without re-typing the rest ──
type DropFirst<T extends unknown[]> = T extends [unknown, ...infer R] ? R : [];
type DropFirst2<T extends unknown[]> = T extends [unknown, unknown, ...infer R] ? R : [];
