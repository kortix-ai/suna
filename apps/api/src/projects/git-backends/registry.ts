/**
 * Git backend registry. The provider is stored per-project
 * (`projectGitConnections.provider`), so backends can run simultaneously: a
 * GitHub-managed project resolves through the GitHub backend while a future
 * Forgejo/Artifacts project resolves through its own — all behind the same
 * Kortix git proxy.
 *
 * GitHub is the default managed backend. code.storage (Pierre) is a second,
 * flag-gated drop-in — select it per-deployment with
 * `MANAGED_GIT_PROVIDER=code-storage`; it stays fully inert (isConfigured()
 * false) until CODE_STORAGE_ORG/CODE_STORAGE_PRIVATE_KEY are set. Forgejo /
 * Cloudflare Artifacts slot in here the same way (same `GitHostBackend`
 * interface) with zero changes to the proxy, sandbox, or CLI.
 */
import { codeStorageBackend } from './code-storage';
import { githubBackend } from './github';
import type { GitHostBackend } from './types';

const backends = new Map<string, GitHostBackend>([
  [githubBackend.id, githubBackend],
  [codeStorageBackend.id, codeStorageBackend],
  // ['forgejo', forgejoBackend],
  // ['artifacts', artifactsBackend],
]);

/** True when `provider` has a registered backend. */
export function hasBackend(provider: string): boolean {
  return backends.has(provider);
}

/**
 * Backend for a provider. Falls back to the GitHub backend for unknown
 * providers (e.g. `generic`/`gitlab` BYO connections) since `buildUpstream`'s
 * default `x-access-token` basic-auth scheme works for any HTTPS git remote.
 */
export function getBackend(provider: string): GitHostBackend {
  return backends.get(provider) ?? githubBackend;
}

/** The backend NEW managed projects are provisioned on. */
export function getDefaultManagedBackend(): GitHostBackend {
  const provider = process.env.MANAGED_GIT_PROVIDER?.trim() || 'github';
  return getBackend(provider);
}
