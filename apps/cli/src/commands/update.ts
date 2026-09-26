import { spawnSync } from 'node:child_process';
import { C, help, status } from '../style.ts';
import { isSupervised, SUPERVISED_NOTICE } from '../supervised.ts';

const HELP = help`Usage: kortix update

Fetch the latest \`kortix\` binary from kortix.com and replace this one.

This re-runs the install script (kortix.com/install) which downloads
the matching binary for your OS + arch from GitHub Releases.

Disabled inside a managed Kortix sandbox: there the platform converges
this binary itself, and a public install would shadow it for good.

Options:
  -h, --help     Show this help.
`;

const INSTALL_URL = 'https://kortix.com/install';

export async function runUpdate(argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }

  // A managed sandbox converges this binary from the platform's own signed
  // manifest (runtime-assets.ts). kortix.com/install would instead drop a
  // PUBLIC build into ~/.local/bin, which sits FIRST on the image PATH and
  // therefore shadows /usr/local/bin/kortix for good: the daemon keeps healing
  // a file nothing resolves any more. The only TTY check in this path guards
  // the PROMPT, not this command, and the Session terminal is a real PTY — so
  // the gate has to be here.
  if (isSupervised()) {
    process.stderr.write(
      `${status.err('kortix update is disabled in this sandbox.')}\n` +
        `  ${C.dim}${SUPERVISED_NOTICE}${C.reset}\n` +
        `  ${C.dim}Update the CLI by restarting the session; the box converges it at boot.${C.reset}\n`,
    );
    return 1;
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
