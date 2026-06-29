import {
  getActiveOpenCodeUrl,
  deriveSubdomainOpts,
} from '@/stores/server-store';
import {
  getProxyBaseUrl,
  proxyLocalhostUrl,
  rewriteLocalhostUrl,
  type SubdomainUrlOptions,
} from '@/lib/utils/sandbox-url';

export interface SandboxProxyContext {
  serverUrl: string;
  subdomainOpts: SubdomainUrlOptions;
}

/** Build a proxy context from the active runtime (opencode URL + sandbox id). */
export function createSandboxProxyContext(): SandboxProxyContext {
  return {
    serverUrl: getActiveOpenCodeUrl(),
    subdomainOpts: deriveSubdomainOpts(),
  };
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

export function getSandboxServiceUrl(
  port: number,
  context: SandboxProxyContext,
): string {
  return getProxyBaseUrl(port, context.subdomainOpts);
}
