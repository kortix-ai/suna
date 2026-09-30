/**
 * The session verbs a host calls instead of the raw runtime client: read the
 * transcript, read what the agent waits on, answer it, compact. Each verb is
 * bound to one session's runtime URL and root conversation, and throws an
 * `ApiError` when the runtime refuses.
 *
 * `messages()` reads the Kortix transcript route (`/kortix/runtime/messages`);
 * the other verbs use the runtime's compatibility routes until the daemon
 * serves Kortix ones. A host never needs to know which.
 */
import { ApiError } from '../http/api/errors';
import { createRuntimeRestClient } from '../runtime/runtime-rest-client';
import type {
  KortixMessage,
  KortixSessionStatus,
  RuntimePermissionReply,
  RuntimePermissionRequest,
  RuntimeQuestionAnswer,
  RuntimeQuestionRequest,
} from '../runtime/transcript-types';

export interface RuntimeVerbsInput {
  /** The session's runtime base URL (`${backendUrl}/p/{externalId}/{port}`). */
  runtimeUrl: string;
  /** The session's root conversation in the runtime. */
  rootId: string;
  /** The fetch to send with (the SDK's authenticated fetch). */
  fetch: typeof fetch;
}

/** One page of a conversation, oldest first. */
export interface TranscriptPage {
  messages: KortixMessage[];
  /** More messages exist before the first one. */
  hasMore: boolean;
}

/** What a session's runtime waits on. */
export interface PendingInteractions {
  /** Status per conversation id (the root and its subagent children). */
  statuses: Record<string, KortixSessionStatus>;
  permissions: RuntimePermissionRequest[];
  questions: RuntimeQuestionRequest[];
}

async function errorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { error?: string; message?: string; data?: { message?: string } };
    return body.data?.message || body.error || body.message || text || `HTTP ${response.status}`;
  } catch {
    return text || `HTTP ${response.status}`;
  }
}

/** A compatibility-route result as data, or an `ApiError`. */
function unwrap<T>(result: { data?: T; error?: unknown; response?: Response }, what: string): T {
  if (result.error === undefined) return result.data as T;
  const error = result.error as { data?: { message?: string }; message?: string; error?: string } | string;
  const detail =
    typeof error === 'string' ? error : error?.data?.message || error?.message || error?.error || 'request failed';
  throw new ApiError(`${what}: ${detail}`, {
    ...(result.response ? { status: result.response.status, response: result.response } : {}),
  });
}

export function createRuntimeVerbs(input: RuntimeVerbsInput) {
  const base = input.runtimeUrl.replace(/\/$/, '');
  const client = createRuntimeRestClient({ baseUrl: base, fetch: input.fetch });

  return {
    /**
     * A page of a conversation's messages, oldest first: the root by default,
     * or `conversationId` (a subagent child). `before` pages backwards.
     */
    messages: async (
      options: { conversationId?: string; limit?: number; before?: string; signal?: AbortSignal } = {},
    ): Promise<TranscriptPage> => {
      const query = new URLSearchParams();
      if (options.limit !== undefined) query.set('limit', String(options.limit));
      if (options.before) query.set('before', options.before);
      const suffix = `/messages/${encodeURIComponent(options.conversationId ?? input.rootId)}${query.size ? `?${query}` : ''}`;
      const read = (mount: string) =>
        input.fetch(
          new Request(`${base}${mount}${suffix}`, { method: 'GET', ...(options.signal ? { signal: options.signal } : {}) }),
        );
      let response = await read('/kortix/runtime');
      // A daemon built before W3 serves the same route at its OpenCode name.
      if (response.status === 404 || (response.headers.get('content-type') ?? '').startsWith('text/html')) {
        response = await read('/kortix/opencode');
      }
      if (!response.ok) {
        throw new ApiError(`Reading the session transcript failed: ${await errorMessage(response)}`, {
          status: response.status,
          response,
        });
      }
      const body = (await response.json()) as { messages?: KortixMessage[]; has_more?: boolean };
      return { messages: body.messages ?? [], hasMore: body.has_more === true };
    },

    /** The conversations' statuses and the permission requests and questions waiting for an answer. */
    pending: async (): Promise<PendingInteractions> => {
      const [statuses, permissions, questions] = await Promise.all([
        client.session.status().then((r) => unwrap(r, 'Reading the session status failed')),
        client.permission.list().then((r) => unwrap(r, 'Reading permission requests failed')),
        client.question.list().then((r) => unwrap(r, 'Reading questions failed')),
      ]);
      return { statuses: statuses ?? {}, permissions: permissions ?? [], questions: questions ?? [] };
    },

    /** Answer a permission request: allow this call, allow the capability for the session, or deny. */
    answerPermission: async (requestId: string, reply: RuntimePermissionReply, message?: string): Promise<void> => {
      unwrap(
        await client.permission.reply({ requestID: requestId, reply, ...(message !== undefined ? { message } : {}) }),
        'Answering the permission request failed',
      );
    },

    /** Answer a question (one answer per question), or dismiss it with `null`. */
    answerQuestion: async (requestId: string, answers: RuntimeQuestionAnswer[] | null): Promise<void> => {
      if (answers === null) {
        unwrap(await client.question.reject({ requestID: requestId }), 'Dismissing the question failed');
        return;
      }
      unwrap(await client.question.reply({ requestID: requestId, answers }), 'Answering the question failed');
    },

    /**
     * Summarize the conversation so far into a shorter context. Uses `model`,
     * else the runtime's default model; throws an `ApiError` with code
     * `MODEL_REQUIRED` when neither names one. Resolves with the model it used.
     */
    compact: async (model?: { providerID: string; modelID: string }): Promise<{ providerID: string; modelID: string }> => {
      let chosen = model;
      if (!chosen) {
        // An unreadable config names no model: never guess one.
        const config = await client.global.config.get().then((result) => (result.error === undefined ? result.data : null));
        const reference = typeof config?.model === 'string' ? config.model : '';
        const slash = reference.indexOf('/');
        if (slash > 0 && slash < reference.length - 1) {
          chosen = { providerID: reference.slice(0, slash), modelID: reference.slice(slash + 1) };
        }
      }
      if (!chosen) throw new ApiError('Cannot compact: no model is set for this session', { code: 'MODEL_REQUIRED' });
      unwrap(
        await client.session.summarize({ sessionID: input.rootId, providerID: chosen.providerID, modelID: chosen.modelID }),
        'Compacting the session failed',
      );
      return chosen;
    },
  };
}

export type RuntimeVerbs = ReturnType<typeof createRuntimeVerbs>;
