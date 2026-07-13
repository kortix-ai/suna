import { AcpClient, createAcpClient, type AcpStreamHandle } from '../../acp';
/**
 * createKortix — the single opinionated entry point to the Kortix data layer.
 *
 * One client. Every action a method. The host app imports ONLY from `@kortix/sdk`
 * — never native harness SDKs, never `backendApi`/`authenticatedFetch` directly.
 *
 *   const kortix = createKortix({ getToken });
 *   await kortix.projects.list();
 *   await kortix.project(pid).secrets.upsert({ name, value });
 *   const s = kortix.session(pid, sid);
 *   await s.start();
 *   await s.send('do the task');   // ACP-first conversation, via the SDK
 *
 * REST methods are direct references to the platform client, so they keep their
 * exact types with zero re-typing. The `project()`/`session()` handles bind ids
 * for ergonomics. Reactive data still comes from `@kortix/sdk/react` hooks.
 */
import * as F from '../files/client';
import { ApiError } from '../http/api/errors';
import { type KortixPlatformConfig, configureKortix, platformConfig } from '../http/config';
import * as P from '../rest/projects-client';
import { getSessionHealth } from '../session/health';
import { type SubdomainUrlOptions, proxyLocalhostUrl, rewriteLocalhostUrl } from '../session/url';
import { setCurrentRuntime } from '../session/current-runtime';
import {
  clearSessionRuntime,
  getSessionRuntime,
  type SessionRuntimeEntry,
} from '../session/session-runtime-registry';
import { getSandboxUrlForExternalId } from '../session/server-store/url-helpers';

/** A model override retained for API compatibility; ACP harness config owns selection. */
export type SessionModel = { providerID: string; modelID: string };

/**
 * Thrown by a session handle's runtime-scoped operations (`.runtime`,
 * `.health()`, `.previewUrl()`, `.proxyUrl()`) when called before the handle
 * has resolved its own sandbox runtime. These never fall back to whatever
 * sandbox happens to be globally active (a different session's runtime) —
 * the caller must resolve THIS handle's runtime first.
 */
