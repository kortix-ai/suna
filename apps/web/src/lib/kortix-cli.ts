export const KORTIX_CLI_INSTALL_COMMAND = 'curl -fsSL https://dosco.live/install | bash';

export const KORTIX_CLI_DEV_INSTALL_COMMAND =
  'curl -fsSL https://dosco.live/install | KORTIX_CHANNEL=dev bash';

export function getdoscoCliInstallCommand(version: string | undefined): string {
  return version?.includes('-dev.') || version === 'dev'
    ? KORTIX_CLI_DEV_INSTALL_COMMAND
    : KORTIX_CLI_INSTALL_COMMAND;
}

/**
 * Builds an install command for an in-product surface.
 *
 * Every deployment exposes `/install`. That route currently proxies the
 * canonical script from GitHub. The deployment URL removes a direct dependency
 * on dosco.live, but it does not make the installer available offline.
 */
export function getDeploymentCliInstallCommand(
  version: string | undefined,
  origin?: string,
): string {
  let deploymentOrigin: string;
  try {
    const url = new URL(origin || '');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return getdoscoCliInstallCommand(version);
    }
    deploymentOrigin = url.origin;
  } catch {
    return getdoscoCliInstallCommand(version);
  }

  const isDev = version?.includes('-dev.') || version === 'dev';
  return isDev
    ? `curl -fsSL ${deploymentOrigin}/install | KORTIX_CHANNEL=dev bash`
    : `curl -fsSL ${deploymentOrigin}/install | bash`;
}
