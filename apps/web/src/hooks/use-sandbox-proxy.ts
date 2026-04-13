'use client';

import { useCallback, useMemo } from 'react';

import { useServerStore } from '@/stores/server-store';
import {
  createSandboxProxyContext,
  getSandboxServiceUrl,
  proxySandboxUrl,
  rewriteSandboxPath,
} from '@/lib/utils/sandbox-proxy';

export function useSandboxProxy() {
  const activeServer = useServerStore((s) => {
    return s.servers.find((srv) => srv.id === s.activeServerId) ?? null;
  });

  const context = useMemo(() => createSandboxProxyContext({ activeServer }), [activeServer]);

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
    activeServer,
    serverUrl: context.serverUrl,
    mappedPorts: context.mappedPorts,
    subdomainOpts: context.subdomainOpts,
    proxyUrl,
    rewritePortPath,
    getServiceUrl,
  };
}
