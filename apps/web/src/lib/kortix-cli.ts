export const KORTIX_CLI_INSTALL_COMMAND = 'curl -fsSL https://kortix.com/install | bash';

export const KORTIX_CLI_DEV_INSTALL_COMMAND =
  'curl -fsSL https://kortix.com/install | KORTIX_CHANNEL=dev bash';

export function getKortixCliInstallCommand(version: string | undefined): string {
  return version?.includes('-dev.') || version === 'dev'
    ? KORTIX_CLI_DEV_INSTALL_COMMAND
    : KORTIX_CLI_INSTALL_COMMAND;
}

/**
 * Install command for surfaces INSIDE a deployment — the project's Git tab, the
 * session terminal bar — as opposed to kortix.com's own marketing pages.
 *
 * Those in-product surfaces are read by whoever is running THIS instance, and
 * on a self-host `https://kortix.com/install` is the wrong answer twice over:
 * the host may not be reachable from that network at all, and even when it is,
 * we would be telling the operator of a private deployment to pipe a shell
 * script from a vendor domain they never chose. Every deployment already serves
 * the same installer at its own `/install` route
 * (`app/(utility)/install/route.ts`), so point at that.
 *
 * On kortix.com the origin IS kortix.com, so the rendered command is unchanged.
 * Falls back to the canonical URL when no origin is available (SSR).
 */
export function getDeploymentCliInstallCommand(
  version: string | undefined,
  origin?: string,
): string {
  const base = origin ?? (typeof window === 'undefined' ? '' : window.location.origin);
  if (!base) return getKortixCliInstallCommand(version);
  const isDev = version?.includes('-dev.') || version === 'dev';
  return isDev
    ? `curl -fsSL ${base}/install | KORTIX_CHANNEL=dev bash`
    : `curl -fsSL ${base}/install | bash`;
}
