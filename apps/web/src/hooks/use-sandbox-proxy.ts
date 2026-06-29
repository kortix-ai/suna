'use client';

import { useCallback, useMemo } from 'react';

import {
  createSandboxProxyContext,
  getSandboxServiceUrl,
  proxySandboxUrl,
  rewriteSandboxPath,
} from '@/lib/utils/sandbox-proxy';

export function useSandboxProxy() {
  // The proxy context is derived entirely from the active runtime (its opencode
  // URL + sandbox id). There is a single runtime per session, so this is stable
  // for the lifetime of the consuming component.
  const context = useMemo(() => createSandboxProxyContext(), []);

  const proxyUrl = useCallback(
    (url: string | undefined) => proxySandboxUrl(url, context),
    [context],
  );

  const rewritePortPath = useCallback(
    (port: number, path: string) => rewriteSandboxPath(port, path, context),
    [context],
  );

  const getServiceUrl = useCallback(
    (port: number) => getSandboxServiceUrl(port, context),
    [context],
  );

  return {
    serverUrl: context.serverUrl,
    subdomainOpts: context.subdomainOpts,
    proxyUrl,
    rewritePortPath,
    getServiceUrl,
  };
}
