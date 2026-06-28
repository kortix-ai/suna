import type { UpstreamDescriptor } from '../../domain';

export interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
}

function trimTrailingSlash(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return url.slice(0, end);
}

export function buildUpstreamRequest(
  body: Record<string, unknown>,
  descriptor: UpstreamDescriptor,
): UpstreamRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (!descriptor.omitAuthorization) headers.authorization = `Bearer ${descriptor.apiKey}`;
  if (descriptor.appName) headers['x-title'] = descriptor.appName;
  if (descriptor.appReferer) headers['http-referer'] = descriptor.appReferer;
  if (descriptor.headers) Object.assign(headers, descriptor.headers);

  return {
    url: `${trimTrailingSlash(descriptor.baseUrl)}/chat/completions`,
    headers,
    payload: descriptor.resolvedModel ? { ...body, model: descriptor.resolvedModel } : body,
  };
}
