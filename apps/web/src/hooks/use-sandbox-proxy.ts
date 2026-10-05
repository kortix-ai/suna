'use client';

import { useCallback } from 'react';

import {
  getSandboxServiceUrl,
  proxySandboxUrl,
  rewriteSandboxPath,
} from '@/lib/utils/sandbox-proxy';
import { useActiveSandboxProxyContext } from '@kortix/sdk/react';

/**
 * Proxy helpers bound to the session runtime that is active *right now*.
 *
 * This used to memoize the context on mount with an empty dep array, on the
 * theory that "there is a single runtime per session, so this is stable for the
 * lifetime of the consuming component". The premise is false in the one
 * direction that matters: the runtime is not bound when the component mounts,
 * it binds asynchronously afterwards. A transcript renders as soon as messages
 * load; `LocalhostLinkInterceptor` mounts at the app root, before any session
 * exists at all. Both froze `sandboxId: ''` and emitted `/v1/p//3000/` preview
 * links that 404 for the rest of the page's life.
 *
 * `useActiveSandboxProxyContext` re-derives on every runtime change, so a
 * preview link rendered early becomes correct the moment the sandbox binds, and
 * a session switch re-points every link instead of quietly keeping the previous
 * session's sandbox.
 */
export function useSandboxProxy() {
  const context = useActiveSandboxProxyContext();

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
    /**
     * False while no sandbox is addressable. Gate anything that must never
     * receive a raw `http://localhost:PORT` URL on this — an `<iframe src>`
     * above all, which would otherwise load the *viewer's own* machine.
     */
    isReady: context.isReady,
    proxyUrl,
    rewritePortPath,
    getServiceUrl,
  };
}
