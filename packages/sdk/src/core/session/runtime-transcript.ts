/**
 * The transcript read: one page of a conversation's messages, oldest first,
 * paged backwards from the newest. The route lives on the session's runtime —
 * this is the read half of the runtime verbs, split out so the transport
 * verbs stay one concern per module.
 *
 * A daemon built before W3 serves the read at its OpenCode name; a host never
 * needs to know which. Throws an `ApiError` when the runtime refuses.
 */
import { ApiError } from '../http/api/errors';
import type { KortixMessage } from '../runtime/transcript-types';

/** The most messages kortixd answers in one transcript page (`MAX_MESSAGE_PAGE`). */
const MESSAGE_PAGE_MAX = 200;

/** The session coordinates the transcript read is bound to. */
export interface TranscriptReaderInput {
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

/** The most readable message a runtime error response carries, for an ApiError's text. */
export async function errorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { error?: string; message?: string; data?: { message?: string } };
    return body.data?.message || body.error || body.message || text || `HTTP ${response.status}`;
  } catch {
    return text || `HTTP ${response.status}`;
  }
}

/** The transcript reader for one session: `messages(options)` pages the conversation. */
export function createTranscriptReader(input: TranscriptReaderInput) {
  const base = input.runtimeUrl.replace(/\/$/, '');

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
  };
}
