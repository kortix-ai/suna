import { getClientForUrl } from '../runtime/client';

import * as A from '../rest/platform-client/auth';
import * as P from '../rest/projects-client';

import type { SessionBindingContext } from './session-context';
import type { SessionModel } from './session-shared';
export function bindSessionActionsSecurity(ctx: SessionBindingContext) {
  return {
    scope: () => P.getProjectSessionScope(ctx.projectId, ctx.sessionId),
    providerSecretPool: {
      list: () => P.listSessionProviderSecretPools(ctx.projectId, ctx.sessionId),
      get: (providerId: string) =>
        P.getSessionProviderSecretPool(ctx.projectId, ctx.sessionId, providerId),
      set: (providerId: string, secretIds: string[] | null) =>
        P.setSessionProviderSecretPool(ctx.projectId, ctx.sessionId, providerId, secretIds),
    },
    /** Re-scope a running session — set semantics; see setProjectSessionScope. */
    rescope: (scope: P.SessionScopeInput) =>
      P.setProjectSessionScope(ctx.projectId, ctx.sessionId, scope),
    /** Pick the agent `send` will use for subsequent prompts (until changed). */
    setAgent: (agent: string | undefined) => {
      ctx.agent = agent;
    },
    /**
     * Provision/resume if needed, then send a text prompt to the agent. A
     * per-call `{ model, agent }` overrides the sticky setModel/setAgent
     * choices for this message only.
     */
    send: async (text: string, opts?: { model?: SessionModel; agent?: string }) => {
      const { runtimeSessionId, runtimeUrl } = await ctx.ensureReady();
      const selectedModel = opts?.model ?? ctx.model;
      const selectedAgent = opts?.agent ?? ctx.agent;
      const persisted = selectedModel && selectedAgent ? {} : await ctx.persistedPromptDefaults();
      const model = selectedModel ?? persisted.model;
      const agent = selectedAgent ?? persisted.agent;
      return getClientForUrl(runtimeUrl).session.prompt({
        sessionID: runtimeSessionId,
        parts: [{ type: 'text', text }],
        ...(model ? { model } : {}),
        ...(agent ? { agent } : {}),
      });
    },
    /** Abort the agent's current run in this session. */
  };
}
