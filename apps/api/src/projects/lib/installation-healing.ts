/**
 * Minting an installation token, with the dead rows cleaned up as it goes.
 *
 * GitHub answers `POST /app/installations/<id>/access_tokens` with `404` once
 * an installation is gone — an uninstall, a reinstall (which mints a NEW id for
 * the same owner), or an App identity change. Kortix keeps a row per
 * installation and nothing used to remove it: the App's manifest registers
 * webhooks as `active: false`, so an uninstall is never reported, and
 * `upsertAccountGitHubInstallation` conflicts on `(account_id,
 * installation_id)`, so a reconnect INSERTS beside the dead row instead of
 * replacing it. The user then saw "This GitHub connection is no longer valid.
 * Reconnect it in Settings → Git." right after reconnecting.
 *
 * A 404 on that endpoint is the one signal that proves the row is dead, so it
 * is the only one that deletes. A 403, a 5xx or a timeout says nothing about
 * the row and is rethrown untouched.
 *
 * Pure over its dependencies: `git.ts` supplies the real mint and the real
 * deletes, tests supply fakes. Its own module rather than a function inside
 * `git.ts` so nothing new imports `projects/github.ts`, a module many suites
 * replace wholesale with `mock.module` (see `github-installation-errors.ts`).
 */

import { isGitHubInstallationUnreachable } from './github-installation-errors';

/** The two fields healing needs: which installation, and whose it is. */
export interface HealableInstallation {
  installationId: string;
  ownerLogin: string;
}

export interface InstallationHealingDeps<T extends HealableInstallation> {
  accountId: string;
  /** Mint a token for one installation. Throws the GitHub error as-is. */
  mint: (installationId: string) => Promise<{ token: string }>;
  /** Remove one dead connection row from this account. */
  dropInstallation: (accountId: string, installationId: string) => Promise<void>;
  /** This account's OTHER connections for the same owner, newest first. */
  siblings: (accountId: string, ownerLogin: string) => Promise<T[]>;
}

/**
 * Mint for `installation`; on a dead installation, delete that row and try the
 * account's other connections for the same owner, newest first. Each candidate
 * is tried at most once. When every candidate is dead, the FIRST failure is
 * thrown — it is the one that names the connection the caller asked for.
 */
export async function mintInstallationTokenHealing<T extends HealableInstallation>(
  installation: T,
  deps: InstallationHealingDeps<T>,
): Promise<{ token: string; installation: T }> {
  const firstAttempt = await attempt(installation, deps);
  if ('token' in firstAttempt) return { token: firstAttempt.token, installation };
  if (!firstAttempt.dead) throw firstAttempt.error;

  const tried = new Set([installation.installationId]);
  for (const sibling of await deps.siblings(deps.accountId, installation.ownerLogin)) {
    if (tried.has(sibling.installationId)) continue;
    tried.add(sibling.installationId);
    const next = await attempt(sibling, deps);
    if ('token' in next) return { token: next.token, installation: sibling };
    if (!next.dead) throw next.error;
  }

  throw firstAttempt.error;
}

async function attempt<T extends HealableInstallation>(
  installation: T,
  deps: InstallationHealingDeps<T>,
): Promise<{ token: string } | { error: unknown; dead: boolean }> {
  try {
    const minted = await deps.mint(installation.installationId);
    return { token: minted.token };
  } catch (error) {
    if (!isGitHubInstallationUnreachable(error)) return { error, dead: false };
    await deps.dropInstallation(deps.accountId, installation.installationId);
    return { error, dead: true };
  }
}
