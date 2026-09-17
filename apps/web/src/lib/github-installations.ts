/**
 * How one GitHub connection is named in the UI.
 *
 * It used to take the installation id too, so it could print
 * `Managed GitHub · github.com/<owner>` for the synthetic `pat` entry that
 * `GET /projects/github/installations` injected into every account's
 * connection list. That entry is gone — the instance git backend has its own
 * namespace (`GET /projects/git/backend`) and is never a connection — so every
 * row this labels is a real GitHub App installation on this account.
 */
export function githubInstallationLabel(ownerLogin: string | null): string {
  return `github.com/${ownerLogin || 'GitHub'}`;
}

/**
 * Persists the path to return to once `/github/setup` finishes, read back by
 * that page on completion. Was inlined identically in
 * `features/accounts/hub/account-hub-content.tsx` and `features/projects/modal/
 * project-create-modal.tsx` — centralized here rather than adding a third
 * copy (`features/workspace/settings/tabs/connected-tab.tsx`). The two
 * existing call sites are untouched; only new callers should import this.
 */
export function rememberGitHubSetupReturn(path: string): void {
  try {
    window.localStorage.setItem('kortix:github_setup_return', path);
  } catch {
    // Non-critical: the setup page falls back to the project import flow.
  }
}

/**
 * A GitHub connection whose installation GitHub no longer resolves.
 *
 * The API answers 409 with `error: 'github_installation_unreachable'` for
 * repository listing, branch listing and repository creation once an
 * installation has been uninstalled on GitHub, or once the instance's App
 * identity changed underneath it (2026-09-16: every one of 39 accounts' saved
 * installations belonged to an App that was no longer this instance's).
 *
 * Before this existed the picker printed GitHub's own sentence —
 * `/app/installations/148404669/access_tokens failed (404): Not Found` — which
 * names an internal id, a GitHub API path and an HTTP status, and tells the
 * reader nothing they can act on.
 */
export interface UnreachableGitHubInstallation {
  installationId: string | null;
  installUrl: string | null;
}

export function gitHubInstallationUnreachable(
  error: unknown,
): UnreachableGitHubInstallation | null {
  const err = error as
    | {
        status?: number;
        response?: { status?: number };
        data?: { error?: string; installation_id?: string; install_url?: string } | null;
      }
    | null
    | undefined;
  if (!err) return null;
  const status = err.status ?? err.response?.status;
  if (status !== 409 || err.data?.error !== 'github_installation_unreachable') return null;
  return {
    installationId: err.data.installation_id ?? null,
    installUrl: err.data.install_url ?? null,
  };
}
