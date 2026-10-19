import { uiHostEnv } from '@kortix/ui/lib/host-env';

/** API base (already includes the /v1 suffix), e.g. https://api.kortix.com/v1. */
export function setupLinkApiBase(): string {
  return (uiHostEnv().backendUrl || 'http://localhost:8008/v1').replace(/\/+$/, '');
}
