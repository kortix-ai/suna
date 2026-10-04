import type { UpstreamDescriptor } from '../domain';
import { ClientAbortError, UpstreamHttpError, UpstreamMisconfiguredError } from '../errors';
import type { AiSdkFetch } from '../transports/ai-sdk';
import { resolveTransportKind } from '../transports/route-kind';
// The SHARED implementation. This module carried its own copy using
// `value.replace(/\/+$/, '')`, which CodeQL flags as `js/polynomial-redos`
// (high, alert #5907): on a long run of slashes that is not at the end, the
// engine retries the quantifier from every start position. The copy in
// transports/ai-sdk/model.ts was rewritten to a linear charCodeAt loop for
// alert #4731; this one was missed because the logic was duplicated. Importing
// it means there is one implementation to keep correct.
import { trimTrailingSlash } from '../transports/ai-sdk/model';

export type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

export interface CallUpstreamOptions {
  fetchImpl?: FetchImpl;
  /** Inbound client's abort signal — combined with the per-attempt timeout
   *  signal so a caller disconnect aborts the in-flight upstream fetch too,
   *  instead of only bounding it by the retry timeout. */
  signal?: AbortSignal;
  // Kortix-internal correlation id for this request (see pipeline/simple-handler.ts's
  // requestId()). Sent to the upstream as a best-effort header so a failed
  // or slow completion can be cross-referenced against the provider's own
  // request logs/support tooling — every provider here tolerates unknown
  // headers, so this is safe to always send rather than gated per-transport.
  requestId?: string;
}

// The AI SDK provider packages build their outgoing request straight from
// `descriptor.baseUrl` — a required `string` on the type, but TypeScript
// can't stop that string from being empty or unparseable at runtime. Left
// unchecked, a blank baseUrl reaches deep inside a provider SDK/fetch call
// before failing with an opaque "Invalid URL" — and for the STREAMING path
// specifically, that failure never even throws: it surfaces as a 200-status
// SSE stream carrying an in-band `error` frame (see UpstreamMisconfiguredError's
// doc comment in errors.ts). Every descriptor this gateway resolves today
// (apps/api's resolveCandidates, which is provider-keyed — see
// provider-registry.ts's resolveCatalogUpstream — never per-model) already
// carries a real baseUrl, so this never fires in practice; it exists purely
// as a fail-fast, correctly-classified backstop against a FUTURE resolution
// regression (a different host's resolveUpstream hook, a new provider kind,
// ...) instead of letting a bad descriptor reach the transport at all.
function assertUsableBaseUrl(descriptor: UpstreamDescriptor): void {
  const baseUrl = descriptor.baseUrl?.trim();
  if (!baseUrl) {
    throw new UpstreamMisconfiguredError(descriptor.provider || 'unknown', 'missing baseUrl');
  }
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('not http(s)');
    }
  } catch {
    throw new UpstreamMisconfiguredError(
      descriptor.provider || 'unknown',
      `invalid baseUrl "${descriptor.baseUrl}"`,
    );
  }
}

// Adapts `FetchImpl` (this package's own, `(input: string, init: RequestInit)`)
// to the AI SDK provider packages' `fetch` override (`typeof globalThis.fetch`,
// `input?: RequestInfo | URL`, `init?: RequestInit`) so a caller-supplied
// fetchImpl (production middleware, or a test double — see CallUpstreamOptions)
// is honored on the ai-sdk engine exactly like it was on the retired native
// transport's direct `fetch()` call.
function toAiSdkFetch(fetchImpl: FetchImpl): AiSdkFetch {
  return (input, init) => fetchImpl(String(input), init ?? {});
}

// OpenRouter extensions that a strict OpenAI-schema upstream (OpenCode Zen)
// answers with 400 "Extra inputs are not permitted" (probed 2026-10-01).
// Clients replay them after an OpenRouter turn; the Responses ingress sends `reasoning`.
const NON_OPENAI_BODY_FIELDS = ['reasoning', 'usage', 'provider', 'transforms', 'verbosity', 'modalities', 'safety_identifier'];

function toStrictChat(body: Record<string, any>): Record<string, unknown> {
  const out = { ...body };
  if (out.reasoning_effort === undefined && typeof out.reasoning?.effort === 'string') out.reasoning_effort = out.reasoning.effort;
  for (const field of NON_OPENAI_BODY_FIELDS) delete out[field];
  if (!Array.isArray(out.messages)) return out;
  out.messages = out.messages.map(({ reasoning, reasoning_details, annotations, ...message }: Record<string, any>) => {
    const details = Array.isArray(reasoning_details) ? reasoning_details.map((d) => d?.text ?? '').join('') : '';
    const prior = details || (typeof reasoning === 'string' ? reasoning : '');
    if (message.reasoning_content === undefined && prior) message.reasoning_content = prior;
    if (Array.isArray(message.content)) message.content = message.content.map(({ cache_control, ...part }: Record<string, unknown>) => part);
    return message;
  });
  return out;
}

