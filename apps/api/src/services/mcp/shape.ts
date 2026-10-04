/**
 * Pure helpers of the MCP tools, split from index.ts so a unit test can import
 * them without the API's environment: path guard, route search, transcript shaping.
 */

/** Paths a tool may not reach: the OAuth server and the MCP endpoint itself. */
export function blockedPath(path: string): boolean {
  const p = path.toLowerCase();
  return p.startsWith('/v1/oauth') || /\/mcp(\/|$)/.test(p.split('?')[0]!);
}

/**
 * The path the API router will see: dot segments resolved, percent-escapes
 * decoded, duplicate slashes merged. `null` when it is not valid. Guards run
 * on this, never on the caller's spelling (`/v1/%6fauth`, `/v1/x/../oauth`).
 */
export function canonicalPath(path: string): string | null {
  try {
    let p = new URL(path, 'http://x').pathname;
    for (let i = 0; i < 2; i++) p = new URL(decodeURIComponent(p), 'http://x').pathname;
    return p.replace(/\/{2,}/g, '/');
  } catch {
    return null;
  }
}

// ─── Route search ───────────────────────────────────────────────────────────

export type Operation = { method: string; path: string; summary: string; description: string; tags: string[]; spec: any };

const STOPWORDS = new Set(['the', 'for', 'and', 'all', 'how', 'with', 'from', 'into', 'can', 'you', 'are', 'this', 'that', 'its', 'our']);
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Terms of 3+ letters, no stopwords, matched as whole words or word prefixes (`secret` finds `secrets`). */
export function searchOperations(ops: Operation[], query: string, limit: number): Operation[] {
  const terms = words(query)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
    .map((t) => (t.length > 3 ? t.replace(/s$/, '') : t));
  if (terms.length === 0) return [];
  const has = (ws: string[], t: string) => ws.some((w) => w.startsWith(t));
  return ops
    .map((op) => {
      const path = words(op.path);
      const summary = words(op.summary);
      const rest = words(`${op.tags.join(' ')} ${op.description}`);
      let score = 0;
      for (const term of terms) {
        if (has(path, term)) score += 3;
        if (has(summary, term)) score += 2;
        if (has(rest, term)) score += 1;
      }
      return { op, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.op.path.length - b.op.path.length)
    .slice(0, limit)
    .map((x) => x.op);
}

// ─── read_session result ────────────────────────────────────────────────────

/** A tool result is cut at 60 000 chars; leave room for the wrapper. */
const TRANSCRIPT_BUDGET_CHARS = 58_000;

type WireMessage = { role?: string; error?: any } & Record<string, unknown>;

/** The API's error is `{name, data:{message, statusCode, responseHeaders, …}}`: keep name and message. */
function trimError(error: any): { name?: string; message?: string } | null {
  if (!error || typeof error !== 'object') return null;
  const message = error.data?.message ?? error.message;
  return { name: error.name, message: typeof message === 'string' ? message.slice(0, 500) : undefined };
}

/**
 * The read_session result as compact JSON that always parses: when the
 * messages do not fit, the OLDEST are dropped (`omitted_older`), never the newest.
 */
export function shapeTranscript(
  summary: Record<string, unknown>,
  t: { source?: unknown; reason?: unknown; messages?: WireMessage[]; message_count?: unknown; complete?: unknown },
  budget = TRANSCRIPT_BUDGET_CHARS,
): string {
  const messages = (t.messages ?? []).map((m) => ({ ...m, error: trimError(m.error) }));
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const build = (from: number) =>
    JSON.stringify({
      ...summary,
      last_turn_error: lastAssistant?.error ?? null,
      transcript_source: t.source,
      transcript_note: t.reason ?? undefined,
      message_count: t.message_count,
      complete: t.complete,
      omitted_older: from > 0 ? from : undefined,
      messages: messages.slice(from),
    });
  let from = 0;
  let out = build(from);
  while (out.length > budget && from < messages.length - 1) out = build(++from);
  return out;
}

// ─── describe_api ───────────────────────────────────────────────────────────

/**
 * What `describe_api` prints as a route's request body. A typed body from
 * `lenientBody` is `anyOf: [{object, properties}, {object, additionalProperties}]`:
 * the last branch is a validation fallback, not a second shape, so only the
 * first shows. A body that is not JSON prints its content type.
 */
export function requestBodyShape(requestBody: any): unknown {
  const content = requestBody?.content;
  if (!content) return undefined;
  const json = content['application/json']?.schema;
  if (!json) {
    const type = Object.keys(content)[0];
    return type ? { contentType: type } : undefined;
  }
  const branches = Array.isArray(json.anyOf) ? json.anyOf : null;
  const fallback = branches?.[branches.length - 1];
  const bare = fallback?.type === 'object' && !fallback.properties && fallback.additionalProperties !== undefined;
  return branches && branches.length > 1 && bare ? { ...branches[0], additionalProperties: true } : json;
}
