/**
 * Sandbox URL detection / rewriting / proxy utilities.
 *
 * Moved into the SDK — this is a thin re-export of `@kortix/sdk`,
 * the single source of truth, verified against the current Sandbox Agent
 * Server's `/proxy/:port` + `/web-proxy` surface. Import from here or directly
 * from `@kortix/sdk`.
 */
export {
  buildWebProxyUrl,
  detectLocalhostUrls,
  getProxyBaseUrl,
  hasPreviewTarget,
  isAppRouteUrl,
  isExternalUrl,
  isInternalLocalhostUrl,
  isPreviewUrl,
  isProxiableLocalhostUrl,
  isWebProxyUrl,
  normalizeExternalInput,
  parseLocalhostUrl,
  parseWebProxyUrl,
  proxyLocalhostUrl,
  proxyUrlToInternal,
  rewriteLocalhostUrl,
  toInternalUrl,
  type DetectedLocalhostUrl,
} from '@kortix/sdk';
