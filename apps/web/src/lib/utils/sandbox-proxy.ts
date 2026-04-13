import {
  getActiveOpenCodeUrl,
  type ServerEntry,
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
  mappedPorts?: Record<string, string>;
  subdomainOpts: SubdomainUrlOptions;
}

export function createSandboxProxyContext({
  activeServer,
  fallbackServerUrl = getActiveOpenCodeUrl(),
}: {
  activeServer: ServerEntry | null | undefined;
  fallbackServerUrl?: string;
}): SandboxProxyContext {
  return {
    serverUrl: activeServer?.url || fallbackServerUrl,
    mappedPorts: activeServer?.mappedPorts,
    subdomainOpts: deriveSubdomainOpts(activeServer),
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
