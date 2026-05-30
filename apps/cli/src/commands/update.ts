import { spawnSync } from 'node:child_process';
import { C, status } from '../style.ts';

const HELP = `Usage: kortix update

Fetch the latest \`kortix\` binary from kortix.com and replace this one.

This re-runs the install script (kortix.com/install) which downloads
the matching binary for your OS + arch from GitHub Releases.

Options:
  -h, --help     Show this help.
`;

const INSTALL_URL = 'https://kortix.com/install';

export async function runUpdate(argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }

  process.stdout.write(`${status.info(`Updating Kortix CLI from ${C.cyan}${INSTALL_URL}${C.reset}…`)}\n`);
  process.stdout.write(`${C.dim}  Running: curl -fsSL ${INSTALL_URL} | bash${C.reset}\n\n`);

  const result = spawnSync('bash', ['-c', `curl -fsSL ${INSTALL_URL} | bash`], {
    stdio: 'inherit',
  });

  if (result.error) {
    process.stderr.write(`\n${status.err(`update failed: ${result.error.message}`)}\n`);
    return 1;
  }
  if (result.status !== 0) {
    process.stderr.write(`\n${status.err(`update failed (exit ${result.status})`)}\n`);
    return result.status ?? 1;
  }
  process.stdout.write(`\n${status.ok('Update complete. Run `kortix version` to confirm.')}\n`);
  return 0;
}
