import { platformConfig, stripTrailingSlashes } from '@kortix/sdk';

/** API base (already includes the /v1 suffix), e.g. https://api.kortix.com/v1. */
export function setupLinkApiBase(): string {
  return stripTrailingSlashes(platformConfig().backendUrl || 'http://localhost:8008/v1');
}
