import type { UpstreamDescriptor } from '../domain';
import { ClientAbortError, UpstreamMisconfiguredError } from '../errors';
import type { AiSdkFetch } from '../transports/ai-sdk';
import { resolveTransportKind } from '../transports/route-kind';

export type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

export interface CallUpstreamOptions {
  fetchImpl?: FetchImpl;
  /** Inbound client's abort signal — combined with the per-attempt timeout
   *  signal so a caller disconnect aborts the in-flight upstream fetch too,
   *  instead of only bounding it by the retry timeout. */
  signal?: AbortSignal;
  // Kortix-internal correlation id for this request (see pipeline/handler.ts's
  // newRequestId()). Sent to the upstream as a best-effort header so a failed
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

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.replace(/\/+$/, '') : value;
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

  let payload = body;
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
    return directOpenAiRequest(body, descriptor, opts);
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
