import { authenticatedFetch } from '../http/auth';
import {
  createRuntimeVerbs,
  type PendingInteractions,
  type RuntimeVerbs,
  type TranscriptPage,
} from '../session/runtime-verbs';
import type { RuntimePermissionReply, RuntimeQuestionAnswer } from '../runtime/transcript-types';
import type { SessionBindingContext } from './session-context';

export function bindSessionRuntime(ctx: SessionBindingContext) {
  async function sessionVerbs(): Promise<RuntimeVerbs> {
    const { runtimeSessionId, runtimeUrl } = await ctx.ensureReady();
    return createRuntimeVerbs({ runtimeUrl, rootId: runtimeSessionId, fetch: authenticatedFetch as typeof fetch });
  }
  return {
    // ── session verbs (THIS session's own runtime) ───────────────────────
    /**
     * A page of this session's messages, oldest first (`{ info, parts }`,
     * `kortix.transcript.v1`): the root conversation, or `conversationId`
     * (a subagent child). `before` pages backwards.
     */
    messages: async (options?: {
      conversationId?: string;
      limit?: number;
      before?: string;
      signal?: AbortSignal;
    }): Promise<TranscriptPage> => (await sessionVerbs()).messages(options),
    /** Conversation statuses, and the permission requests and questions waiting for an answer. */
    pending: async (): Promise<PendingInteractions> => (await sessionVerbs()).pending(),
    /** Answer a permission request: `once`, `always` (the capability, for this session) or `reject`. */
    answerPermission: async (requestId: string, reply: RuntimePermissionReply, message?: string) =>
      (await sessionVerbs()).answerPermission(requestId, reply, message),
    /** Answer a question (one answer per question), or dismiss it with `null`. */
    answerQuestion: async (requestId: string, answers: RuntimeQuestionAnswer[] | null) =>
      (await sessionVerbs()).answerQuestion(requestId, answers),
    /**
     * Summarize the conversation into a shorter context, with `model` or the
     * runtime's default. Only a runtime with the `session.compact` capability
     * supports it (see `health()`).
     */
    compact: async (model?: { providerID: string; modelID: string }) => (await sessionVerbs()).compact(model),
  };
}
