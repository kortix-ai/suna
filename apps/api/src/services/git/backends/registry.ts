/**
 * Git backend registry. The provider is stored per-project
 * (`projectGitConnections.provider`), so backends can run simultaneously: a
 * GitHub-managed project resolves through the GitHub backend while a future
 * Forgejo/Artifacts project resolves through its own — all behind the same
 * Kortix git proxy.
 *
 * GitHub is the managed backend for every NEW project, in every environment.
 *
 * code.storage (Pierre) is RETIRED as a provisioning target: it stays
 * registered so existing projects keep reading and writing their repos
 * (`getBackend(connection.provider)` resolves per project), but it can no
 * longer be SELECTED as the default — `MANAGED_GIT_PROVIDER=code-storage` is
 * refused below. The value still sits in deployed env bundles that this repo
 * does not own (dev's `kortix-dev-env`, ADR-004), and each of them would
 * otherwise keep minting new repos on a host we are leaving. Retiring it in
 * code, not in config, is what makes "no new code.storage repos" true
 * everywhere at once.
 *
 * Forgejo / Cloudflare Artifacts slot in here the same way (same
 * `GitHostBackend` interface) with zero changes to the proxy, sandbox, or CLI.
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

/** Providers that may no longer be chosen for a NEW managed repo. Existing
 *  connections on them keep resolving through `getBackend`. */
const RETIRED_MANAGED_PROVIDERS = new Set(['code-storage', 'code_storage', 'codestorage']);

/** True when `provider` may no longer host a NEW managed repo. */
export function isRetiredManagedProvider(provider: string | null | undefined): boolean {
  return RETIRED_MANAGED_PROVIDERS.has((provider ?? '').trim().toLowerCase());
}

/**
 * Provider id NEW managed repos are provisioned on: `MANAGED_GIT_PROVIDER`
 * unless it names a retired backend, in which case github. Read this rather
 * than `process.env.MANAGED_GIT_PROVIDER` so a deployed env bundle this repo
 * does not own cannot re-select a retired host.
 */
export function defaultManagedProviderId(): string {
  const configured = process.env.MANAGED_GIT_PROVIDER?.trim().toLowerCase() || '';
  if (isRetiredManagedProvider(configured)) {
    console.warn(
      `[git-backends] MANAGED_GIT_PROVIDER=${configured} is retired for new repos — provisioning on github instead. ` +
        'Existing repos on that provider are unaffected; clear the variable to silence this.',
    );
    return githubBackend.id;
  }
  return configured || 'github';
}

/** The backend NEW managed projects are provisioned on. */
export function getDefaultManagedBackend(): GitHostBackend {
  return getBackend(defaultManagedProviderId());
}
