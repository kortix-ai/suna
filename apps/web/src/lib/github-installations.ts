export function isGitHubAppInstallationId(value: string | null): value is string {
  return Boolean(value && /^\d+$/.test(value));
}

export function githubInstallationLabel(
  installationId: string | null,
  ownerLogin: string | null,
  ownerType?: string | null,
): string {
  const owner = ownerLogin || 'GitHub';
  if (installationId === 'pat') return `Managed GitHub · github.com/${owner}`;
  const typeLabel = githubOwnerTypeLabel(ownerType);
  return typeLabel ? `${typeLabel} · github.com/${owner}` : `github.com/${owner}`;
}

export function githubOwnerTypeLabel(ownerType: string | null | undefined): string | null {
  const normalized = ownerType?.trim().toLowerCase();
  if (normalized === 'user') return 'Personal';
  if (normalized === 'organization' || normalized === 'org') return 'Organization';
  return null;
}

export function isUsableGitHubInstallation(installation: {
  installed: boolean;
  connection_status?: string | null;
}): boolean {
  return (
    installation.installed &&
    installation.connection_status !== 'needs_reconnect' &&
    installation.connection_status !== 'error' &&
    installation.connection_status !== 'disconnected'
  );
}
