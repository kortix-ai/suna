import type { UpstreamRequest } from './openai-compat';
import type { UpstreamDescriptor } from '../domain';

export interface Transport {
  buildRequest(body: Record<string, unknown>, descriptor: UpstreamDescriptor): UpstreamRequest;
  translateResponse(response: Response, ctx: { streaming: boolean }): Response | Promise<Response>;
}
