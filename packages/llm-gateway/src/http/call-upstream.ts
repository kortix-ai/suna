import type { TranslationSidecarConfig, UpstreamDescriptor } from '../domain';
import { ClientAbortError, NetworkError, UpstreamHttpError } from '../errors';
import { type BreakerBinding, type RetryOptions, withResilience } from '../resilience';
import { transportFor } from '../transports';
import { resolveTransportKind } from '../transports/route-kind';
import { buildSidecarRequest, isSidecarEligible } from '../transports/sidecar';

export type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

export interface CallUpstreamOptions {
  retry?: RetryOptions;
  binding?: BreakerBinding;
  fetchImpl?: FetchImpl;
  /** See GatewayConfig.translationSidecar. Unset = direct upstream (current behavior). */
  translationSidecar?: TranslationSidecarConfig;
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

export async function callUpstream(
  body: Record<string, unknown>,
  descriptor: UpstreamDescriptor,
  opts: CallUpstreamOptions = {},
): Promise<Response> {
  const fetchImpl: FetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  // Resolved per-request (not just from the descriptor's static `kind`): a
  // genuine-OpenAI reasoning model with function tools + a live reasoning
  // effort must go out over the Responses API even though descriptor
  // resolution (apps/api's resolveCandidates, which doesn't see the body)
  // labeled it 'openai-compat' — see route-kind.ts. Every other request keeps
  // the descriptor's own kind unchanged.
  const kind = resolveTransportKind(body, descriptor);
  const transport = transportFor(kind);
  const direct = transport.buildRequest(body, descriptor);
  const request =
    opts.translationSidecar &&
    isSidecarEligible({ kind, omitAuthorization: descriptor.omitAuthorization })
      ? buildSidecarRequest(direct, descriptor, opts.translationSidecar)
      : direct;
  if (opts.requestId) {
    request.headers = { ...request.headers, 'x-kortix-request-id': opts.requestId };
  }
  const streaming = body.stream === true;
  const clientSignal = opts.signal;

  const raw = await withResilience(
    async (attemptSignal) => {
      if (clientSignal?.aborted) throw new ClientAbortError();
      // Combine the per-attempt timeout controller with the inbound client's
      // signal so either one aborts this fetch — `AbortSignal.any` is a plain
      // union, so whichever fires first wins and the other is simply unused.
      const signal = clientSignal ? AbortSignal.any([attemptSignal, clientSignal]) : attemptSignal;
      let response: Response;
      try {
        response = await fetchImpl(request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(request.payload),
          signal,
        });
      } catch (err) {
        // Disambiguate WHY the fetch aborted: a client disconnect must never be
        // retried/failed-over (there's no one left to serve), unlike a genuine
        // upstream timeout or network failure.
        if (clientSignal?.aborted) throw new ClientAbortError();
        throw new NetworkError(`fetch to ${descriptor.provider} failed`, err);
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new UpstreamHttpError(response.status, text, descriptor.provider);
      }
      return response;
    },
    opts.retry ?? {},
    opts.binding,
  );

  return transport.translateResponse(raw, { streaming, descriptor });
}
