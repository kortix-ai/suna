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
