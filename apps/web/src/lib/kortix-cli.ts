export const KORTIX_CLI_INSTALL_COMMAND = 'curl -fsSL https://kortix.com/install | bash';

export const KORTIX_CLI_DEV_INSTALL_COMMAND =
  'curl -fsSL https://kortix.com/install | KORTIX_CHANNEL=dev bash';

export function getKortixCliInstallCommand(version: string | undefined): string {
  return version?.includes('-dev.') || version === 'dev'
    ? KORTIX_CLI_DEV_INSTALL_COMMAND
    : KORTIX_CLI_INSTALL_COMMAND;
}
