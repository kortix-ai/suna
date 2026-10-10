/**
 * What a request to a session runtime does, read from its method and path.
 *
 * The one place the API recognizes a runtime's turn routes. Two spellings reach
 * it: the daemon's Kortix routes (`/kortix/runtime/sessions/:id/prompt|abort`,
 * also mounted at the pre-W3 `/kortix/opencode`) and OpenCode's REST routes
 * (`/session/:id/prompt_async|message|command|summarize|abort`), which web
 * and older API instances still send. Every proxy guard (turn ledger, dedupe,
 * env sync, deadline, client stop, retry budget) asks this function instead of
 * keeping its own regex.
 *
 * A LEAF: it imports nothing, so a proxy suite that replaces a module with
 * `mock.module` cannot poison it (see `projects/turn-start-request.ts`).
 */

/** The verb of a turn-starting request. `prompt` is the Kortix route. */
export type RuntimeTurnVerb = 'prompt' | 'prompt_async' | 'message' | 'command' | 'summarize';

export type RuntimeRequest =
  | {
      kind: 'turn-start';
      verb: RuntimeTurnVerb;
      runtimeSessionId: string;
      /** The in-box `/proxy/<port>` prefix the client addressed through, or `''`. */
      prefix: string;
    }
  | { kind: 'abort'; runtimeSessionId: string; prefix: string }
  | { kind: 'message-list'; runtimeSessionId: string; prefix: string }
  /** OpenCode's rewind: `revert` stages one, `unrevert` undoes it. */
  | { kind: 'revert' | 'unrevert'; runtimeSessionId: string; prefix: string }
  | { kind: 'other' };

const OTHER: RuntimeRequest = { kind: 'other' };
const PREFIX = /^\/proxy\/\d+(?=\/)/;
const KORTIX = /^\/kortix\/(?:runtime|opencode)\/sessions\/([^/?#]+)\/(prompt|abort)\/?$/;
const NATIVE = /^\/session\/([^/?#]+)\/(prompt_async|message|command|summarize|abort)(?=$|[/?#])(.*)$/;
const REWIND = /^\/session\/([^/?#]+)\/(revert|unrevert)\/?(?:$|[?#])/;

/**
 * Drop the in-box dynamic-port nesting a client may address through, so one
 * path spelling reaches every predicate: `/proxy/4096/session/<id>/abort` and
 * `/session/<id>/abort` are the same call.
 */
export function stripInBoxProxyPrefix(path: string): string {
  return path.replace(PREFIX, '');
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function classifyRuntimeRequest(method: string, path: string): RuntimeRequest {
  const verb = method.toUpperCase();
  const prefix = PREFIX.exec(path)?.[0] ?? '';
  const bare = path.slice(prefix.length);

  const kortix = KORTIX.exec(bare);
  if (kortix) {
    const runtimeSessionId = decodeSegment(kortix[1]!);
    if (verb !== 'POST' || !runtimeSessionId) return OTHER;
    return kortix[2] === 'prompt'
      ? { kind: 'turn-start', verb: 'prompt', runtimeSessionId, prefix }
      : { kind: 'abort', runtimeSessionId, prefix };
  }

  const rewind = REWIND.exec(bare);
  if (rewind) {
    const runtimeSessionId = decodeSegment(rewind[1]!);
    if (verb !== 'POST' || !runtimeSessionId) return OTHER;
    return { kind: rewind[2] === 'revert' ? 'revert' : 'unrevert', runtimeSessionId, prefix };
  }

  const native = NATIVE.exec(bare);
  if (!native) return OTHER;
  const runtimeSessionId = decodeSegment(native[1]!);
  if (!runtimeSessionId) return OTHER;
  // The route itself, not a message under it (`/session/:id/message/:messageId`).
  if (!/^\/?(?:$|[?#])/.test(native[3] ?? '')) return OTHER;
  const route = native[2] as RuntimeTurnVerb | 'abort';
  if (route === 'abort') return verb === 'POST' ? { kind: 'abort', runtimeSessionId, prefix } : OTHER;
  if (verb === 'POST') return { kind: 'turn-start', verb: route, runtimeSessionId, prefix };
  if (verb === 'GET' && route === 'message') return { kind: 'message-list', runtimeSessionId, prefix };
  return OTHER;
}

/**
 * The message identity a turn-start body carries: the client-minted wire id
 * and whether the prompt asks for no reply. The Kortix route spells them
 * `message_id` / `no_reply`, OpenCode's `messageID` / `noReply`.
 */
export function turnStartBodyFields(body: ArrayBuffer | undefined): {
  messageId: string | null;
  noReply: boolean;
} {
  if (!body?.byteLength) return { messageId: null, noReply: false };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { messageId: null, noReply: false };
    const record = parsed as Record<string, unknown>;
    const id = record.message_id ?? record.messageID;
    return {
      messageId: typeof id === 'string' && id.trim() ? id.trim() : null,
      noReply: record.no_reply === true || record.noReply === true,
    };
  } catch {
    return { messageId: null, noReply: false };
  }
}

/** The message a `POST /session/:id/revert` body rewinds to (`messageID`). */
export function revertBodyMessageId(body: ArrayBuffer | undefined): string | null {
  if (!body?.byteLength) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { messageID?: unknown } | null;
    const id = parsed?.messageID;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}
