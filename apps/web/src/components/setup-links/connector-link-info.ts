'use client';

// Moved to `@kortix/sdk` (KRTX-1012): the cache policy lives in the SDK core
// and the hook in the SDK react glue. This shim keeps the old host import path
// resolving and injects the host's adapters — the API base and the browser's
// storage — so call sites are unchanged.

import {
  useConnectorLinkInfo as useSdkConnectorLinkInfo,
} from '@kortix/sdk/react';
import type { ConnectorSetupLinkInfo } from '@kortix/sdk';

import { browserLinkInfoStorage, setupLinkApiBase } from './util';

export { connectorHeadline } from '@kortix/sdk';

export function useConnectorLinkInfo(
  token: string | null,
): ConnectorSetupLinkInfo | null | undefined {
  return useSdkConnectorLinkInfo(token, {
    backendUrl: setupLinkApiBase(),
    storage: browserLinkInfoStorage(),
  });
}
