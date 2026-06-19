import type { UpstreamDescriptor } from '../../domain';

export interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function buildUpstreamRequest(
  body: Record<string, unknown>,
  descriptor: UpstreamDescriptor,
): UpstreamRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${descriptor.apiKey}`,
  };
  if (descriptor.appName) headers['x-title'] = descriptor.appName;
  if (descriptor.appReferer) headers['http-referer'] = descriptor.appReferer;
  if (descriptor.headers) Object.assign(headers, descriptor.headers);

  return {
    url: `${trimTrailingSlash(descriptor.baseUrl)}/chat/completions`,
    headers,
    payload: body,
  };
}
