import { authFileLocation, clearAuth } from '../api/auth.ts';
import { activeHostName, getHost } from '../api/config.ts';
import { C, status } from '../style.ts';

const HELP = `Usage: kortix logout [options]

Remove the Kortix auth token for one host.

Options:
  --host <name>     Log out of a specific named host (default: active).
  -h, --help        Show this help.
`;

interface LogoutFlags {
  host?: string;
  help: boolean;
}

function parseFlags(argv: string[]): LogoutFlags {
  const f: LogoutFlags = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') f.help = true;
    else if (a === '--host') {
      const next = argv[i + 1];
      if (!next) throw new Error('--host requires a value');
      f.host = next;
      i += 1;
    } else {
      throw new Error(`unknown option "${a}"`);
    }
  }
  return f;
}

export async function runLogout(argv: string[]): Promise<number> {
  let flags: LogoutFlags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const target = flags.host ?? activeHostName();
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
