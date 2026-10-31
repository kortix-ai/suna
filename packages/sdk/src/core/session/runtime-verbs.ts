/**
 * The session verbs a host calls instead of the raw runtime client: read the
 * transcript, read what the agent waits on, answer it, compact. Each verb is
 * bound to one session's runtime URL and root conversation, and throws an
 * `ApiError` when the runtime refuses.
 *
 * `messages()` reads the Kortix transcript route (`/kortix/runtime/messages`).
 * The answers, `compact()` and `pendingRequests()` use the session-log action
 * routes on a box that lists `runtime.actions.v1`, and the runtime's
 * compatibility routes on an older one. A host never needs to know which.
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
import {
  runtimeActionError,
  runtimeActionPaths,
  runtimeServesActions,
  type RuntimeLogPage,
  type RuntimePending,
  type RuntimePendingRecord,
} from './runtime-actions';

/** The most messages kortixd answers in one transcript page (`MAX_MESSAGE_PAGE`). */
const MESSAGE_PAGE_MAX = 200;

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

/** A compatibility status as a thread status: a retry is still the turn running. */
function threadStatus(status: KortixSessionStatus): RuntimePending['statuses'][string] {
  return status.type === 'idle' ? 'idle' : 'busy';
}

export function createRuntimeVerbs(input: RuntimeVerbsInput) {
  const base = input.runtimeUrl.replace(/\/$/, '');
  const client = createRuntimeRestClient({ baseUrl: base, fetch: input.fetch });
  const native = () => runtimeServesActions(base, input.fetch);

  /** One action-route request; a refusal throws an `ApiError` with the runtime's message. */
  const action = async <T = unknown>(method: string, path: string, body: unknown, what: string): Promise<T> => {
    const response = await input.fetch(
      new Request(`${base}${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      }),
    );
    if (!response.ok) {
      throw new ApiError(`${what}: ${await errorMessage(response)}`, { status: response.status, response });
    }
    return (await response.json().catch(() => null)) as T;
  };

  /** Each thread's status and the open requests, from the action route or the compatibility lists. */
  const pendingRequests = async (): Promise<RuntimePending> => {
    if (await native()) return action<RuntimePending>('GET', runtimeActionPaths.pending, undefined, 'Reading the pending requests failed');
    const [statuses, permissions, questions] = await Promise.all([
      client.session.status().then((r) => unwrap(r, 'Reading the session status failed')),
      client.permission.list().then((r) => unwrap(r, 'Reading permission requests failed')),
      client.question.list().then((r) => unwrap(r, 'Reading questions failed')),
    ]);
    const record = (
      request: { id: string; sessionID: string; tool?: { callID: string } },
      payload: unknown,
    ): RuntimePendingRecord => ({
      id: request.id,
      thread_id: request.sessionID,
      ...(request.tool?.callID ? { call_id: request.tool.callID } : {}),
      payload,
      asked_at: '',
    });
    return {
      statuses: Object.fromEntries(Object.entries(statuses ?? {}).map(([id, status]) => [id, threadStatus(status)])),
      permissions: (permissions ?? []).map((p) =>
        record(p, { permission: p.permission, patterns: p.patterns, always: p.always, metadata: p.metadata }),
      ),
      questions: (questions ?? []).map((q) => record(q, { questions: q.questions })),
    };
  };

  return {
    /**
     * A page of a conversation's messages, oldest first: the root by default,
     * or `conversationId` (a subagent child). `before` pages backwards; a
     * `limit` above the daemon's 200-message page is read in several pages.
     */
    messages: async (
      options: { conversationId?: string; limit?: number; before?: string; signal?: AbortSignal } = {},
    ): Promise<TranscriptPage> => {
      const conversation = encodeURIComponent(options.conversationId ?? input.rootId);
      const readPage = async (limit: number | undefined, before: string | undefined) => {
        const query = new URLSearchParams();
        if (limit !== undefined) query.set('limit', String(limit));
        if (before) query.set('before', before);
        const suffix = `/messages/${conversation}${query.size ? `?${query}` : ''}`;
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
      };
      // The daemon serves at most MESSAGE_PAGE_MAX a page: a larger limit pages
      // backwards from the newest, and the pages join oldest first.
      let page = await readPage(options.limit === undefined ? undefined : Math.min(options.limit, MESSAGE_PAGE_MAX), options.before);
      const messages = [...page.messages];
      while (options.limit !== undefined && messages.length < options.limit && page.hasMore && messages.length > 0) {
        page = await readPage(Math.min(options.limit - messages.length, MESSAGE_PAGE_MAX), messages[0]!.info.id);
        if (!page.messages.length) break;
        messages.unshift(...page.messages);
      }
      return { messages, hasMore: page.hasMore };
    },

    /**
     * The conversations' statuses and the permission requests and questions waiting for an answer.
     * @deprecated Read `pendingRequests()`, which answers in session-log terms on every runtime.
     */
    pending: async (): Promise<PendingInteractions> => {
      const [statuses, permissions, questions] = await Promise.all([
        client.session.status().then((r) => unwrap(r, 'Reading the session status failed')),
        client.permission.list().then((r) => unwrap(r, 'Reading permission requests failed')),
        client.question.list().then((r) => unwrap(r, 'Reading questions failed')),
      ]);
      return { statuses: statuses ?? {}, permissions: permissions ?? [], questions: questions ?? [] };
    },

    /** Each thread's status and the permission requests and questions that wait on a person. */
    pendingRequests,

    /**
     * One page of a thread of the box's own session log, ahead of the stored log while a turn
     * runs: the root by default, the newest `limit` before `before_seq`. Null on a box without
     * the session-log actions: read the stored log instead.
     */
    liveLog: async (query: { thread?: string; before_seq?: number; limit?: number } = {}): Promise<RuntimeLogPage | null> => {
      if (!(await native())) return null;
      const params = new URLSearchParams();
      if (query.thread) params.set('thread', query.thread);
      if (query.before_seq !== undefined) params.set('before_seq', String(query.before_seq));
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      const suffix = params.size ? `?${params}` : '';
      return action<RuntimeLogPage>('GET', `/kortix/runtime/log${suffix}`, undefined, 'Reading the session log failed');
    },

    /** Answer a permission request: allow this call, allow the capability for the session, or deny. */
    answerPermission: async (requestId: string, reply: RuntimePermissionReply, message?: string): Promise<void> => {
      if (await native()) {
        await action('POST', runtimeActionPaths.permissionReply(requestId), { reply, ...(message !== undefined ? { message } : {}) }, 'Answering the permission request failed');
        return;
      }
      unwrap(
        await client.permission.reply({ requestID: requestId, reply, ...(message !== undefined ? { message } : {}) }),
        'Answering the permission request failed',
      );
    },

    /** Answer a question (one answer per question), or dismiss it with `null`. */
    answerQuestion: async (requestId: string, answers: RuntimeQuestionAnswer[] | null): Promise<void> => {
      if (await native()) {
        await (answers === null
          ? action('POST', runtimeActionPaths.questionReject(requestId), undefined, 'Dismissing the question failed')
          : action('POST', runtimeActionPaths.questionReply(requestId), { answers }, 'Answering the question failed'));
        return;
      }
      if (answers === null) {
        unwrap(await client.question.reject({ requestID: requestId }), 'Dismissing the question failed');
        return;
      }
      unwrap(await client.question.reply({ requestID: requestId, answers }), 'Answering the question failed');
    },

    /**
     * Summarize the conversation so far into a shorter context. Uses `model`,
     * else the model the runtime runs (its `kortix.runtime.v1` state document);
     * throws an `ApiError` with code `MODEL_REQUIRED` when neither names one.
     * Resolves with the model it used.
     */
    compact: async (model?: { providerID: string; modelID: string }): Promise<{ providerID: string; modelID: string }> => {
      let chosen = model;
      if (!chosen) {
        // An unreadable state document names no model: never guess one.
        const state = await input
          .fetch(new Request(`${base}/kortix/runtime/state`, { method: 'GET' }))
          .then((response) => (response.ok ? (response.json() as Promise<{ config?: { value?: { model?: unknown } | null } }>) : null))
          .catch(() => null);
        const reference = typeof state?.config?.value?.model === 'string' ? state.config.value.model : '';
        const slash = reference.indexOf('/');
        if (slash > 0 && slash < reference.length - 1) {
          chosen = { providerID: reference.slice(0, slash), modelID: reference.slice(slash + 1) };
        }
      }
      if (!chosen) throw new ApiError('Cannot compact: no model is set for this session', { code: 'MODEL_REQUIRED' });
      const busy = () =>
        new ApiError('This session is busy. Wait for the current turn to finish, then run compact again.', {
          code: 'SESSION_BUSY',
          status: 409,
        });
      // A turn that started after the status read can outlast the proxy. Say so
      // without the proxy's internal diagnostic, and never resubmit.
      const unfinished = (status?: number) =>
        new ApiError('Compaction has not finished. Check the session status before trying again.', {
          code: 'LONG_TURN_PROXY_TIMEOUT', status,
        });
      if (await native()) {
        const { statuses } = await pendingRequests();
        const status = statuses[input.rootId];
        if (status && status !== 'idle') throw busy();
        const response = await input.fetch(new Request(`${base}${runtimeActionPaths.compact(input.rootId)}`, { method: 'POST' }));
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          let code: unknown;
          try {
            code = (JSON.parse(text) as { code?: unknown }).code;
          } catch {
            // Not JSON: no code.
          }
          if (code === 'LONG_TURN_PROXY_TIMEOUT') throw unfinished(response.status);
          throw await runtimeActionError(new Response(text, { status: response.status }), 'Compacting the session failed');
        }
        return chosen;
      }
      const statuses = unwrap(await client.session.status(), 'Reading the session status failed');
      const status = statuses?.[input.rootId];
      if (status && status.type !== 'idle') throw busy();
      const result = await client.session.summarize({
        sessionID: input.rootId, providerID: chosen.providerID, modelID: chosen.modelID,
      });
      if (result.error && typeof result.error === 'object' && 'code' in result.error
        && result.error.code === 'LONG_TURN_PROXY_TIMEOUT') {
        throw unfinished(result.response?.status);
      }
      unwrap(result, 'Compacting the session failed');
      return chosen;
    },
  };
}

export type RuntimeVerbs = ReturnType<typeof createRuntimeVerbs>;
