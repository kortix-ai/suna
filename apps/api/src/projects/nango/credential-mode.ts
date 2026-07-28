export class GitHubCredentialModeError extends Error {
  readonly code = 'github_reconnect_required';
  readonly status = 409;

  constructor() {
    super('Reconnect GitHub through Nango before importing this repository.');
    this.name = 'GitHubCredentialModeError';
  }
}
