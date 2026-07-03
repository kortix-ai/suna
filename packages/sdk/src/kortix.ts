import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import { getClient } from './opencode/client';
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
import { type KortixPlatformConfig, configureKortix } from './platform/config';
import * as P from './platform/projects-client';
import { getSessionHealth } from './session/health';
import { type SubdomainUrlOptions, proxyLocalhostUrl, rewriteLocalhostUrl } from './session/url';
import { setCurrentRuntime } from './state/current-runtime';
import { getActiveSandboxId } from './state/server-store/active';
import { getSandboxUrlForExternalId } from './state/server-store/url-helpers';

/** A model the agent can run, as the opencode runtime identifies it. */
export type SessionModel = { providerID: string; modelID: string };

/** The opencode runtime client for the currently-active sandbox (set by the host). */
function runtime(): OpencodeClient {
  return getClient();
}

export function createKortix(config: KortixPlatformConfig) {
  // Wire the platform seam once. All wrapped functions read it.
  configureKortix(config);

  /**
   * Resolve the proxy/preview URL context (sandboxId + api base) from config +
   * the active runtime, so a session's `previewUrl`/`proxyUrl` never make the
   * host name a sandbox.
   */
  function resolvePreviewOpts(): SubdomainUrlOptions {
    const apiBaseUrl = config.backendUrl;
    let backendPort = 80;
    try {
      const u = new URL(apiBaseUrl);
      backendPort = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    } catch {}
    return { sandboxId: getActiveSandboxId() ?? '', backendPort, apiBaseUrl };
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
  };

  /** Top-level project operations (not bound to an id). */
  const projects = {
    list: P.listProjects,
    listForAccount: P.listProjectsForAccount,
    get: P.getProject,
    detail: P.getProjectDetail,
    create: P.createProject,
    provision: P.provisionProject,
    update: P.updateProject,
    archive: P.archiveProject,
    llmCatalog: P.getProjectLlmCatalog,
    sandboxHealth: P.getProjectSandboxHealth,
    sandboxTemplates: P.listProjectSandboxTemplates,
    sessions: P.listProjectSessions,
    createSession: P.createProjectSession,
  };

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

      session: (sessionId: string) => session(projectId, sessionId),
    };
  }

  /** Id-bound handle for a single session: lifecycle (REST) + runtime (opencode). */
  function session(projectId: string, sessionId: string) {
    // Opinionated-action state, scoped to THIS handle. The opencode runtime is
    // keyed by the OpenCode session id (resolved server-side at /start), NOT the
    // Kortix `sessionId` — they differ. We resolve+cache it once, and remember a
    // chosen model so `send` carries it.
    let _ready: { opencodeSessionId: string } | null = null;
    let _model: SessionModel | undefined;
    let _agent: string | undefined;

    /**
     * Make this session's runtime reachable and return its OpenCode session id.
     * Idempotent: `start` provisions/resumes the sandbox (long-poll until ready),
     * we point the active runtime at it, and cache the resolved id for reuse.
     */
    async function ensureReady(): Promise<{ opencodeSessionId: string }> {
      if (_ready) return _ready;
      const started = await P.startProjectSession(projectId, sessionId, 30_000);
      if (
        !started ||
        started.stage !== 'ready' ||
        !started.sandbox ||
        !started.opencode_session_id
      ) {
        throw new Error(`Session runtime not ready (stage: ${started?.stage ?? 'unknown'})`);
      }
      // Point the app's runtime at this session's box — no global "switch".
      const externalId = (started.sandbox as { external_id?: string | null }).external_id;
      if (externalId) setCurrentRuntime(getSandboxUrlForExternalId(externalId), externalId);
      _ready = { opencodeSessionId: started.opencode_session_id };
      return _ready;
    }

    return {
      // ── lifecycle (Kortix REST) ──────────────────────────────────────────
      get: (opts?: { showErrors?: boolean }) => P.getProjectSession(projectId, sessionId, opts),
      update: (input: Parameters<typeof P.updateProjectSession>[2]) =>
        P.updateProjectSession(projectId, sessionId, input),
      delete: () => P.deleteProjectSession(projectId, sessionId),
      start: (...a: DropFirst2<Parameters<typeof P.startProjectSession>>) =>
        P.startProjectSession(projectId, sessionId, ...a),
      restart: () => P.restartProjectSession(projectId, sessionId),
      stop: () => P.stopProjectSession(projectId, sessionId),
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

      // ── runtime health + preview (the session owns its runtime) ──────────
      /** Liveness/readiness of this session's runtime (`GET /kortix/health`). */
      health: (init?: RequestInit) => getSessionHealth(undefined, init),
      /** Proxy/preview URL for a port this session's runtime exposes. */
      previewUrl: (port: number, path = '/') =>
        rewriteLocalhostUrl(port, path, resolvePreviewOpts()),
      /** Rewrite a localhost URL the agent printed into a reachable proxy URL. */
      proxyUrl: (url?: string) => proxyLocalhostUrl(url, resolvePreviewOpts()),

      // ── agent actions (opinionated wrappers over the runtime) ────────────
      // These do the right thing end-to-end for scripts/non-React hosts: ensure
      // the runtime is up, point the SDK at it, resolve the OpenCode session id,
      // and act. React hosts use `@kortix/sdk/react` hooks instead, which bind to
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
        const { opencodeSessionId } = await ensureReady();
        const model = opts?.model ?? _model;
        const agent = opts?.agent ?? _agent;
        return runtime().session.prompt({
          sessionID: opencodeSessionId,
          parts: [{ type: 'text', text }],
          ...(model ? { model } : {}),
          ...(agent ? { agent } : {}),
        });
      },
      /** Abort the agent's current run in this session. */
      abort: async () => {
        const { opencodeSessionId } = await ensureReady();
        return runtime().session.abort({ sessionID: opencodeSessionId });
      },

      // ── runtime (opencode v2, active sandbox) ────────────────────────────
      // The typed opencode client, reached ONLY through the SDK. The host never
      // imports `@opencode-ai/sdk`. Opinionated wrappers (prompt/abort/setModel
      // with server-owned side-effects) layer on top of this as they land.
      get runtime(): OpencodeClient {
        return runtime();
      },
    };
  }

  return {
    /** The platform config in effect (for diagnostics). */
    config,
    accounts,
    projects,
    project,
    session,
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
