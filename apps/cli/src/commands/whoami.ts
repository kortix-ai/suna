import { loadAuth } from '../api/auth.ts';
import { ApiError, clientFromAuth } from '../api/client.ts';
import { C, status } from '../style.ts';
import type { MeResponse } from '../api/types.ts';

const HELP = `Usage: kortix whoami

Print the currently authenticated user + active account.
`;

export async function runWhoami(argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }

  const auth = loadAuth();
  if (!auth?.token) {
    process.stderr.write(`${status.err('Not logged in. Run `kortix login`.')}\n`);
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

  const active = me.accounts.find((a) => a.account_id === auth.account_id) ?? me.accounts[0];
  process.stdout.write(`\n  ${C.bold}${me.email || me.user_id}${C.reset}\n`);
  process.stdout.write(`  ${C.dim}user_id   ${C.reset}${me.user_id}\n`);
  if (active) {
    process.stdout.write(
      `  ${C.dim}account   ${C.reset}${active.name} ${C.faded}(${active.slug}, ${active.role})${C.reset}\n`,
    );
  }
  if (me.accounts.length > 1) {
    process.stdout.write(
      `  ${C.dim}${me.accounts.length} accounts total — switch with \`kortix accounts use <slug>\`${C.reset}\n`,
    );
  }
  process.stdout.write(`  ${C.dim}api       ${C.reset}${auth.api_base}\n\n`);
  return 0;
}
