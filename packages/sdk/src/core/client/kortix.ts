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
import { getClient, getClientForUrl, systemReload } from '../runtime/client';
import { setAdminBypass } from '../http/api-client';
import { ApiError } from '../http/api/errors';
import { type KortixPlatformConfig, configureKortix, platformConfig } from '../http/config';
import * as B from '../rest/platform-client';
import * as P from '../rest/projects-client';
import { getSessionHealth } from '../session/health';
import {
  type ConvertRuntimePresentationOptions,
  type FetchPresentationMetadataOptions,
  type RuntimePresentationFormat,
  type RuntimePresentationMetadata,
  convertRuntimePresentation,
  fetchPresentationMetadata,
} from '../session/presentation';
import { ensurePreviewSessionCookie } from '../session/preview-auth';
import { createTunnelEventStream } from '../stream/fetch-sse';
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

  /**
   * The API base URL in effect right now.
   *
   * Reads the LIVE platform config for the same reason
   * `resolvePreviewOptsForSandbox` does: a host may re-point the seam after
   * `createKortix()` and every URL the facade builds must follow it.
   */
  function backendUrlNow(): string {
    return platformConfig().backendUrl ?? config.backendUrl;
  }

  /**
   * Fill in `backendUrl` for a host-boundary call.
   *
   * The readers in `platform-client/host-boundary` take an EXPLICIT
   * `HostRequestOptions` because they use raw `fetch` (never `backendApi`) —
   * that is what lets an anonymous visitor, a server action with a
   * request-scoped token, or a download reach the API without the configured
   * client. The facade already knows the backend URL, so callers pass only what
   * varies (`accessToken`, `signal`, `cache`, `next`, `headers`), and an
   * explicit `backendUrl` still wins.
   *
   * No token is attached here: these routes are authorized by the token in the
   * path (a share/setup-link/invite token) or by nothing at all.
   */
  function hostOptions(options?: Partial<B.HostRequestOptions>): B.HostRequestOptions {
    return { ...options, backendUrl: options?.backendUrl ?? backendUrlNow() };
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
      /**
       * The same export as a downloadable Blob + its `Content-Disposition`
       * filename and the `x-audit-*` paging headers. Explicit-transport (raw
       * `fetch`) because `backendApi` only ever parses JSON — pass
       * `accessToken` when calling from a server action.
       */
      download: (
        accountId: string,
        query: Parameters<typeof B.downloadAccountAudit>[1],
        options?: Partial<B.HostRequestOptions>,
      ) => B.downloadAccountAudit(accountId, query, hostOptions(options)),
      webhooks: {
        list: P.listAccountAuditWebhooks,
        create: P.createAccountAuditWebhook,
        update: P.updateAccountAuditWebhook,
        remove: P.removeAccountAuditWebhook,
      },
    },
  };

  /**
   * Identity and access — the canonical RBAC surface.
   *
   * One vocabulary: a PRINCIPAL (user, group, service account, pending invitee)
   * holds a ROLE at a SCOPE (the account, or one project), optionally narrowed
   * to one OBJECT, as one ASSIGNMENT row. A role is a set of PERMISSIONS.
   *
   * `assignments` is the only grant store — it replaced the account-role column,
   * the project-role column, group grants, policies and resource grants. There is
   * no second way to grant anything, and `can`/`canBatch` is the only way to ask.
   */
  const iam = {
    /** The grant table. One row per (principal, role, scope, object). */
    assignments: {
      list: P.listAssignments,
      create: P.createAssignment,
      revoke: P.revokeAssignment,
    },
    /** The permission catalog as data — action, scope, delegability, implications. */
    permissions: {
      list: P.listPermissions,
      /** The leaves one role carries. */
      forRole: P.getRolePermissions,
    },
    roles: {
      list: P.listRoles,
      create: P.createRole,
      update: P.updateRole,
      setPermissions: P.updateRolePermissions,
      remove: P.deleteRole,
      usage: P.getRoleUsage,
    },
    groups: {
      list: P.listGroups,
      get: P.getGroup,
      create: P.createGroup,
      update: P.updateGroup,
      remove: P.deleteGroup,
      members: {
        list: P.listGroupMembers,
        add: P.addGroupMembers,
        remove: P.removeGroupMember,
      },
    },
    /** Auto-provisioned agent identities — the principal picker for binding a
     *  role to an agent. */
    agentIdentities: P.listAgentIdentities,
    /**
     * The policy rows behind the assignments — read-only. `assignments` is
     * still the only grant store; this is the diagnostic view of what the
     * engine holds for a principal or a scope.
     */
    policies: {
      list: P.listPolicies,
    },
    /** Ask the engine. This is the ONLY authorization read a client should make:
     *  probe the LEAF a route asserts, never a role label. */
    can: P.probeEffectivePermission,
    /** Batch probe — one roundtrip for N leaves. */
    canBatch: P.probeEffectivePermissions,
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
    /** Usage rollup (/v1/usage), optionally grouped by model, provider, or day. */
    usageRollup: P.getUsageRollup,
    /** Unified finalized LLM and compute cost by session. */
    sessionCosts: {
      list: P.listSessionCosts,
      get: P.getSessionCostRecord,
    },
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
      /** Re-read Stripe and rewrite the local subscription record (repair path). */
      sync: P.syncSubscription,
    },

    /** One-off credit purchases + recurring auto-topup configuration. */
    credits: {
      purchase: (input: Parameters<typeof P.purchaseCredits>[0]) => P.purchaseCredits(input),
      autoTopupSettings: (accountId?: string) => P.getAutoTopupSettings(accountId),
      configureAutoTopup: (input: Parameters<typeof P.configureAutoTopup>[0]) =>
        P.configureAutoTopup(input),
      /** Can auto-topup actually charge? (a payment method must exist). */
      autoTopupSetupStatus: P.getAutoTopupSetupStatus,
    },

    /** Per-seat (team) billing — the seat-count subscription, not credits. */
    perSeat: {
      createCheckout: P.createPerSeatCheckout,
      /** Move an existing account onto per-seat billing and settle the credit. */
      claim: P.claimPerSeatBilling,
    },

    /**
     * Spend rollups over finalized LLM + compute cost (`/v1/usage/cost-*`).
     * `sessionCosts` above is the per-session record; this is the aggregate.
     */
    costs: {
      summary: P.getCostSummary,
      byProject: P.listCostByProject,
      /**
       * CSV export as a Blob. It is a real authenticated `fetch`, not a URL:
       * the route requires a Bearer token, so a bare `<a href>` 401s.
       */
      exportCsv: P.fetchCostExportCsv,
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
    /**
     * Same provision, with server-observed progress events. Browser/Bun only —
     * React Native has no streaming response body, so RN hosts call
     * `provision` instead.
     */
    provisionStream: P.provisionProjectStream,
    /** Is Kortix-managed git configured on this deployment? (self-host may not be). */
    managedGitStatus: P.getManagedGitStatus,
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
    listLinkableInstallations: P.listLinkableGitHubInstallations,
    listRepositories: P.listGitHubRepositories,
    listRepositoryBranches: P.listGitHubRepositoryBranches,
    linkInstallation: P.linkGitHubInstallation,
    saveInstallation: P.saveGitHubInstallation,
    deleteInstallation: P.deleteGitHubInstallation,
    /**
     * The PLATFORM's own GitHub App (self-host setup), not a user's
     * installation: create one from a manifest, paste an existing one, fall
     * back to a PAT, or disconnect managed-git entirely.
     */
    app: {
      status: B.getGitHubAppStatus,
      startManifest: B.startGitHubAppManifest,
      setFromExisting: B.setGitHubAppFromExisting,
      setPat: B.setGitHubAppPat,
      disconnect: B.disconnectGitHubApp,
    },
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

  /**
   * Identity at the platform edge — everything about WHO the caller is that is
   * not an account/project grant (that is `iam`).
   *
   * Most of these are host-boundary calls: the caller is anonymous (waitlist,
   * OAuth consent screen) or is a server action holding a request-scoped token.
   * The facade supplies the backend URL; pass `accessToken` when you have one.
   */
  const auth = {
    /** Waitlist / allowlist gate on the sign-up page. */
    access: {
      checkEmail: <T = Record<string, unknown>>(
        email: string,
        options?: Partial<B.HostRequestOptions>,
      ) => B.checkAccessEmail<T>(email, hostOptions(options)),
      request: (
        input: Parameters<typeof B.submitAccessRequest>[0],
        options?: Partial<B.HostRequestOptions>,
      ) => B.submitAccessRequest(input, hostOptions(options)),
    },
    /** Tell the API the session ended (audit trail + server-side cleanup). */
    logout: (options?: Partial<B.HostRequestOptions>) =>
      B.recordPlatformLogout(hostOptions(options)),
    /**
     * Read the account's app-access state with an EXPLICIT token — the
     * server-side post-auth redirect decision, made before any client exists.
     * Never throws: `null` means "can't tell yet".
     */
    accountState: P.fetchAccountStateWithToken,
    /** The OAuth 2.1 consent screen a third-party client is redirected to. */
    oauthConsent: {
      get: (requestId: string, options?: Partial<B.HostRequestOptions>) =>
        B.getOAuthConsentRequest(requestId, hostOptions(options)),
      submit: (
        input: Parameters<typeof B.submitOAuthConsent>[0],
        options?: Partial<B.HostRequestOptions>,
      ) => B.submitOAuthConsent(input, hostOptions(options)),
    },
    /** Link a chat-platform user id to this Kortix account, by one-time token. */
    identities: {
      bindSlack: P.bindSlackIdentity,
      bindTeams: P.bindTeamsIdentity,
    },
    /** Self-serve account deletion (scheduled, cancellable, or immediate). */
    deletion: {
      status: P.getAccountDeletionStatus,
      request: P.requestAccountDeletion,
      cancel: P.cancelAccountDeletion,
      deleteNow: P.deleteAccountImmediately,
    },
  };

  /**
   * Platform-operator surface (`/admin/*`, `/system/*`). Every call is
   * authorization-gated server-side for a platform admin — the namespace being
   * present on the facade grants nothing.
   */
  const admin = {
    /** Is the caller a platform admin, and at which level? */
    role: P.getAdminRole,
    /** Same row, read with an EXPLICIT token (server-side gate). */
    userRoles: <T = unknown[]>(options?: Partial<B.HostRequestOptions>) =>
      B.getUserRolesWithToken<T>(hostOptions(options)),
    sandboxes: {
      list: P.listAdminSandboxes,
      migrateProvider: P.migrateAdminSandboxProvider,
    },
    /** Sandbox-provider weighting, analytics, and the cross-provider fallback. */
    providers: {
      analytics: P.getAdminProviderAnalytics,
      distribution: {
        get: P.getAdminProviderDistribution,
        set: P.setAdminProviderDistribution,
      },
      fallback: {
        get: P.getAdminProviderFallback,
        set: P.setAdminProviderFallback,
      },
    },
    /** The maintenance-window banner + hard gate. */
    maintenance: {
      get: <T>(options?: Partial<B.HostRequestOptions>) =>
        B.getMaintenanceConfig<T>(hostOptions(options)),
      set: <T>(maintenanceConfig: T, options?: Partial<B.HostRequestOptions>) =>
        B.setMaintenanceConfig<T>(maintenanceConfig, hostOptions(options)),
    },
    /** Raw NDJSON progress stream of an admin stress-test run. */
    stressTest: (input: Record<string, unknown>, options?: Partial<B.HostRequestOptions>) =>
      B.openStressTestStream(input, hostOptions(options)),
    /**
     * Read-only admin bypass for THIS client. Not an HTTP call — it flips a
     * module-level flag that makes every later request carry
     * `x-kortix-admin-bypass: 1`; the API honors it only for a real platform
     * admin on a `read` action. In-memory and process-wide, so it is shared by
     * every `createKortix()` instance in the tab and resets on reload.
     */
    setBypass: setAdminBypass,
    /**
     * Reload the ACTIVE sandbox runtime's own services (opencode
     * `/kortix/refresh` or `/global/dispose`). Runtime-scoped, not REST —
     * requires a globally-active runtime, unlike the session handle's methods.
     */
    systemReload,
  };

  /**
   * REDEEMING a setup link — the recipient side, addressed by token alone.
   * `project(id).setupLinks` is the other half: an agent MINTING one.
   *
   * The secret and connector links carry their own authority (that is the
   * point — the recipient is often not a Kortix user). `approval` does not: the
   * token only says which decision is being asked for, so the caller must be a
   * signed-in manager on that project.
   */
  const setupLinks = {
    secret: {
      get: (token: string, options?: Partial<B.HostRequestOptions>) =>
        B.getSecretSetupLink(token, hostOptions(options)),
      submit: (
        token: string,
        values: Record<string, string>,
        options?: Partial<B.HostRequestOptions>,
      ) => B.submitSecretSetupLink(token, values, hostOptions(options)),
    },
    connector: {
      get: (token: string, options?: Partial<B.HostRequestOptions>) =>
        B.getConnectorSetupLink(token, hostOptions(options)),
      start: (token: string, options?: Partial<B.HostRequestOptions>) =>
        B.startConnectorSetupLink(token, hostOptions(options)),
      finalize: (token: string, options?: Partial<B.HostRequestOptions>) =>
        B.finalizeConnectorSetupLink(token, hostOptions(options)),
    },
    /** REQUIRES a signed-in manager/launcher on the project (401/403 otherwise). */
    approval: P.getApprovalLink,
  };

  /**
   * Anonymous reads — the logged-out surfaces (a shared session, a public
   * template, the marketplace catalog, a voice join link).
   *
   * No Authorization header is ever attached: the token in the path IS the
   * authorization, and a share can be revoked at any moment. The facade only
   * binds the backend URL.
   */
  const publicApi = {
    /** Resolve a `kps_…` share token into its metadata. */
    share: <T = Record<string, unknown>>(token: string, options?: Partial<B.HostRequestOptions>) =>
      B.getPublicShareByToken<T>(token, hostOptions(options)),
    /**
     * The BODY of a `resource_type: 'file'` share. Pass the `proxy_path` the
     * share metadata carries — it already includes the `/v1` prefix, so this
     * joins it to the API ORIGIN, not the API base.
     */
    shareFile: {
      url: (proxyPath: string) => B.buildPublicShareFileUrl(backendUrlNow(), proxyPath),
      fetch: (proxyPath: string, options?: B.PublicShareFileOptions) =>
        B.fetchPublicShareFile(backendUrlNow(), proxyPath, options),
      text: (proxyPath: string, options?: B.PublicShareFileOptions) =>
        B.readPublicShareFileText(backendUrlNow(), proxyPath, options),
      blob: (proxyPath: string, options?: B.PublicShareFileOptions) =>
        B.readPublicShareFileBlob(backendUrlNow(), proxyPath, options),
    },
    /** Start a session with an explicit request-scoped token (server action). */
    startSession: (projectId: string, sessionId: string, options?: Partial<B.HostRequestOptions>) =>
      B.startSessionWithToken(projectId, sessionId, hostOptions(options)),
    /** A publicly shared session transcript, by share id. */
    sessionShare: {
      get: P.getPublicSessionShare,
      messages: P.getPublicSessionShareMessages,
    },
    /** A voice join link: the LiveKit credentials, and the call's transcript. */
    voice: {
      join: P.getPublicVoiceJoin,
      transcript: P.getPublicVoiceTranscript,
    },
    /** A publicly shared project template, by share id. */
    template: <T>(shareId: string, signal?: AbortSignal) =>
      B.getPublicTemplate<T>(backendUrlNow(), shareId, signal),
    marketplaces: <T = { marketplaces: unknown[] }>(options?: Partial<B.HostRequestOptions>) =>
      B.listPublicMarketplaces<T>(hostOptions(options)),
    marketplaceItems: <T = { items: unknown[] }>(
      query?: B.PublicMarketplaceQuery,
      options?: Partial<B.HostRequestOptions>,
    ) => B.listPublicMarketplaceItems<T>(hostOptions(options), query),
    marketplaceItem: <T = Record<string, unknown>>(
      id: string,
      options?: Partial<B.HostRequestOptions>,
    ) => B.getPublicMarketplaceItem<T>(id, hostOptions(options)),
    marketplaceItemFile: <T = Record<string, unknown>>(
      id: string,
      path: string,
      options?: Partial<B.HostRequestOptions>,
    ) => B.getPublicMarketplaceItemFile<T>(id, path, hostOptions(options)),
  };

  /**
   * Presentation export (`/v1/google/*`, `/v1/presentation-tools/*`).
   * The runtime-side conversion + metadata read live on the SESSION handle
   * (`session(pid, sid).presentations`) — they need that session's own sandbox.
   */
  const presentations = {
    /** Google OAuth consent URL for the Slides upload. */
    googleAuthUrl: P.getGoogleAuthUrl,
    /** Convert a workspace presentation and upload it to Google Slides. */
    toGoogleSlides: P.convertPresentationToGoogleSlides,
  };

  /** Preview-proxy access (the `__preview_session` cookie an iframe needs). */
  const previews = {
    /**
     * Mint/refresh the preview cookie for a preview URL's proxy origin. Never
     * throws — `false` means "not a preview URL, no token, or the exchange
     * failed", and callers proceed and let the proxy answer.
     */
    ensureSessionCookie: ensurePreviewSessionCookie,
  };

  /** Deployment tunnel events (`/v1/tunnel/events`), with the API URL bound. */
  const tunnel = {
    stream: (options: Parameters<typeof createTunnelEventStream>[1]) =>
      createTunnelEventStream(backendUrlNow(), options),
  };

  /** Id-bound handle for a single project: every sub-resource, projectId pre-applied. */
  function connectorDataPlane(projectId?: string) {
    return {
      /** Callable catalog for this project or token scope. */
      catalog: () => P.getConnectorCatalog(projectId),
      /** Flattened `<connector>.<action>` tool list. */
      tools: () => P.listConnectorTools(projectId),
      /** Search callable tools by id and description. */
      search: (...a: DropFirst<Parameters<typeof P.searchConnectorTools>>) =>
        P.searchConnectorTools(projectId, ...a),
      /** Describe one `<connector>.<action>` tool. */
      describe: (...a: DropFirst<Parameters<typeof P.describeConnectorTool>>) =>
        P.describeConnectorTool(projectId, ...a),
      /** Call one `<connector>.<action>` tool. */
      call: <T = unknown>(...a: DropFirst<Parameters<typeof P.callConnector<T>>>) =>
        P.callConnector<T>(projectId, ...a),
      /** Upload bytes for use by a later connector call. */
      uploadAttachment: (...a: DropFirst<Parameters<typeof P.uploadConnectorAttachment>>) =>
        P.uploadConnectorAttachment(projectId, ...a),
    };
  }

  function project(projectId: string) {
    const connections = {
      list: () => P.listConnections(projectId),
      listAll: () => P.listAllConnections(projectId),
      reconcile: (...a: DropFirst<Parameters<typeof P.reconcileConnection>>) =>
        P.reconcileConnection(projectId, ...a),
      reconcileMember: (...a: DropFirst<Parameters<typeof P.reconcileMemberConnection>>) =>
        P.reconcileMemberConnection(projectId, ...a),
      updateCredential: (...a: DropFirst<Parameters<typeof P.updateConnectionCredential>>) =>
        P.updateConnectionCredential(projectId, ...a),
      revoke: (...a: DropFirst<Parameters<typeof P.revokeConnection>>) =>
        P.revokeConnection(projectId, ...a),
      activate: (...a: DropFirst<Parameters<typeof P.activateConnection>>) =>
        P.activateConnection(projectId, ...a),
      setDefault: (...a: DropFirst<Parameters<typeof P.setDefaultConnection>>) =>
        P.setDefaultConnection(projectId, ...a),
      pipedreamConnect: (...a: DropFirst<Parameters<typeof P.pipedreamConnectConnection>>) =>
        P.pipedreamConnectConnection(projectId, ...a),
      pipedreamFinalize: (...a: DropFirst<Parameters<typeof P.pipedreamFinalizeConnection>>) =>
        P.pipedreamFinalizeConnection(projectId, ...a),
      /**
       * Bring-your-own OAuth 2.1 app on ONE connection: register the client,
       * discover the provider's metadata, then run either the redirect or the
       * device-code grant. The device grant is the one an agent can drive
       * headlessly — start it, show the user the code, then poll.
       */
      oauth2: {
        setApplication: (...a: DropFirst<Parameters<typeof P.putConnectionOAuth2Application>>) =>
          P.putConnectionOAuth2Application(projectId, ...a),
        discover: (...a: DropFirst<Parameters<typeof P.discoverConnectionOAuth2>>) =>
          P.discoverConnectionOAuth2(projectId, ...a),
        authorize: (...a: DropFirst<Parameters<typeof P.startConnectionOAuth2Authorization>>) =>
          P.startConnectionOAuth2Authorization(projectId, ...a),
        startDevice: (
          ...a: DropFirst<Parameters<typeof P.startConnectionOAuth2DeviceAuthorization>>
        ) => P.startConnectionOAuth2DeviceAuthorization(projectId, ...a),
        pollDevice: (
          ...a: DropFirst<Parameters<typeof P.pollConnectionOAuth2DeviceAuthorization>>
        ) => P.pollConnectionOAuth2DeviceAuthorization(projectId, ...a),
      },
    };
    return {
      get: (opts?: Parameters<typeof P.getProject>[1]) => P.getProject(projectId, opts),
      detail: () => P.getProjectDetail(projectId),
      /** Canonical project-scoped audit timeline. */
      audit: (options?: Parameters<typeof P.listProjectAudit>[1]) =>
        P.listProjectAudit(projectId, options),
      update: (input: Parameters<typeof P.updateProject>[1]) => P.updateProject(projectId, input),
      archive: () => P.archiveProject(projectId),
      llmCatalog: () => P.getProjectLlmCatalog(projectId),
      /** The PROVIDER rows of the live catalog — works for non-gateway projects too. */
      llmCatalogProviders: (options?: Parameters<typeof P.getProjectLlmCatalogProviders>[1]) =>
        P.getProjectLlmCatalogProviders(projectId, options),
      modelPicker: () => P.getProjectModelPicker(projectId),
      sandboxHealth: () => P.getProjectSandboxHealth(projectId),
      onboardingComplete: (...a: DropFirst<Parameters<typeof P.setProjectOnboardingComplete>>) =>
        P.setProjectOnboardingComplete(projectId, ...a),
      /**
       * Save the onboarding SURVEY answers. Deliberately separate from
       * `onboardingComplete`: sending completion from a survey save would end
       * onboarding at the first question.
       */
      onboardingProfile: (profile: Parameters<typeof P.setProjectOnboardingProfile>[1]) =>
        P.setProjectOnboardingProfile(projectId, profile),
      /** The agent block a `kortix.yaml` declares — read and rewrite it. */
      agentConfig: {
        get: (agentName: string) => P.getAgentConfig(projectId, agentName),
        update: (...a: DropFirst<Parameters<typeof P.updateAgentConfig>>) =>
          P.updateAgentConfig(projectId, ...a),
      },
      /** Install a marketplace item into this project (commits onto its branch). */
      marketplace: {
        installSession: (itemId: string) => P.createMarketplaceInstallSession(projectId, itemId),
      },

      /** Provider-neutral serverless Apps owned by this project. */
      apps: {
        list: () => P.listApps(projectId),
        create: (input: Parameters<typeof P.createApp>[1]) => P.createApp(projectId, input),
        get: (appId: string) => P.getApp(projectId, appId),
        update: (...a: DropFirst<Parameters<typeof P.updateApp>>) => P.updateApp(projectId, ...a),
        access: {
          get: (...a: DropFirst<Parameters<typeof P.getAppAccess>>) => P.getAppAccess(projectId, ...a),
          update: (...a: DropFirst<Parameters<typeof P.updateAppAccess>>) => P.updateAppAccess(projectId, ...a),
          session: (...a: DropFirst<Parameters<typeof P.createAppAccessSession>>) =>
            P.createAppAccessSession(projectId, ...a),
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
        /** Device-code OAuth flow to connect a subscription-backed provider (e.g. ChatGPT). */
        startProviderOAuth: (...a: DropFirst<Parameters<typeof P.startProjectProviderOAuth>>) =>
          P.startProjectProviderOAuth(projectId, ...a),
        pollProviderOAuth: (...a: DropFirst<Parameters<typeof P.pollProjectProviderOAuth>>) =>
          P.pollProjectProviderOAuth(projectId, ...a),
        removeProviderOAuth: (provider: string) =>
          P.deleteProjectProviderOAuth(projectId, provider),
        /**
         * Declare one secret for one agent — the one-click fix for a
         * `no_agent_grant` delivery verdict. Distinct from `setAgentScope`,
         * which REPLACES an agent's whole grant set.
         */
        grantToAgent: (...a: DropFirst<Parameters<typeof P.grantSecretToAgent>>) =>
          P.grantSecretToAgent(projectId, ...a),
      },

      access: {
        list: () => P.listProjectAccess(projectId),
        /** Ask for access to a project you cannot open (non-member path). */
        request: (message?: string) => P.requestProjectAccess(projectId, message),
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
        ...connectorDataPlane(projectId),
        list: () => P.listConnectors(projectId),
        config: (...a: DropFirst<Parameters<typeof P.getConnectorConfig>>) =>
          P.getConnectorConfig(projectId, ...a),
        create: (...a: DropFirst<Parameters<typeof P.createConnector>>) =>
          P.createConnector(projectId, ...a),
        remove: (...a: DropFirst<Parameters<typeof P.deleteConnector>>) =>
          P.deleteConnector(projectId, ...a),
        sync: () => P.syncConnectors(projectId),
        auth: {
          discover: (...a: DropFirst<Parameters<typeof P.discoverConnectorAuth>>) =>
            P.discoverConnectorAuth(projectId, ...a),
        },
        setName: (...a: DropFirst<Parameters<typeof P.setConnectorName>>) =>
          P.setConnectorName(projectId, ...a),
        setCredentialMode: (...a: DropFirst<Parameters<typeof P.setConnectorCredentialMode>>) =>
          P.setConnectorCredentialMode(projectId, ...a),
        setAuthorizationStrategy: (
          ...a: DropFirst<Parameters<typeof P.setConnectorAuthorizationStrategy>>
        ) => P.setConnectorAuthorizationStrategy(projectId, ...a),
        setCredential: (...a: DropFirst<Parameters<typeof P.setConnectorCredential>>) =>
          P.setConnectorCredential(projectId, ...a),
        setSensitive: (...a: DropFirst<Parameters<typeof P.setConnectorSensitive>>) =>
          P.setConnectorSensitive(projectId, ...a),
        /** Point a connector at a project secret for its credential (null unbinds). */
        setSecretBinding: (...a: DropFirst<Parameters<typeof P.setConnectorSecretBinding>>) =>
          P.setConnectorSecretBinding(projectId, ...a),
        /** Get (or create) the connection row an OAuth 2.1 flow needs for a connector. */
        ensureConnection: (slug: string) => P.ensureProjectConnectorConnection(projectId, slug),
        connections,
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
          /** The browse page: a fixed top slice of each of the largest
           *  categories, with each category's true total, in one request. */
          listSections: (...a: DropFirst<Parameters<typeof P.listPipedreamSections>>) =>
            P.listPipedreamSections(projectId, ...a),
          connect: (...a: DropFirst<Parameters<typeof P.pipedreamConnect>>) =>
            P.pipedreamConnect(projectId, ...a),
          finalize: (...a: DropFirst<Parameters<typeof P.pipedreamFinalize>>) =>
            P.pipedreamFinalize(projectId, ...a),
        },
        /** Direct connector catalogue and normalized domain surfaces. */
        discover: {
          list: (...a: DropFirst<Parameters<typeof P.listDiscoverConnectors>>) =>
            P.listDiscoverConnectors(projectId, ...a),
          detail: (...a: DropFirst<Parameters<typeof P.getDiscoverConnector>>) =>
            P.getDiscoverConnector(projectId, ...a),
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
        list: (options?: Parameters<typeof P.listProjectSessions>[1]) =>
          P.listProjectSessions(projectId, options),
        create: (input?: Parameters<typeof P.createProjectSession>[1]) =>
          P.createProjectSession(projectId, input),
        /** Pre-create the session a present user is about to start. Ordinary session; ignore failures. */
        ensureWarm: () => P.ensureWarmProjectSession(projectId),
        /** @deprecated Navigate to `ensureWarm()`'s session and prompt it. Removed in the next major. */
        claimWarm: (input: Parameters<typeof P.claimWarmProjectSession>[1]) =>
          P.claimWarmProjectSession(projectId, input),
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

      /** The manager inbox of connector-gated actions awaiting approve/deny (APPROVE / ASK / BLOCK). */
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
        playground: (prompt: string, models: string[], system?: string) =>
          P.runGatewayPlayground(projectId, prompt, models, system),
      },

      /** Slack + email + Meet channel connections. */
      channels: {
        /**
         * The per-conversation bindings a channel installation owns (which
         * agent, which model, which conversation policy for one Slack channel
         * or email address).
         */
        bindings: {
          list: () => P.listChannelBindings(projectId),
          update: (...a: DropFirst<Parameters<typeof P.updateChannelBinding>>) =>
            P.updateChannelBinding(projectId, ...a),
        },
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
        voice: {
          setBotName: (name: string) => P.setMeetBotName(projectId, name),
        },
      },

      /** Toggle a feature flag (Customize → Feature flags). Pass `enabled: null` to clear the override. */
      updateFeatureFlag: (...a: DropFirst<Parameters<typeof P.updateFeatureFlag>>) =>
        P.updateFeatureFlag(projectId, ...a),

      /** @deprecated Renamed to `updateFeatureFlag`. Keeps the legacy `/experimental` wire path for older deployed APIs. */
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
        /**
         * Poll the durable provider migration `setProvider` starts when it
         * returns `kind: 'preparation'`, until `latest` is terminal or null.
         */
        providerTransition: (
          options?: Parameters<typeof P.getProjectSandboxProviderTransition>[1],
        ) => P.getProjectSandboxProviderTransition(projectId, options),
      },

      /** Bind specific secrets + connectors to an agent (the inheritance pyramid's declaration step). */
      setAgentScope: (...a: DropFirst<Parameters<typeof P.setAgentScope>>) =>
        P.setAgentScope(projectId, ...a),

      session: (sessionId: string) => session(projectId, sessionId),
    };
  }

  /** Id-bound handle for a single session: lifecycle (REST) + runtime (opencode). */
  function session(projectId: string, sessionId: string) {
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
        _persistedPromptDefaults = P.getProjectSession(projectId, sessionId, {
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
          projectId,
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
            projectId,
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
      clearSessionRuntime(projectId, sessionId);
    }

    return {
      // ── lifecycle (Kortix REST) ──────────────────────────────────────────
      get: (opts?: { showErrors?: boolean }) => P.getProjectSession(projectId, sessionId, opts),
      /** Unified finalized LLM and compute cost for this session. */
      cost: () => P.getSessionCostRecord(sessionId, { projectId }),
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
      /** Is this session still running the config the manifest compiles to? */
      configState: () => P.getProjectSessionConfigState(projectId, sessionId),
      /**
       * Recompile the agent config from git into this running session.
       *
       * Restarts opencode to rebuild its config, so readiness has to be
       * resolved again — same reason `restart` forgets it.
       */
      reloadConfig: (input?: Parameters<typeof P.reloadProjectSessionConfig>[2]) => {
        forgetReady();
        return P.reloadProjectSessionConfig(projectId, sessionId, input);
      },
      /** Reload config with server-observed progress events. */
      reloadConfigStream: (
        ...args: DropFirst2<Parameters<typeof P.reloadProjectSessionConfigStream>>
      ) => {
        forgetReady();
        return P.reloadProjectSessionConfigStream(projectId, sessionId, ...args);
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
      /** Per-session audit trail of connector-gated agent actions. */
      audit: (limit?: number, options?: Parameters<typeof P.getSessionAudit>[3]) =>
        P.getSessionAudit(projectId, sessionId, limit, options),
      /** Compact server-side transcript read (text + tool calls, no tool inputs/outputs) — callable with project-scoped session tokens. */
      transcript: (options?: Parameters<typeof P.getSessionTranscript>[2]) =>
        P.getSessionTranscript(projectId, sessionId, options),
      /** Which turns are running right now, and how did the last one end?
       *  Server truth from the control plane's lifecycle authority, independent
       *  of the live stream. */
      turn: () => P.getSessionTurn(projectId, sessionId),
      /** This session's SERVER-SIDE prompt inbox: the prompts it still owes the
       *  user. Durable, so it survives a closed tab and is the same list on
       *  every device. */
      prompts: {
        create: (input: P.CreateSessionPromptInput) =>
          P.createSessionPrompt(projectId, sessionId, input),
        list: () => P.listSessionPrompts(projectId, sessionId),
        remove: (promptId: string) => P.deleteSessionPrompt(projectId, sessionId, promptId),
        retry: (promptId: string) => P.retrySessionPrompt(projectId, sessionId, promptId),
        /** Hold (or release) the whole queue — what the Stop button writes. */
        hold: (held: boolean) => P.holdSessionPrompts(projectId, sessionId, held),
      },
      /** This session's live voice-call transcript (spoken turns + ask_kortix/run_command calls). */
      voiceTranscript: (options?: Parameters<typeof P.getVoiceTranscript>[2]) =>
        P.getVoiceTranscript(projectId, sessionId, options),

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

      /**
       * Presentations the agent wrote into THIS session's workspace.
       *
       * Every call resolves this handle's own runtime first (same contract as
       * `send`/`files`) — never the module-global "active" sandbox, so a host
       * with two open sessions cannot read one session's deck through the
       * other's proxy. The account-level export helpers (`googleAuthUrl`) stay
       * on the top-level `presentations` namespace.
       */
      presentations: {
        /** Convert `presentations/<name>/` to a PDF or PPTX Blob (polls while it renders). */
        convert: async (
          format: RuntimePresentationFormat,
          presentationPath: string,
          options?: ConvertRuntimePresentationOptions,
        ) =>
          convertRuntimePresentation(
            format,
            (await ensureReady()).runtimeUrl,
            presentationPath,
            options,
          ),
        /**
         * Read one presentation's `metadata.json` off the static-file service.
         * A deck is written slide by slide, so "not there yet" comes back as
         * `status: 'not-ready'` — never thrown. The caller owns the retry cadence.
         */
        metadata: async <T = RuntimePresentationMetadata>(
          presentationName: string,
          fetchOptions?: FetchPresentationMetadataOptions,
        ) =>
          fetchPresentationMetadata<T>(
            presentationName,
            resolvePreviewOptsForSandbox((await ensureReady()).sandboxId),
            fetchOptions,
          ),
        /** Upload this session's deck to Google Slides (needs `presentations.googleAuthUrl` first). */
        toGoogleSlides: async (presentationPath: string) =>
          P.convertPresentationToGoogleSlides(presentationPath, (await ensureReady()).runtimeUrl),
      },

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
        const result = await P.setProjectSessionModel(projectId, sessionId, model);
        _persistedPromptDefaults = null;
        return result;
      },
      /** Read the authoritative secret allowlist and connections. */
      scope: () => P.getProjectSessionScope(projectId, sessionId),
      /** Re-scope a running session — set semantics; see setProjectSessionScope. */
      rescope: (scope: P.SessionScopeInput) =>
        P.setProjectSessionScope(projectId, sessionId, scope),
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
        /**
         * Overwrite `filePath` in place. The daemon's upload endpoint never
         * overwrites (it uniquifies a colliding name), so a plain `upload` over
         * an existing path silently writes a DIFFERENT file — see `writeFile`.
         */
        write: async (filePath: string, content: Blob | File) =>
          F.writeFile(filePath, content, (await ensureReady()).runtimeUrl),
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
    /** Identity and access — assignments, roles, permissions, groups, probes. */
    iam,
    /** Account-invite lifecycle reached by invite token alone (accept/decline/describe). */
    accountInvites,
    projects,
    /** Connector calls scoped by an agent/session token when no project id is available. */
    connectors: connectorDataPlane(),
    project,
    session,
    /** GitHub App installation + repository linking (account-scoped). */
    github,
    /** Billing read surface, including unified session costs. */
    billing,
    /** Public share links for a sandbox port (`/v1/p/share`, sandbox-scoped). */
    sandboxShares,
    /** Speech-to-text transcription (`/transcription` — not project-scoped). */
    transcribe: P.transcribeAudio,
    /** Deployment-wide Pipedream/easy-connect availability flag (not project-scoped). */
    connectStatus,
    /** Public marketplace catalog browse + sources (`/v1/marketplace/*`, not project-scoped). */
    marketplace,
    /** Identity at the platform edge — access requests, consent, logout, deletion. */
    auth,
    /** Platform-operator surface (`/admin/*`, `/system/*`) — gated server-side. */
    admin,
    /** REDEEM a setup link by token (`project(id).setupLinks` mints them). */
    setupLinks,
    /** Anonymous reads — shared sessions, public templates, the catalog, voice links. */
    public: publicApi,
    /** Presentation export (Google Slides). Runtime-side conversion is on the session handle. */
    presentations,
    /** Preview-proxy cookie exchange for an embedded preview. */
    previews,
    /** Deployment tunnel event stream. */
    tunnel,
    /** The pasted-API-key UX check — `GET /accounts/me`, never throws. */
    validateToken: P.validateToken,
    /** Escape hatch: the typed opencode client for the active sandbox. */
    runtime,
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
