import { NetworkError, UpstreamHttpError } from '../errors';
import { withResilience, type BreakerBinding, type RetryOptions } from '../resilience';
import { transportFor } from '../transports';
import { buildSidecarRequest, isSidecarEligible } from '../transports/sidecar';
import type { TranslationSidecarConfig, UpstreamDescriptor } from '../domain';

export type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

export interface CallUpstreamOptions {
  retry?: RetryOptions;
  binding?: BreakerBinding;
  fetchImpl?: FetchImpl;
  /** See GatewayConfig.translationSidecar. Unset = direct upstream (current behavior). */
  translationSidecar?: TranslationSidecarConfig;
}

export async function callUpstream(
  body: Record<string, unknown>,
  descriptor: UpstreamDescriptor,
  opts: CallUpstreamOptions = {},
): Promise<Response> {
  const fetchImpl: FetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const transport = transportFor(descriptor.kind);
  const direct = transport.buildRequest(body, descriptor);
  const request =
    opts.translationSidecar && isSidecarEligible(descriptor)
      ? buildSidecarRequest(direct, descriptor, opts.translationSidecar)
      : direct;
  const streaming = body.stream === true;

  const raw = await withResilience(
    async (signal) => {
      let response: Response;
      try {
        response = await fetchImpl(request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(request.payload),
          signal,
        });
      } catch (err) {
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
