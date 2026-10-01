import { backendApi } from '../http/api-client';

import * as A from '../rest/platform-client/auth';
import * as P from '../rest/projects-client';

import type { SessionBindingContext } from './session-context';
type DropFirst2<T extends unknown[]> = T extends [unknown, unknown, ...infer R] ? R : [];
export function bindSessionLifecycleResources(ctx: SessionBindingContext) {
  return {
    // ── lifecycle (Kortix REST) ──────────────────────────────────────────
    get: (opts?: { showErrors?: boolean }) =>
      P.getProjectSession(ctx.projectId, ctx.sessionId, opts),
    presence: (input: { tab_id: string; active: boolean }) =>
      backendApi.put<{ ok: boolean }>(
        `/projects/${ctx.projectId}/sessions/${ctx.sessionId}/presence`,
        input,
        { showErrors: false },
      ),
    /** Unified finalized LLM and compute cost for this session. */
    cost: () => P.getSessionCostRecord(ctx.sessionId, { projectId: ctx.projectId }),
    update: (input: Parameters<typeof P.updateProjectSession>[2]) =>
      P.updateProjectSession(ctx.projectId, ctx.sessionId, input),
    delete: () => {
      // A deleted session's sandbox is gone — never let a later handle for
      // this (ctx.projectId, ctx.sessionId) resolve a runtime that no longer exists.
      ctx.forgetReady();
      return P.deleteProjectSession(ctx.projectId, ctx.sessionId);
    },
    start: (...a: DropFirst2<Parameters<typeof P.startProjectSession>>) =>
      P.startProjectSession(ctx.projectId, ctx.sessionId, ...a),
    restart: () => {
      // Restart preserves the established sandbox identity, but readiness
      // and the proxy connection must still be resolved again after reboot.
      ctx.forgetReady();
      return P.restartProjectSession(ctx.projectId, ctx.sessionId);
    },
    stop: () => {
      ctx.forgetReady();
      return P.stopProjectSession(ctx.projectId, ctx.sessionId);
    },
    /** Is this session still running the config the manifest compiles to? */
    configState: () => P.getProjectSessionConfigState(ctx.projectId, ctx.sessionId),
    /**
     * Recompile the agent config from git into this running session.
     *
     * Restarts opencode to rebuild its config, so readiness has to be
     * resolved again — same reason `restart` forgets it.
     */
    reloadConfig: (input?: Parameters<typeof P.reloadProjectSessionConfig>[2]) => {
      ctx.forgetReady();
      return P.reloadProjectSessionConfig(ctx.projectId, ctx.sessionId, input);
    },
    /** Reload config with server-observed progress events. */
    reloadConfigStream: (
      ...args: DropFirst2<Parameters<typeof P.reloadProjectSessionConfigStream>>
    ) => {
      ctx.forgetReady();
      return P.reloadProjectSessionConfigStream(ctx.projectId, ctx.sessionId, ...args);
    },
    setSharing: (intent: Parameters<typeof P.setProjectSessionSharing>[2]) =>
      P.setProjectSessionSharing(ctx.projectId, ctx.sessionId, intent),
    previews: () => P.getSessionPreviewCandidates(ctx.projectId, ctx.sessionId),
    commit: (input?: Parameters<typeof P.commitSessionChanges>[2]) =>
      P.commitSessionChanges(ctx.projectId, ctx.sessionId, input),
    publicShares: {
      list: () => P.listSessionPublicShares(ctx.projectId, ctx.sessionId),
      create: (...a: DropFirst2<Parameters<typeof P.createSessionPublicShare>>) =>
        P.createSessionPublicShare(ctx.projectId, ctx.sessionId, ...a),
      revoke: (...a: DropFirst2<Parameters<typeof P.revokeSessionPublicShare>>) =>
        P.revokeSessionPublicShare(ctx.projectId, ctx.sessionId, ...a),
    },
    /** Scheduled prompts into this session — see `CreateSessionReminderInput`. */
  };
}
