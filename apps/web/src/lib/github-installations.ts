export function isGitHubAppInstallationId(value: string | null): value is string {
  return Boolean(value && /^\d+$/.test(value));
}

export function githubInstallationLabel(
  installationId: string | null,
  ownerLogin: string | null,
): string {
  const owner = ownerLogin || 'GitHub';
  return installationId === 'pat' ? `Managed GitHub · github.com/${owner}` : `github.com/${owner}`;
}

/**
 * Persists the path to return to once `/github/setup` finishes, read back by
 * that page on completion. Was inlined identically in
 * `app/(app)/accounts/[id]/page.tsx` and `features/projects/modal/
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
