/**
 * Where in a Kortix session a model request comes from.
 *
 * kortixd stamps every model call with the message it produces
 * (`x-kortix-message-id`), the prompt that started the turn
 * (`x-kortix-turn-id`) and, for an in-box subagent, the child runtime session
 * (`x-kortix-thread-id`). The trace stores them in `metadata`, so a request log
 * links to the exact message. The session itself comes from the token, never
 * from a header: these only point inside a session the caller already owns.
 */
export interface RequestOrigin {
  messageId?: string;
  turnId?: string;
  threadId?: string;
}

export const REQUEST_ORIGIN_HEADERS = {
  messageId: 'x-kortix-message-id',
  turnId: 'x-kortix-turn-id',
  threadId: 'x-kortix-thread-id',
} as const;

/** An id, not free text: anything else is dropped. */
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The origin a request's headers name; `undefined` when they name none. */
export function readRequestOrigin(header: (name: string) => string | null | undefined): RequestOrigin | undefined {
  const origin: RequestOrigin = {};
  for (const [key, name] of Object.entries(REQUEST_ORIGIN_HEADERS) as [keyof RequestOrigin, string][]) {
    const value = header(name)?.trim();
    if (value && ID.test(value)) origin[key] = value;
  }
  return Object.keys(origin).length ? origin : undefined;
}