/**
 * Dedupes concurrent `ensureReady()` calls that would otherwise both drive a
 * `/start` long-poll for the SAME (projectId, sessionId) — e.g. two session
 * handles for the same session (or the facade racing the React `useSession`
 * hook) both calling `ensureReady()`/`start()` before either has resolved a
 * runtime. Keyed by `${projectId}\n${sessionId}` (not the process-global
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
    list: P.listAccounts,
    get: P.getAccount,
    create: P.createAccount,
    updateName: P.updateAccountName,
    leave: P.leaveAccount,
    members: P.listAccountMembers,
    invite: P.inviteAccountMember,
    removeMember: P.removeAccountMember,
    updateMemberRole: P.updateAccountMemberRole,
    invites: P.listAccountInvites,
    /** Cancel a pending account invite (accountId still known/scoped). */
    cancelInvite: P.cancelAccountInvite,
    /** Resend a pending account invite (accountId still known/scoped). */
    resendInvite: P.resendAccountInvite,
    /** CLI PAT minting — account-scoped personal access tokens (`kortix_pat_...`). */
    tokens: {
      list: P.listAccountTokens,
      create: P.createAccountToken,
      revoke: P.revokeAccountToken,
    },
    /** Enterprise audit log — events + CSV/JSONL export + SIEM webhooks. */
    audit: {
      log: P.listAccountAudit,
      export: P.exportAccountAudit,
      webhooks: {
        list: P.listAccountAuditWebhooks,
        create: P.createAccountAuditWebhook,
        update: P.updateAccountAuditWebhook,
        remove: P.removeAccountAuditWebhook,
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
    accountState: P.getAccountState,
    accountStateMinimal: P.getAccountStateMinimal,
    transactions: P.listBillingTransactions,
    transactionsSummary: P.getBillingTransactionsSummary,
    creditBreakdown: P.getBillingCreditBreakdown,
    usageHistory: P.getBillingUsageHistory,
    tierConfigurations: P.getBillingTierConfigurations,

    /** Stripe checkout — start a subscription and confirm it post-redirect. */
    checkout: {
      createSession: (input: Parameters<typeof P.createCheckoutSession>[0]) =>
        P.createCheckoutSession(input),
      confirmSession: (sessionId: string, accountId?: string) =>
        P.confirmCheckoutSession(sessionId, accountId),
    },

    /** Manage an existing subscription (portal, cancel/reactivate, downgrade). */
    subscription: {
      createPortalSession: (returnUrl: string, accountId?: string) =>
        P.createPortalSession(returnUrl, accountId),
      cancel: (feedback?: string, accountId?: string) => P.cancelSubscription(feedback, accountId),
      reactivate: (accountId?: string) => P.reactivateSubscription(accountId),
      scheduleDowngrade: (targetTierKey: string, commitmentType?: string, accountId?: string) =>
        P.scheduleDowngrade(targetTierKey, commitmentType, accountId),
      cancelScheduledChange: (accountId?: string) => P.cancelScheduledChange(accountId),
      prorationPreview: (newPriceId: string, accountId?: string) =>
        P.getProrationPreview(newPriceId, accountId),
    },

    /** One-off credit purchases + recurring auto-topup configuration. */
    credits: {
      purchase: (input: Parameters<typeof P.purchaseCredits>[0]) => P.purchaseCredits(input),
      autoTopupSettings: (accountId?: string) => P.getAutoTopupSettings(accountId),
      configureAutoTopup: (input: Parameters<typeof P.configureAutoTopup>[0]) =>
        P.configureAutoTopup(input),
    },
  };

  /**
   * Account-invite lifecycle reached by invite token alone — accept/decline/
   * describe are called by the invitee (who may not be an account member, or
   * even signed into this account, yet), so they take only `inviteId` and
   * genuinely don't fit account- or project-scoping.
   */
  const accountInvites = {
    describe: P.describeAccountInvite,
    accept: P.acceptAccountInvite,
    decline: P.declineAccountInvite,
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

  /** GitHub App installation + repository linking — account-scoped, not project-scoped. */
  const github = {
    linkRepository: P.linkRepository,
    getInstallation: P.getGitHubInstallation,
    listInstallations: P.listGitHubInstallations,
    listRepositories: P.listGitHubRepositories,
    listRepositoryBranches: P.listGitHubRepositoryBranches,
    saveInstallation: P.saveGitHubInstallation,
    deleteInstallation: P.deleteGitHubInstallation,
  };

  /** Public share links for a sandbox port (`/v1/p/share`) — sandbox-scoped, not project-scoped. */
  const sandboxShares = {
    list: P.listSandboxShares,
    create: P.createSandboxShare,
    revoke: P.revokeSandboxShare,
  };

  /** Deployment-wide flag: is the easy-connect (Pipedream) provider configured? Not project-scoped. */
  const connectStatus = P.getConnectStatus;

  /**
   * Public marketplace catalog browse (`/v1/marketplace/*`) — top-level and
   * distinct from `project(id).marketplace`, which is install-scoped (commits
   * an item onto a specific project's branch). This is read-only browsing +
   * the authed "add a marketplace source" surface.
   */
  const marketplace = {
    items: (options?: Parameters<typeof P.listMarketplaceCatalogItems>[0]) =>
      P.listMarketplaceCatalogItems(options),
    item: (id: string) => P.getMarketplaceCatalogItem(id),
    itemFile: (id: string, path: string) => P.getMarketplaceCatalogItemFile(id, path),
    marketplaces: () => P.listMarketplaces(),
    featured: () => P.listFeaturedMarketplaces(),
    sources: {
      list: () => P.listMarketplaceSources(),
      add: (input: Parameters<typeof P.addMarketplaceSource>[0]) => P.addMarketplaceSource(input),
      remove: (id: string) => P.removeMarketplaceSource(id),
    },
  };

  /** Id-bound handle for a single project: every sub-resource, projectId pre-applied. */
  function project(projectId: string) {
    return {
      get: (opts?: Parameters<typeof P.getProject>[1]) => P.getProject(projectId, opts),
      detail: () => P.getProjectDetail(projectId),
      update: (input: Parameters<typeof P.updateProject>[1]) => P.updateProject(projectId, input),
      archive: () => P.archiveProject(projectId),
      llmCatalog: () => P.getProjectLlmCatalog(projectId),
      modelPicker: () => P.getProjectModelPicker(projectId),
      /** Declared logical agents resolved through the project's single runtime compiler. */
      agents: async () => (await P.getProjectDetail(projectId)).config.agents,
      /** Harness authentication connections, including explicit active bindings. */
      harnessConnections: () => P.listHarnessConnections(projectId),
      /** Server-authoritative session preflight for one logical agent. */
      composerCapabilities: (
        agentName: string,
        connectionId?: Parameters<typeof P.getComposerCapabilities>[2],
      ) => P.getComposerCapabilities(projectId, agentName, connectionId),
      /** Harness-qualified authoritative model catalog. */
      modelCatalog: (input: Parameters<typeof P.getComposerModelCatalog>[1]) =>
        P.getComposerModelCatalog(projectId, input),
      /** Select or clear the explicit auth route for a harness. */
      setHarnessConnection: (...a: DropFirst<Parameters<typeof P.setActiveHarnessConnection>>) =>
        P.setActiveHarnessConnection(projectId, ...a),
      /** Canonical session create entrypoint (alias of sessions.create). */
      createSession: (input?: Parameters<typeof P.createProjectSession>[1]) =>
        P.createProjectSession(projectId, input),
      sandboxHealth: () => P.getProjectSandboxHealth(projectId),
      onboardingComplete: (...a: DropFirst<Parameters<typeof P.setProjectOnboardingComplete>>) =>
        P.setProjectOnboardingComplete(projectId, ...a),

      /** Project-scoped CLI PATs (auto-minted at session-create as `KORTIX_TOKEN`; can also be minted by hand). */
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

      /** Marketplace install/updates — commits an item's files (+ lock) straight onto the default branch. */
      marketplace: {
        list: () => P.listInstalledMarketplaceItems(projectId),
        install: (id: string) => P.installMarketplaceItem(projectId, id),
        updates: () => P.getMarketplaceUpdates(projectId),
        update: (name: string) => P.updateMarketplaceItem(projectId, name),
        updateAll: () => P.updateAllMarketplaceItems(projectId),
        remove: (name: string) => P.removeMarketplaceItem(projectId, name),
      },

      /** `registry.*` — compatibility alias of `marketplace.*` (identical server-side handlers). */
      registry: {
        list: () => P.listInstalledRegistryItems(projectId),
        install: (id: string) => P.installRegistryItem(projectId, id),
        updates: () => P.getRegistryUpdates(projectId),
        update: (name: string) => P.updateRegistryItem(projectId, name),
        updateAll: () => P.updateAllRegistryItems(projectId),
        remove: (name: string) => P.removeRegistryItem(projectId, name),
      },

      secrets: {
        list: () => P.listProjectSecrets(projectId),
        upsert: (input: Parameters<typeof P.upsertProjectSecret>[1]) =>
          P.upsertProjectSecret(projectId, input),
        remove: (name: string) => P.deleteProjectSecret(projectId, name),
        setPersonal: (...a: DropFirst<Parameters<typeof P.setPersonalProjectSecret>>) =>
          P.setPersonalProjectSecret(projectId, ...a),
        removePersonal: (name: string) => P.deletePersonalProjectSecret(projectId, name),
        setGitCredential: (input: Parameters<typeof P.upsertProjectGitCredential>[1]) =>
          P.upsertProjectGitCredential(projectId, input),
        /** Device-code OAuth flow to connect a subscription-backed provider (e.g. ChatGPT). */
        startProviderOAuth: (...a: DropFirst<Parameters<typeof P.startProjectProviderOAuth>>) =>
          P.startProjectProviderOAuth(projectId, ...a),
        pollProviderOAuth: (...a: DropFirst<Parameters<typeof P.pollProjectProviderOAuth>>) =>
          P.pollProjectProviderOAuth(projectId, ...a),
      },

      access: {
        list: () => P.listProjectAccess(projectId),
        invite: (...a: DropFirst<Parameters<typeof P.inviteProjectMember>>) =>
          P.inviteProjectMember(projectId, ...a),
        update: (...a: DropFirst<Parameters<typeof P.updateProjectAccess>>) =>
          P.updateProjectAccess(projectId, ...a),
        revoke: (userId: string) => P.revokeProjectAccess(projectId, userId),
        pendingInvites: () => P.listPendingProjectInvites(projectId),
        resendInvite: (...a: DropFirst<Parameters<typeof P.resendPendingProjectInvite>>) =>
          P.resendPendingProjectInvite(projectId, ...a),
        revokeInvite: (...a: DropFirst<Parameters<typeof P.revokePendingProjectInvite>>) =>
          P.revokePendingProjectInvite(projectId, ...a),
        requests: () => P.listProjectAccessRequests(projectId),
        approveRequest: (...a: DropFirst<Parameters<typeof P.approveProjectAccessRequest>>) =>
          P.approveProjectAccessRequest(projectId, ...a),
        rejectRequest: (...a: DropFirst<Parameters<typeof P.rejectProjectAccessRequest>>) =>
          P.rejectProjectAccessRequest(projectId, ...a),
        groupGrants: () => P.listProjectGroupGrants(projectId),
        attachGroupGrant: (...a: DropFirst<Parameters<typeof P.attachGroupToProject>>) =>
          P.attachGroupToProject(projectId, ...a),
        updateGroupGrant: (...a: DropFirst<Parameters<typeof P.updateProjectGroupGrant>>) =>
          P.updateProjectGroupGrant(projectId, ...a),
        detachGroupGrant: (groupId: string) => P.detachGroupFromProject(projectId, groupId),
        /** Per-resource (agent/skill/secret) grants to a member or a group. */
        resourceGrants: {
          list: () => P.listProjectResourceGrants(projectId),
          create: (input: Parameters<typeof P.createProjectResourceGrant>[1]) =>
            P.createProjectResourceGrant(projectId, input),
          remove: (grantId: string) => P.deleteProjectResourceGrant(projectId, grantId),
        },
      },

      connectors: {
        list: () => P.listConnectors(projectId),
        config: (...a: DropFirst<Parameters<typeof P.getConnectorConfig>>) =>
          P.getConnectorConfig(projectId, ...a),
        create: (...a: DropFirst<Parameters<typeof P.createConnector>>) =>
          P.createConnector(projectId, ...a),
        remove: (...a: DropFirst<Parameters<typeof P.deleteConnector>>) =>
          P.deleteConnector(projectId, ...a),
        sync: () => P.syncConnectors(projectId),
        setName: (...a: DropFirst<Parameters<typeof P.setConnectorName>>) =>
          P.setConnectorName(projectId, ...a),
        setCredentialMode: (...a: DropFirst<Parameters<typeof P.setConnectorCredentialMode>>) =>
          P.setConnectorCredentialMode(projectId, ...a),
        setCredential: (...a: DropFirst<Parameters<typeof P.setConnectorCredential>>) =>
          P.setConnectorCredential(projectId, ...a),
        setSensitive: (...a: DropFirst<Parameters<typeof P.setConnectorSensitive>>) =>
          P.setConnectorSensitive(projectId, ...a),
        profiles: {
          list: () => P.listConnectionProfiles(projectId),
          reconcile: (...a: DropFirst<Parameters<typeof P.reconcileConnectionProfile>>) =>
            P.reconcileConnectionProfile(projectId, ...a),
          updateCredential: (
            ...a: DropFirst<Parameters<typeof P.updateConnectionProfileCredential>>
          ) => P.updateConnectionProfileCredential(projectId, ...a),
          revoke: (...a: DropFirst<Parameters<typeof P.revokeConnectionProfile>>) =>
            P.revokeConnectionProfile(projectId, ...a),
          activate: (...a: DropFirst<Parameters<typeof P.activateConnectionProfile>>) =>
            P.activateConnectionProfile(projectId, ...a),
        },
        policies: {
          get: (...a: DropFirst<Parameters<typeof P.getConnectorPolicies>>) =>
            P.getConnectorPolicies(projectId, ...a),
          set: (...a: DropFirst<Parameters<typeof P.setConnectorPolicies>>) =>
            P.setConnectorPolicies(projectId, ...a),
        },
        /** Easy-connect (Pipedream): app catalog + connect/finalize handshake. */
        pipedream: {
          listApps: (...a: DropFirst<Parameters<typeof P.listPipedreamApps>>) =>
            P.listPipedreamApps(projectId, ...a),
          connect: (...a: DropFirst<Parameters<typeof P.pipedreamConnect>>) =>
            P.pipedreamConnect(projectId, ...a),
          finalize: (...a: DropFirst<Parameters<typeof P.pipedreamFinalize>>) =>
            P.pipedreamFinalize(projectId, ...a),
        },
      },

      policies: {
        list: () => P.listProjectPolicies(projectId),
        set: (...a: DropFirst<Parameters<typeof P.setProjectPolicies>>) =>
          P.setProjectPolicies(projectId, ...a),
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

      files: {
        list: (options?: Parameters<typeof P.listProjectFiles>[1]) =>
          P.listProjectFiles(projectId, options),
        read: (path: string, ref?: string) => P.readProjectFile(projectId, path, ref),
        search: (...a: DropFirst<Parameters<typeof P.searchProjectFiles>>) =>
          P.searchProjectFiles(projectId, ...a),
        archive: (...a: DropFirst<Parameters<typeof P.fetchProjectArchive>>) =>
          P.fetchProjectArchive(projectId, ...a),
        history: (...a: DropFirst<Parameters<typeof P.getProjectFileHistory>>) =>
          P.getProjectFileHistory(projectId, ...a),
      },

      git: {
        commits: () => P.listProjectCommits(projectId),
        commit: (sha: string) => P.getProjectCommit(projectId, sha),
        commitDiff: (sha: string) => P.getProjectCommitDiff(projectId, sha),
        branches: () => P.listProjectBranches(projectId),
        versionDiff: (...a: DropFirst<Parameters<typeof P.getVersionDiff>>) =>
          P.getVersionDiff(projectId, ...a),
        /** Invite a GitHub user as a collaborator on a Kortix-managed repo. */
        inviteCollaborator: (...a: DropFirst<Parameters<typeof P.inviteRepoCollaborator>>) =>
          P.inviteRepoCollaborator(projectId, ...a),
      },

      changeRequests: {
        list: () => P.listChangeRequests(projectId),
        get: (crId: string) => P.getChangeRequest(projectId, crId),
        diff: (crId: string) => P.getChangeRequestDiff(projectId, crId),
        mergePreview: (crId: string) => P.getChangeRequestMergePreview(projectId, crId),
        open: (...a: DropFirst<Parameters<typeof P.openChangeRequest>>) =>
          P.openChangeRequest(projectId, ...a),
        merge: (...a: DropFirst<Parameters<typeof P.mergeChangeRequest>>) =>
          P.mergeChangeRequest(projectId, ...a),
        close: (...a: DropFirst<Parameters<typeof P.closeChangeRequest>>) =>
          P.closeChangeRequest(projectId, ...a),
        reopen: (...a: DropFirst<Parameters<typeof P.reopenChangeRequest>>) =>
          P.reopenChangeRequest(projectId, ...a),
        /** Request changes on a CR (Review Center) — records feedback + optionally delivers it back to the originating session. */
        requestChanges: (...a: DropFirst<Parameters<typeof P.requestChangesOnChangeRequest>>) =>
          P.requestChangesOnChangeRequest(projectId, ...a),
      },

      sessions: {
        list: () => P.listProjectSessions(projectId),
        create: (input?: Parameters<typeof P.createProjectSession>[1]) =>
          P.createProjectSession(projectId, input),
      },

      /** Review Center — the per-project human-in-the-loop inbox (change requests, tool approvals, agent outputs/decisions). */
      review: {
        list: (params?: Parameters<typeof P.listReviewItems>[1]) =>
          P.listReviewItems(projectId, params),
        get: (reviewItemId: string) => P.getReviewItem(projectId, reviewItemId),
        submit: (input: Parameters<typeof P.submitReviewItem>[1]) =>
          P.submitReviewItem(projectId, input),
        act: (...a: DropFirst<Parameters<typeof P.actReviewItem>>) =>
          P.actReviewItem(projectId, ...a),
        bulkAct: (input: Parameters<typeof P.bulkActReviewItems>[1]) =>
          P.bulkActReviewItems(projectId, input),
      },

      /** The manager inbox of executor-gated actions awaiting approve/deny (APPROVE / ASK / BLOCK). */
      approvals: {
        list: (options?: Parameters<typeof P.listPendingApprovals>[1]) =>
          P.listPendingApprovals(projectId, options),
        resolve: (...a: DropFirst<Parameters<typeof P.resolveApproval>>) =>
          P.resolveApproval(projectId, ...a),
        sessionsNeedingInput: (options?: Parameters<typeof P.listSessionsNeedingInput>[1]) =>
          P.listSessionsNeedingInput(projectId, options),
      },

      /** Gateway observability — LLM request logs, cost/latency rollups, budgets, gateway API keys. */
      gateway: {
        logs: (opts?: Parameters<typeof P.listGatewayLogs>[1]) =>
          P.listGatewayLogs(projectId, opts),
        log: (logId: string) => P.getGatewayLog(projectId, logId),
        overview: (days?: number) => P.getGatewayOverview(projectId, days),
        series: (days?: number) => P.getGatewaySeries(projectId, days),
        breakdown: (days?: number) => P.getGatewayBreakdown(projectId, days),
        sessions: (days?: number) => P.getGatewaySessions(projectId, days),
        errors: (days?: number) => P.getGatewayErrors(projectId, days),
        budgets: () => P.getGatewayBudgets(projectId),
        setBudget: (input: Parameters<typeof P.setGatewayBudget>[1]) =>
          P.setGatewayBudget(projectId, input),
        deleteBudget: (budgetId: string) => P.deleteGatewayBudget(projectId, budgetId),
        keys: () => P.getGatewayKeys(projectId),
        createKey: (name: string) => P.createGatewayKey(projectId, name),
        revokeKey: (keyId: string) => P.revokeGatewayKey(projectId, keyId),
        routing: {
          get: () => P.getGatewayRoutingPolicy(projectId),
          set: (policy: Parameters<typeof P.setGatewayRoutingPolicy>[1]) =>
            P.setGatewayRoutingPolicy(projectId, policy),
          reset: () => P.resetGatewayRoutingPolicy(projectId),
          preview: (input: Parameters<typeof P.previewGatewayRoute>[1]) =>
            P.previewGatewayRoute(projectId, input),
        },
        /** Run one prompt against up to 6 models side by side (a model-comparison playground). */
        playground: (prompt: string, models: string[]) =>
          P.runGatewayPlayground(projectId, prompt, models),
      },

      /** Slack + email + Meet channel integrations. */
      channels: {
        slack: {
          installation: () => P.getSlackInstallation(projectId),
          connect: (input: Parameters<typeof P.connectSlack>[1]) =>
            P.connectSlack(projectId, input),
          mode: () => P.getSlackMode(projectId),
          manifest: () => P.getSlackManifest(projectId),
          disconnect: () => P.disconnectSlack(projectId),
          /** Download a Slack-hosted file through the server-side proxy (bot token stays server-side). */
          getFile: (url: string) => P.getSlackChannelFile(projectId, url),
          /** Upload a file to Slack through the server-side 3-step external-upload proxy. */
          uploadFile: (input: Parameters<typeof P.uploadSlackChannelFile>[1]) =>
            P.uploadSlackChannelFile(projectId, input),
        },
        email: {
          installation: (connectorSlug?: string | null) =>
            P.getEmailInstallation(projectId, connectorSlug),
          mode: () => P.getEmailMode(projectId),
          connect: (input: Parameters<typeof P.connectEmail>[1]) =>
            P.connectEmail(projectId, input),
          disconnect: (connectorSlug?: string | null) =>
            P.disconnectEmail(projectId, connectorSlug),
          updatePolicy: (...a: DropFirst<Parameters<typeof P.updateEmailPolicy>>) =>
            P.updateEmailPolicy(projectId, ...a),
        },
        meet: {
          voices: () => P.getMeetVoices(projectId),
          setVoice: (voice: string) => P.setMeetVoice(projectId, voice),
          setBotName: (name: string) => P.setMeetBotName(projectId, name),
          previewVoice: (voiceId: string) => P.previewMeetVoice(projectId, voiceId),
          /** Make the meeting bot speak text (text → ElevenLabs → Recall `output_audio`). */
          speak: (botId: string, text: string, voice?: string) =>
            P.speakInMeeting(projectId, botId, text, voice),
        },
      },

      /** Toggle an experimental feature (Customize → Settings → Experimental). Pass `enabled: null` to clear the override. */
      updateExperimentalFeature: (
        ...a: DropFirst<Parameters<typeof P.updateExperimentalFeature>>
      ) => P.updateExperimentalFeature(projectId, ...a),

      /** Default model preferences (account/agent/project scope, gateway-resolved). */
      modelDefaults: {
        get: () => P.getModelDefaults(projectId),
        set: (input: Parameters<typeof P.setModelDefault>[1]) =>
          P.setModelDefault(projectId, input),
        clear: (params: Parameters<typeof P.clearModelDefault>[1]) =>
          P.clearModelDefault(projectId, params),
      },

      /** Set the agent used when a new project session does not name one explicitly. */
      setDefaultAgent: (agentName: string) => P.updateProjectDefaultAgent(projectId, agentName),

      /** Sandbox templates + snapshot builds — Dockerfile/image/warm-pool config, beyond `sandboxHealth`/`sandboxTemplates`. */
      sandbox: {
        list: () => P.listProjectSandboxes(projectId),
        snapshots: () => P.listProjectSnapshots(projectId),
        rebuildSnapshot: (slug?: string) => P.rebuildProjectSnapshot(projectId, slug),
        fixWithAgent: () => P.fixSandboxWithAgent(projectId),
        createTemplate: (input: Parameters<typeof P.createSandboxTemplate>[1]) =>
          P.createSandboxTemplate(projectId, input),
        updateTemplate: (...a: DropFirst<Parameters<typeof P.updateSandboxTemplate>>) =>
          P.updateSandboxTemplate(projectId, ...a),
        removeTemplate: (templateId: string) => P.deleteSandboxTemplate(projectId, templateId),
        buildTemplate: (templateId: string) => P.buildSandboxTemplate(projectId, templateId),
        /** Pin/clear the per-project sandbox provider (null = follow the platform default). */
        setProvider: (provider: Parameters<typeof P.updateProjectSandboxProvider>[1]) =>
          P.updateProjectSandboxProvider(projectId, provider),
      },

      /** Bind specific secrets + connectors to an agent (the inheritance pyramid's declaration step). */
      setAgentScope: (...a: DropFirst<Parameters<typeof P.setAgentScope>>) =>
        P.setAgentScope(projectId, ...a),

      session: (sessionId: string) => session(projectId, sessionId),
    };
  }

  /** Id-bound handle for a single session: lifecycle (REST) + runtime protocol client. */
  function session(projectId: string, sessionId: string) {
    // Opinionated-action state, scoped to THIS handle. The runtime is
    // keyed by the Runtime session id (resolved server-side at /start), NOT the
    // Kortix `sessionId` — they differ. We resolve+cache it once (including the
    // resolved runtime URL + sandbox id), and remember a chosen model so `send`
    // carries it. Every runtime-scoped operation below reads ONLY this cached
    // record — never the module-global "currently active" runtime — so two
    // session handles pointed at two different sandboxes never cross wires.
    let _ready: SessionRuntimeEntry | null = null;
    let _acpClient: AcpClient | null = null;
    let _acpSessionId: string | null = null;

    /**
     * Adopt an already-resolved runtime for THIS (projectId, sessionId) from
     * the shared session-runtime registry, if this handle hasn't resolved one
     * itself yet. This is what lets a brand-new `kortix.session(pid, sid)`
     * handle — e.g. a one-off poll tick, or a handle created independently of
     * the one that actually drove `/start` — use a session another handle (or
     * the React `useSession` hook) already brought up, instead of throwing
     * `SessionNotReadyError` or re-provisioning.
     */
    function tryResolveReady(): SessionRuntimeEntry | null {
      if (_ready) return _ready;
      const cached = getSessionRuntime(projectId, sessionId);
      if (cached) _ready = cached;
      return _ready;
    }

    /**
     * Make this session's runtime reachable and return its Runtime session id
     * (plus this handle's own resolved runtime URL + sandbox id). Idempotent:
     * adopts the registry entry if another handle already resolved this
     * session; otherwise `start` provisions/resumes the sandbox (long-poll
     * until ready) — which itself populates the registry on success — and we
     * cache the resolved runtime for THIS handle. Also points the app's shared
     * "current runtime" store there, for React hosts that still read it.
     */
    async function ensureReady(): Promise<SessionRuntimeEntry> {
      const cached = tryResolveReady();
      if (cached) return cached;

      // Dedup concurrent starts for this (projectId, sessionId) — see
      // `inFlightSessionStarts`'s doc comment. If another call (this handle or
      // a different one) already kicked off `/start`, ride its result instead
      // of issuing a second POST.
      const key = `${projectId}\n${sessionId}`;
      const inFlight = inFlightSessionStarts.get(key);
      if (inFlight) {
        _ready = await inFlight;
        return _ready;
      }

      const startPromise = (async (): Promise<SessionRuntimeEntry> => {
        const started = await P.startProjectSession(projectId, sessionId, 30_000);
        const runtimeProtocol = started?.runtime_protocol ?? null;
        const runtimeSessionId = started?.runtime_session_id ?? null;
        const runtimeId = started?.runtime_id ?? runtimeSessionId;
        if (!started || started.stage !== 'ready' || !started.sandbox || runtimeProtocol !== 'acp' || !runtimeId) {
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
          runtimeProtocol,
          runtimeId,
          runtimeSessionId,
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
      _acpClient = null;
      _acpSessionId = null;
      clearSessionRuntime(projectId, sessionId);
    }

    async function ensureAcpSession(): Promise<{
      client: AcpClient;
      acpSessionId: string;
      ready: SessionRuntimeEntry;
    }> {
      const ready = await ensureReady();
      if (ready.runtimeProtocol !== 'acp') {
        throw new ApiError('Session did not start an ACP runtime', {
          code: 'RUNTIME_PROTOCOL_MISMATCH',
        });
      }
      const client = _acpClient ?? createAcpClient({
        endpoint: `${config.backendUrl.replace(/\/$/, '')}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/acp`,
      });
      _acpClient = client;
      if (!_acpSessionId) {
        await client.initialize({
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: '@kortix/sdk', title: 'Kortix SDK', version: '0.2.0' },
        });
        if (ready.runtimeSessionId) {
          await client.loadSession({ sessionId: ready.runtimeSessionId, cwd: '/workspace', mcpServers: [] });
          _acpSessionId = ready.runtimeSessionId;
        } else {
          const created = await client.newSession({ cwd: '/workspace', mcpServers: [] });
          _acpSessionId = created.sessionId;
        }
        ready.runtimeSessionId = _acpSessionId;
      }
      return { client, acpSessionId: _acpSessionId, ready };
    }

    return {
      // ── lifecycle (Kortix REST) ──────────────────────────────────────────
      get: (opts?: { showErrors?: boolean }) => P.getProjectSession(projectId, sessionId, opts),
      update: (input: Parameters<typeof P.updateProjectSession>[2]) =>
        P.updateProjectSession(projectId, sessionId, input),
      delete: () => {
        // A deleted session's sandbox is gone — never let a later handle for
        // this (projectId, sessionId) resolve a runtime that no longer exists.
        forgetReady();
        return P.deleteProjectSession(projectId, sessionId);
      },
      start: (...a: DropFirst2<Parameters<typeof P.startProjectSession>>) =>
        P.startProjectSession(projectId, sessionId, ...a),
      restart: () => {
        // Restart preserves the established sandbox identity, but readiness
        // and the proxy connection must still be resolved again after reboot.
        forgetReady();
        return P.restartProjectSession(projectId, sessionId);
      },
      stop: () => {
        forgetReady();
        return P.stopProjectSession(projectId, sessionId);
      },
      setSharing: (intent: Parameters<typeof P.setProjectSessionSharing>[2]) =>
        P.setProjectSessionSharing(projectId, sessionId, intent),
      previews: () => P.getSessionPreviewCandidates(projectId, sessionId),
      commit: (input?: Parameters<typeof P.commitSessionChanges>[2]) =>
        P.commitSessionChanges(projectId, sessionId, input),
      publicShares: {
        list: () => P.listSessionPublicShares(projectId, sessionId),
        create: (...a: DropFirst2<Parameters<typeof P.createSessionPublicShare>>) =>
          P.createSessionPublicShare(projectId, sessionId, ...a),
        revoke: (...a: DropFirst2<Parameters<typeof P.revokeSessionPublicShare>>) =>
          P.revokeSessionPublicShare(projectId, sessionId, ...a),
      },
      /** Per-session audit trail of executor-gated agent actions. */
      audit: (limit?: number, options?: { showErrors?: boolean }) =>
        P.getSessionAudit(projectId, sessionId, limit, options),
      /** Compact server-side transcript read (text + tool calls, no tool inputs/outputs) — callable with project-scoped session tokens. */
      transcript: (options?: Parameters<typeof P.getSessionTranscript>[2]) =>
        P.getSessionTranscript(projectId, sessionId, options),

      /**
       * Resolve THIS handle's own runtime (idempotent): provisions/resumes the
       * sandbox (long-poll until ready) and caches the resolved Runtime session
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
      // the runtime is up, resolve the Runtime session id, and act through a
      // ACP is the sole client-to-agent contract. Harness-native model and
      // agent selection live in the selected runtime's own config directory.
      send: async (text: string) => {
        const { client, acpSessionId } = await ensureAcpSession();
        return client.prompt(acpSessionId, [{ type: 'text', text }]);
      },
      /** Abort the agent's current run in this session. */
      abort: async () => {
        const { client, acpSessionId } = await ensureAcpSession();
        return client.cancel(acpSessionId);
      },
      /**
       * Live SSE stream of THIS session's runtime events (message/part
       * updates, session status, permissions/questions, lsp diagnostics, …).
       * A thin facade over the framework-free `openEventStream` primitive
       * (`@kortix/sdk`'s `openEventStream`, also used verbatim by
       * `@kortix/sdk/react`'s ACP session stream): resolves THIS
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
        onEvent: Parameters<AcpClient['connect']>[0]['onEvent'];
        onError?: Parameters<AcpClient['connect']>[0]['onError'];
        signal?: AbortSignal;
        lastEventId?: number;
      }): Promise<AcpStreamHandle> => {
        const { client } = await ensureAcpSession();
        return client.connect(opts);
      },

      /** ACP-native runtime transport for v3 sessions. */
      acp: {
        connect: async (opts: {
          onEvent: Parameters<AcpClient['connect']>[0]['onEvent'];
          onError?: Parameters<AcpClient['connect']>[0]['onError'];
          signal?: AbortSignal;
          lastEventId?: number;
        }): Promise<AcpStreamHandle> => {
          const { client } = await ensureAcpSession();
          return client.connect(opts);
        },
        client: async () => (await ensureAcpSession()).client,
        sessionId: async () => (await ensureAcpSession()).acpSessionId,
        respond: async (...args: Parameters<AcpClient['respond']>) =>
          (await ensureAcpSession()).client.respond(...args),
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
    project,
    session,
    /** GitHub App installation + repository linking (account-scoped). */
    github,
    /** Billing read surface — credits/subscription/tier/transactions (not project-scoped). */
    billing,
    /** Public share links for a sandbox port (`/v1/p/share`, sandbox-scoped). */
    sandboxShares,
    /** Speech-to-text transcription (`/transcription` — not project-scoped). */
    transcribe: P.transcribeAudio,
    /** Deployment-wide Pipedream/easy-connect availability flag (not project-scoped). */
    connectStatus,
    /** Public marketplace catalog browse + sources (`/v1/marketplace/*`, not project-scoped). */
    marketplace,
    /** The pasted-API-key UX check — `GET /accounts/me`, never throws. */
    validateToken: P.validateToken,
  };
}

export type Kortix = ReturnType<typeof createKortix>;
/** The id-bound project handle returned by `kortix.project(id)`. */
export type ProjectHandle = ReturnType<Kortix['project']>;
/** The id-bound session handle returned by `kortix.session(pid, sid)`. */
export type SessionHandle = ReturnType<Kortix['session']>;

// ── tiny tuple helpers: bind the leading id arg(s) without re-typing the rest ──
type DropFirst<T extends unknown[]> = T extends [unknown, ...infer R] ? R : [];
type DropFirst2<T extends unknown[]> = T extends [unknown, unknown, ...infer R] ? R : [];
