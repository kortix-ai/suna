import { loadAuth, loadAuthForHost } from '../api/auth.ts';
import { activeHostName, listHosts } from '../api/config.ts';
import { ApiError, clientFromAuth } from '../api/client.ts';
import { emitJson } from '../command-helpers.ts';
import { C, status } from '../style.ts';
import type { MeResponse } from '../api/types.ts';

const HELP = `Usage: kortix whoami [options]

Print the currently authenticated user + active account on the
selected host.

Options:
  --host <name>     Probe a specific host (default: active).
  --json            Machine-readable JSON output.
  -h, --help        Show this help.
`;

interface WhoamiFlags {
  host?: string;
  json: boolean;
  help: boolean;
}

function parseFlags(argv: string[]): WhoamiFlags {
  const f: WhoamiFlags = { json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') f.help = true;
    else if (a === '--json') f.json = true;
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

export async function runWhoami(argv: string[]): Promise<number> {
  let flags: WhoamiFlags;
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

  const auth = flags.host ? loadAuthForHost(flags.host) : loadAuth();
  if (!auth?.token) {
    if (flags.host) {
      process.stderr.write(
        `${status.err(`Host "${flags.host}" is not logged in.`)} Run ` +
          `${C.cyan}kortix login --host ${flags.host}${C.reset}.\n`,
      );
    } else {
      process.stderr.write(`${status.err('Not logged in. Run `kortix login`.')}\n`);
    }
    return 1;
  }

  const client = clientFromAuth(auth);
  let me: MeResponse;
  try {
    me = await client.get<MeResponse>('/accounts/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      process.stderr.write(
        `${status.err('Token rejected. Run `kortix login` to re-authenticate.')}\n`,
      );
      return 1;
    }
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 1;
  }

  const resolvedHost = flags.host ?? activeHostName();
  const active = me.accounts.find((a) => a.account_id === auth.account_id) ?? me.accounts[0];

  if (flags.json) {
    emitJson({
      host: resolvedHost ?? null,
      url: auth.api_base,
      user_id: me.user_id,
      user_email: me.email || null,
      account_id: active?.account_id ?? auth.account_id ?? null,
      account: active ?? null,
      accounts: me.accounts,
    });
    return 0;
  }

  process.stdout.write(`\n  ${C.bold}${me.email || me.user_id}${C.reset}\n`);
  if (me.email) {
    process.stdout.write(`  ${C.dim}email     ${C.reset}${me.email}\n`);
  }
  process.stdout.write(`  ${C.dim}user_id   ${C.reset}${me.user_id}\n`);
  if (active) {
    process.stdout.write(
      `  ${C.dim}account   ${C.reset}${active.name} ${C.faded}(${active.slug}, ${active.role})${C.reset}\n`,
    );
  }
  if (me.accounts.length > 1) {
    process.stdout.write(
      `  ${C.dim}${me.accounts.length} accounts total — target one with ${C.reset}${C.cyan}kortix ship --account <slug>${C.reset}\n`,
    );
  }
  process.stdout.write(`  ${C.dim}host      ${C.reset}${resolvedHost ?? '—'} ${C.faded}(${auth.api_base})${C.reset}\n`);
  const totalHosts = listHosts().length;
  if (totalHosts > 1) {
    process.stdout.write(
      `  ${C.dim}${totalHosts} hosts configured — list with \`kortix hosts ls\`${C.reset}\n`,
    );
  }
  process.stdout.write('\n');
  return 0;
}
