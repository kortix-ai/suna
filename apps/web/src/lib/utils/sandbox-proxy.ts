import { getProxyBaseUrl, proxyLocalhostUrl, rewriteLocalhostUrl } from '@/lib/utils/sandbox-url';
import { type ActiveSandboxProxyContext, createActiveSandboxProxyContext } from '@kortix/sdk/react';

export type SandboxProxyContext = ActiveSandboxProxyContext;

/** Build a proxy context from the active runtime (opencode URL + sandbox id). */
export function createSandboxProxyContext(): SandboxProxyContext {
  return createActiveSandboxProxyContext();
}

export function proxySandboxUrl(
  url: string | undefined,
  context: SandboxProxyContext,
): string | undefined {
  return proxyLocalhostUrl(url, context.subdomainOpts);
}

export function rewriteSandboxPath(
  port: number,
  path: string,
  context: SandboxProxyContext,
): string {
  return rewriteLocalhostUrl(port, path, context.subdomainOpts);
}

export function getSandboxServiceUrl(port: number, context: SandboxProxyContext): string {
  return getProxyBaseUrl(port, context.subdomainOpts);
}
