export type GitHubCredentialResolutionMode = 'nango_preferred' | 'nango_only';

export class GitHubCredentialModeError extends Error {
  readonly code = 'github_reconnect_required';
  readonly status = 409;

  constructor() {
    super('Reconnect GitHub through Nango before importing this repository.');
    this.name = 'GitHubCredentialModeError';
  }
}

export function enforcePatImportMode(
  mode: GitHubCredentialResolutionMode,
  log: (event: string) => void = (event) => console.warn(event),
): 'deprecated' {
  if (mode === 'nango_only') throw new GitHubCredentialModeError();
  log('github_pat_import_deprecated');
  return 'deprecated';
}
