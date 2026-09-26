import { authFileLocation, clearAuth } from '../api/auth.ts';
import { activeHostName, getHost } from '../api/config.ts';
import { takeFlags } from '../command-argv.ts';
import { takeFlagValue } from '../command-helpers.ts';
import { C, help, status } from '../style.ts';

const HELP = help`Usage: kortix logout [options]

Remove the Kortix auth token for one host.

Shortcut for the active host — same as \`kortix hosts logout\`. Use
\`kortix hosts logout <name>\` to sign out of a different instance.

Options:
  --host <name>     Log out of a specific named host (default: active).
  -h, --help        Show this help.
`;

export async function runLogout(argv: string[]): Promise<number> {
  const flags = takeFlags(argv, HELP, (rest) => ({ host: takeFlagValue(rest, ['--host']) }));
  if (typeof flags === 'number') return flags;
  return performLogout(flags.host);
}

/**
 * Shared logout implementation used by both the top-level `kortix logout`
 * alias and the `kortix hosts logout` subcommand. Clears the stored token
 * for the named host, defaulting to the active host when omitted.
 */
export async function performLogout(hostName?: string): Promise<number> {
  const target = hostName ?? activeHostName();
  if (!target) {
    process.stdout.write(`${C.dim}Not logged in. Nothing to do.${C.reset}\n`);
    return 0;
  }
  const before = getHost(target);
  const removed = clearAuth(target);
  if (!removed) {
    process.stdout.write(`${C.dim}Host "${target}" already logged out.${C.reset}\n`);
    return 0;
  }
  process.stdout.write(
    `${status.ok(`Logged out of ${C.bold}${target}${C.reset}${C.dim} (was ${before?.user_email || before?.user_id || 'anonymous'})${C.reset}`)}\n`,
  );
  process.stdout.write(`${C.dim}  Config: ${authFileLocation()}${C.reset}\n`);
  return 0;
}
