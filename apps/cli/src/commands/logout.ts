import { authFileLocation, clearAuth, loadAuth } from '../api/auth.ts';
import { C, status } from '../style.ts';

const HELP = `Usage: kortix logout

Remove the stored Kortix auth token from this machine.
`;

export async function runLogout(argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }

  const before = loadAuth();
  clearAuth();
  if (before) {
    process.stdout.write(
      `${status.ok(`Logged out ${C.dim}(was ${before.user_email || before.user_id})${C.reset}`)}\n`,
    );
    process.stdout.write(`${C.dim}  Removed ${authFileLocation()}${C.reset}\n`);
  } else {
    process.stdout.write(`${C.dim}Not logged in. Nothing to do.${C.reset}\n`);
  }
  return 0;
}
