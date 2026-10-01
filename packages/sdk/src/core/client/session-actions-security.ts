import { ApiError } from '../http/api/errors';
import { mintWireMessageId } from '../session/wire-message-id';

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
     * Provision/resume if needed, then put a text prompt in this session's
     * durable inbox (`POST .../prompts`), the path every other producer
     * uses. Resolves when the prompt is durable, not when the turn ends: the
     * reply arrives on `stream()` and in the transcript. A per-call
     * `{ model, agent }` overrides the sticky setModel/setAgent choices for
     * this message only.
     */
    send: async (text: string, opts?: { model?: SessionModel; agent?: string }) => {
      await ctx.ensureReady();
      const selectedModel = opts?.model ?? ctx.model;
      const selectedAgent = opts?.agent ?? ctx.agent;
      const persisted = selectedModel && selectedAgent ? {} : await ctx.persistedPromptDefaults();
      const model = selectedModel ?? persisted.model;
      const agent = selectedAgent ?? persisted.agent;
      // Minted with no transcript to place it against, so the server places
      // it at delivery (`remintOnDelivery`), as the CLI does.
      const messageId = mintWireMessageId();
      const result = await P.createSessionPrompt(ctx.projectId, ctx.sessionId, {
        clientMessageId: messageId,
        messageId,
        remintOnDelivery: true,
        parts: [{ type: 'text', text }],
        clientSentAtMs: Date.now(),
        ...(model || agent ? { overrides: { ...(model ? { model } : {}), ...(agent ? { agent } : {}) } } : {}),
      });
      if (result.state === 'failed') {
        throw new ApiError('This prompt was refused: its earlier delivery already failed.', { code: 'PROMPT_FAILED' });
      }
      return result;
    },
    /** Abort the agent's current run in this session. */
  };
}