function directOpenAiRequest(
  body: Record<string, unknown>,
  descriptor: UpstreamDescriptor,
  opts: CallUpstreamOptions,
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (!descriptor.omitAuthorization) headers.authorization = `Bearer ${descriptor.apiKey}`;
  if (descriptor.appName) headers['x-title'] = descriptor.appName;
  if (descriptor.appReferer) headers['http-referer'] = descriptor.appReferer;
  if (descriptor.headers) Object.assign(headers, descriptor.headers);
  if (opts.requestId) headers['x-request-id'] = opts.requestId;

  let payload = descriptor.strictChatSchema ? toStrictChat(body) : body;
  if (descriptor.bodyExtras) payload = { ...payload, ...descriptor.bodyExtras };
  if (descriptor.resolvedModel) payload = { ...payload, model: descriptor.resolvedModel };

  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  return fetchImpl(`${trimTrailingSlash(descriptor.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: opts.signal,
  });
}

/**
 * How long a direct stream may send only SSE comments before the gateway
 * answers the client anyway. OpenRouter answers 200 at once, sends
 * `: OPENROUTER PROCESSING` through a prefill, and reports an endpoint's
 * rejection as the first `data:` frame (a context overflow arrived within about
 * 1 s of the headers on 2026-09-30). The client's headers wait at most this
 * long; the Cloudflare response deadline in front of the API is 100 s.
 */
export const DIRECT_STREAM_COMMIT_MS = 10_000;

// Comment bytes read without a `data:` frame before the stream is committed anyway.
const DIRECT_STREAM_PEEK_MAX_CHARS = 64 * 1024;

/**
 * Reads a streamed direct response up to its first `data:` frame, for at most
 * `commitAfterMs`. An error frame there served nothing, so it throws the
 * `UpstreamHttpError` a non-2xx answer throws: dispatch fails over, and the
 * client gets an HTTP error. OpenCode compacts on a 400
 * `context_length_exceeded` and retries a 429; an in-band error frame is an
 * UnknownError to it, and the turn ends. Any other first frame, a timeout, a
 * client abort, or EOF returns a response that replays the bytes read and
 * continues the body, as the AI SDK transport's `openStream` does for its own
 * streams. The relay then settles a stopped prefill as it always did.
 */
export async function openDirectStream(
  response: Response,
  provider: string,
  { commitAfterMs = DIRECT_STREAM_COMMIT_MS, signal }: { commitAfterMs?: number; signal?: AbortSignal } = {},
): Promise<Response> {
  if (!response.ok || !response.body) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const read: Uint8Array[] = [];
  let text = '';
  let inFlight: ReturnType<typeof reader.read> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const commit = new Promise<'commit'>((resolve) => {
    timer = setTimeout(() => resolve('commit'), signal?.aborted ? 0 : commitAfterMs);
    signal?.addEventListener('abort', () => resolve('commit'), { once: true });
  });
  try {
    while (text.length <= DIRECT_STREAM_PEEK_MAX_CHARS) {
      const reading = reader.read();
      inFlight = reading;
      const next = await Promise.race([reading, commit]);
      if (next === 'commit') {
        // The replay below hands this read to the relay, which handles its result.
        reading.catch(() => {});
        break;
      }
      inFlight = null;
      if (next.done) break;
      read.push(next.value);
      text += decoder.decode(next.value, { stream: true });
      const complete = text.slice(0, text.lastIndexOf('\n') + 1);
      const line = complete.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      let error: { code?: unknown } | undefined;
      try {
        error = (JSON.parse(payload) as { error?: { code?: unknown } }).error;
      } catch {
        // `[DONE]` or a non-JSON frame: not an error frame.
      }
      if (error && typeof error === 'object') {
        await reader.cancel().catch(() => {});
        const code = Number(error.code);
        throw new UpstreamHttpError(code >= 400 && code <= 599 ? code : 502, payload, provider);
      }
      break;
    }
  } finally {
    clearTimeout(timer);
  }
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = read.shift();
        if (chunk) return controller.enqueue(chunk);
        const next = await (inFlight ?? reader.read());
        inFlight = null;
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel: (reason) => reader.cancel(reason),
    }),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
}

export async function callUpstream(
  body: Record<string, unknown>,
  descriptor: UpstreamDescriptor,
  opts: CallUpstreamOptions = {},
): Promise<Response> {
  assertUsableBaseUrl(descriptor);

  const clientSignal = opts.signal;
  // A caller already gone before dispatch even starts must never spend a
  // fetch/retry/breaker-trip on a response no one will receive.
  if (clientSignal?.aborted) throw new ClientAbortError();

  const transportKind = resolveTransportKind(body, descriptor);
  if (transportKind === 'openai-compat' || transportKind === 'custom') {
    const streaming = body.stream === true;
    const response = await directOpenAiRequest(body, descriptor, opts);
    return streaming ? openDirectStream(response, descriptor.provider, { signal: clientSignal }) : response;
  }

  const fetchImpl: AiSdkFetch | undefined = opts.fetchImpl
    ? toAiSdkFetch(opts.fetchImpl)
    : undefined;

  try {
    const { callUpstreamViaAiSdk } = await import('../transports/ai-sdk');
    return await callUpstreamViaAiSdk(body, descriptor, {
      signal: clientSignal,
      fetch: fetchImpl,
      requestId: opts.requestId,
    });
  } catch (err) {
    if (clientSignal?.aborted) throw new ClientAbortError();
    throw err;
  }
}
