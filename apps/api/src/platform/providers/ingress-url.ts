import type { ResolvedSandboxIngress } from './index';

/**
 * The upstream URL for one proxied request: the provider's ingress origin plus
 * the client's path and query.
 *
 * `queryToken` exists for an upstream that reads a credential from a query
 * parameter BEFORE its header form. Platinum's edge reads `?t=` first, then the
 * `x-pt-preview-token` header, and strips every `t` before it forwards. A client
 * request that already carries its own `t` (Vite's HMR cache-buster, for one)
 * would otherwise be read as the credential and refused. Only in that case the
 * provider's token goes FIRST in the query, so the edge verifies it and strips
 * both. Every other request carries the token in the header only, which keeps
 * it out of URLs and logs.
 */
export function ingressTargetUrl(
  ingress: Pick<ResolvedSandboxIngress, 'url' | 'queryToken'>,
  pathAndQuery: string,
): string {
  const target = ingress.url.replace(/\/$/, '') + pathAndQuery;
  const queryToken = ingress.queryToken;
  if (!queryToken) return target;
  const queryStart = target.indexOf('?');
  if (queryStart < 0) return target;
  const hashStart = target.indexOf('#', queryStart);
  const query = target.slice(queryStart + 1, hashStart < 0 ? undefined : hashStart);
  if (!new URLSearchParams(query).has(queryToken.name)) return target;
  const credential = new URLSearchParams([[queryToken.name, queryToken.value]]).toString();
  const hash = hashStart < 0 ? '' : target.slice(hashStart);
  return `${target.slice(0, queryStart)}?${credential}&${query}${hash}`;
}
