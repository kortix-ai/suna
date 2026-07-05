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
import { getClient, getClientForUrl } from './opencode/client';
import { ApiError } from './platform/api/errors';
import { type KortixPlatformConfig, configureKortix, platformConfig } from './platform/config';
import * as P from './platform/projects-client';
import { getSessionHealth } from './session/health';
import { type SubdomainUrlOptions, proxyLocalhostUrl, rewriteLocalhostUrl } from './session/url';
import { setCurrentRuntime } from './state/current-runtime';
import {
  clearSessionRuntime,
  getSessionRuntime,
  type SessionRuntimeEntry,
} from './state/session-runtime-registry';
import { getSandboxUrlForExternalId } from './state/server-store/url-helpers';
import {
  openEventStream,
  type EventStreamHandle,
  type OpenCodeEvent,
} from './state/event-stream';

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
export class SessionNotReadyError extends Error {
  constructor(action: string) {
    super(
      `Session runtime not ready — call \`await session.ensureReady()\` (it drives \`start()\` to completion and resolves this session's own sandbox runtime) before calling \`${action}\`.`,
    );
    this.name = 'SessionNotReadyError';
  }
}

export function createKortix(config: KortixPlatformConfig) {
  // Wire the platform seam once. All wrapped functions read it.
  configureKortix(config);

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

  /** Id-bound handle for a single project: every sub-resource, projectId pre-applied. */
  function project(projectId: string) {
    return {
      get: (opts?: Parameters<typeof P.getProject>[1]) => P.getProject(projectId, opts),
      detail: () => P.getProjectDetail(projectId),
      update: (input: Parameters<typeof P.updateProject>[1]) => P.updateProject(projectId, input),
      archive: () => P.archiveProject(projectId),
      llmCatalog: () => P.getProjectLlmCatalog(projectId),
      sandboxHealth: () => P.getProjectSandboxHealth(projectId),
      onboardingComplete: (...a: DropFirst<Parameters<typeof P.setProjectOnboardingComplete>>) =>
        P.setProjectOnboardingComplete(projectId, ...a),

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
        setSharing: (...a: DropFirst<Parameters<typeof P.setConnectorSharing>>) =>
          P.setConnectorSharing(projectId, ...a),
        setCredentialMode: (...a: DropFirst<Parameters<typeof P.setConnectorCredentialMode>>) =>
          P.setConnectorCredentialMode(projectId, ...a),
        setCredential: (...a: DropFirst<Parameters<typeof P.setConnectorCredential>>) =>
          P.setConnectorCredential(projectId, ...a),
        setSensitive: (...a: DropFirst<Parameters<typeof P.setConnectorSensitive>>) =>
          P.setConnectorSensitive(projectId, ...a),
        /** The connector-side agent gate (mirror of a secret's agent_scope) — distinct from `setAgentScope`, which binds an agent's secret/connector allowlist. */
        setAgentScope: (...a: DropFirst<Parameters<typeof P.setConnectorAgentScope>>) =>
          P.setConnectorAgentScope(projectId, ...a),
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
      },

      sessions: {
        list: () => P.listProjectSessions(projectId),
        create: (input?: Parameters<typeof P.createProjectSession>[1]) =>
          P.createProjectSession(projectId, input),
      },

      /** Review Center — the per-project human-in-the-loop inbox (change requests, tool approvals, agent outputs/decisions). */
      review: {
        list: (params?: Parameters<typeof P.listReviewItems>[1]) => P.listReviewItems(projectId, params),
        get: (reviewItemId: string) => P.getReviewItem(projectId, reviewItemId),
        submit: (input: Parameters<typeof P.submitReviewItem>[1]) =>
          P.submitReviewItem(projectId, input),
        act: (...a: DropFirst<Parameters<typeof P.actReviewItem>>) => P.actReviewItem(projectId, ...a),
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
        logs: (opts?: Parameters<typeof P.listGatewayLogs>[1]) => P.listGatewayLogs(projectId, opts),
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
      },

      /** Slack + email + Meet channel integrations. */
      channels: {
        slack: {
          installation: () => P.getSlackInstallation(projectId),
          connect: (input: Parameters<typeof P.connectSlack>[1]) => P.connectSlack(projectId, input),
          mode: () => P.getSlackMode(projectId),
          manifest: () => P.getSlackManifest(projectId),
          disconnect: () => P.disconnectSlack(projectId),
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
        meet: {
          voices: () => P.getMeetVoices(projectId),
          setVoice: (voice: string) => P.setMeetVoice(projectId, voice),
          setBotName: (name: string) => P.setMeetBotName(projectId, name),
          previewVoice: (voiceId: string) => P.previewMeetVoice(projectId, voiceId),
        },
      },

      /** Project apps/deployments — the `/projects/:id/apps/*` family. */
      apps: {
        list: () => P.listProjectApps(projectId),
        create: (input: Parameters<typeof P.createProjectApp>[1]) => P.createProjectApp(projectId, input),
        update: (...a: DropFirst<Parameters<typeof P.updateProjectApp>>) =>
          P.updateProjectApp(projectId, ...a),
        remove: (slug: string) => P.deleteProjectApp(projectId, slug),
        deploy: (slug: string) => P.deployProjectApp(projectId, slug),
        stop: (slug: string) => P.stopProjectApp(projectId, slug),
        logs: (slug: string) => P.getProjectAppLogs(projectId, slug),
        /** @deprecated Use `updateExperimentalFeature('apps', enabled)` — kept for parity with the underlying client. */
        updateConfig: (input: Parameters<typeof P.updateAppsConfig>[1]) =>
          P.updateAppsConfig(projectId, input),
      },

      /** Toggle an experimental feature (Customize → Settings → Experimental). Pass `enabled: null` to clear the override. */
      updateExperimentalFeature: (...a: DropFirst<Parameters<typeof P.updateExperimentalFeature>>) =>
        P.updateExperimentalFeature(projectId, ...a),

      /** Default model preferences (account/agent/project scope, gateway-resolved). */
      modelDefaults: {
        get: () => P.getModelDefaults(projectId),
        set: (input: Parameters<typeof P.setModelDefault>[1]) => P.setModelDefault(projectId, input),
        clear: (params: Parameters<typeof P.clearModelDefault>[1]) =>
          P.clearModelDefault(projectId, params),
      },

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
        setProvider: (provider: string | null) => P.updateProjectSandboxProvider(projectId, provider),
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
    async function ensureReady(): Promise<SessionRuntimeEntry> {
      const cached = tryResolveReady();
      if (cached) return cached;
      const started = await P.startProjectSession(projectId, sessionId, 30_000);
      if (
        !started ||
        started.stage !== 'ready' ||
        !started.sandbox ||
        !started.opencode_session_id
      ) {
        throw new Error(`Session runtime not ready (stage: ${started?.stage ?? 'unknown'})`);
      }
      const externalId = (started.sandbox as { external_id?: string | null }).external_id;
      if (!externalId) {
        throw new Error('Session sandbox has no external_id — cannot resolve its runtime URL');
      }
      const runtimeUrl = getSandboxUrlForExternalId(externalId);
      // Point the app's shared runtime store at this session too, so React
      // hosts (which read the global current-runtime) keep working — but this
      // handle's own operations never read it back, only `_ready` below.
      setCurrentRuntime(runtimeUrl, externalId);
      _ready = { opencodeSessionId: started.opencode_session_id, runtimeUrl, sandboxId: externalId };
      return _ready;
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
        // Restart may re-provision a DIFFERENT sandbox — a stale cached/
        // registered runtime would route subsequent calls at a dead box.
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
        rewriteLocalhostUrl(port, path, resolvePreviewOptsForSandbox(requireReady('previewUrl').sandboxId)),
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
        const model = opts?.model ?? _model;
        const agent = opts?.agent ?? _agent;
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
        return getClientForUrl(runtimeUrl).session.abort({ sessionID: opencodeSessionId });
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
    /** Public share links for a sandbox port (`/v1/p/share`, sandbox-scoped). */
    sandboxShares,
    /** Speech-to-text transcription (`/transcription` — not project-scoped). */
    transcribe: P.transcribeAudio,
    /** Deployment-wide Pipedream/easy-connect availability flag (not project-scoped). */
    connectStatus,
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
