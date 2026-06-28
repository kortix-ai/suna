import { loadAuth } from '../api/auth.ts';
import {
  accountLabel,
  activeAccount,
  defaultProject,
  setActiveAccount,
} from '../api/config.ts';
import { ApiError, clientFromAuth } from '../api/client.ts';
import { selectFromList } from '../tui-select.ts';
import { emitJson, takeFlagBool } from '../command-helpers.ts';
import { C, pad, status } from '../style.ts';
import type { AccountMembership, MeResponse } from '../api/types.ts';

const HELP = `Usage: kortix accounts <subcommand> [options]

One Kortix login can belong to many accounts (your personal account, a
company account, …). Exactly one is "active" — every account-scoped
command (\`projects ls\`, \`ship\`, …) operates on it unless overridden.

Subcommands:
  ls                   List the accounts you belong to (--json)
  use [<slug|id>]      Switch the active account (interactive if omitted)
  current              Print the active account (--json)
  info [<slug|id>]     Show one account (defaults to the active one) (--json)

Global options:
  --json         Machine-readable JSON output (read subcommands).
  -h, --help     Show this help.

Examples:
  kortix accounts ls
  kortix accounts use kortix
  kortix projects ls          # lists the active account's projects
`;

export async function runAccounts(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case 'ls':
    case 'list':
      return accountsLs(takeFlagBool([...rest], ['--json']));
    case 'use':
    case 'switch':
      return accountsUse(rest.find((a) => !a.startsWith('-')));
    case 'current':
      return accountsCurrent(takeFlagBool([...rest], ['--json']));
    case 'info':
    case 'show': {
      const restCopy = [...rest];
      const json = takeFlagBool(restCopy, ['--json']);
      return accountsInfo(restCopy.find((a) => !a.startsWith('-')), json);
    }
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function requireAuth() {
  const auth = loadAuth();
  if (!auth?.token) {
    process.stderr.write(`${status.err('Not logged in. Run `kortix login`.')}\n`);
    return null;
  }
  return auth;
}

/** Fetch the caller's account memberships. `/accounts/me` is identity-scoped,
 *  so it stays unscoped (no account_id query param). */
async function fetchAccounts(): Promise<{ me: MeResponse } | number> {
  const auth = requireAuth();
  if (!auth) return 1;
  const client = clientFromAuth(auth);
  try {
    const me = await client.get<MeResponse>('/accounts/me');
    return { me };
  } catch (err) {
    return surface(err);
  }
}

function accountJson(a: AccountMembership, active: boolean) {
  return {
    account_id: a.account_id,
    slug: a.slug,
    name: a.name,
    role: a.role,
    personal_account: a.personal_account,
    active,
  };
}

// ── ls ─────────────────────────────────────────────────────────────────────

async function accountsLs(json = false): Promise<number> {
  const result = await fetchAccounts();
  if (typeof result === 'number') return result;
  const { me } = result;
  const activeId = activeAccount()?.id ?? loadAuth()?.account_id ?? '';

  if (json) {
    emitJson(me.accounts.map((a) => accountJson(a, a.account_id === activeId)));
    return 0;
  }

  if (me.accounts.length === 0) {
    process.stdout.write(`${C.dim}You don't belong to any accounts.${C.reset}\n`);
    return 0;
  }

  const nameW = Math.max(...me.accounts.map((a) => a.name.length), 4);
  const slugW = Math.max(...me.accounts.map((a) => a.slug.length), 4);
  process.stdout.write('\n');
  process.stdout.write(
    `  ${C.dim}${pad('   NAME', nameW + 3)}   ${pad('SLUG', slugW)}   ROLE${C.reset}\n`,
  );
  for (const a of me.accounts) {
    const mark = a.account_id === activeId ? `${C.green}● ${C.reset}` : '  ';
    process.stdout.write(
      `${mark}${pad(a.name, nameW)}   ${pad(a.slug, slugW)}   ${C.faded}${a.role}${C.reset}\n`,
    );
  }
  const active = me.accounts.find((a) => a.account_id === activeId);
  process.stdout.write(`\n  ${C.green}●${C.reset}${C.dim} active${C.reset}`);
  if (active) {
    process.stdout.write(`${C.dim}: ${C.reset}${C.bold}${active.name}${C.reset}`);
  }
  process.stdout.write(
    `\n  ${C.dim}Switch with ${C.reset}${C.cyan}kortix accounts use <slug>${C.reset}\n\n`,
  );
  return 0;
}

// ── use ──────────────────────────────────────────────────────────────────

async function accountsUse(arg?: string): Promise<number> {
  const result = await fetchAccounts();
  if (typeof result === 'number') return result;
  const { me } = result;
  if (me.accounts.length === 0) {
    process.stderr.write(`${status.err('You don\'t belong to any accounts.')}\n`);
    return 1;
  }

  let target: AccountMembership | undefined;
  if (arg) {
    target = me.accounts.find((a) => a.account_id === arg || a.slug === arg);
    if (!target) {
      const known = me.accounts.map((a) => a.slug).join(', ');
      process.stderr.write(
        `${status.err(`No account "${arg}". You belong to: ${known}`)}\n`,
      );
      return 1;
    }
  } else {
    const activeId = activeAccount()?.id ?? loadAuth()?.account_id ?? '';
    const picked = await selectFromList<AccountMembership>({
      title: 'Switch active account',
      items: me.accounts.map((a) => ({
        value: a,
        label: a.account_id === activeId ? `${a.name}  ${C.green}●${C.reset}` : a.name,
        sublabel: `${a.slug} · ${a.role}`,
      })),
      initialIndex: Math.max(0, me.accounts.findIndex((a) => a.account_id === activeId)),
    });
    if (!picked) {
      process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
      return 0;
    }
    target = picked;
  }

  // Capture whether switching will orphan the current default project.
  const prevDefault = defaultProject();
  setActiveAccount({ id: target.account_id, slug: target.slug, name: target.name });

  process.stdout.write(
    `${status.ok(`Active account is now ${C.bold}${target.name}${C.reset} ${C.faded}(${target.slug}, ${target.role})${C.reset}`)}\n`,
  );
  if (prevDefault && prevDefault.account_id !== target.account_id) {
    process.stdout.write(
      `  ${C.dim}Cleared default project ${prevDefault.name ?? prevDefault.project_id} (it lived in another account).${C.reset}\n` +
        `  ${C.dim}Set a new one with ${C.reset}${C.cyan}kortix projects use <id>${C.reset}\n`,
    );
  }
  return 0;
}

// ── current ──────────────────────────────────────────────────────────────

function accountsCurrent(json = false): number {
  const auth = requireAuth();
  if (!auth) return 1;
  const active = activeAccount();
  if (!active) {
    if (json) {
      emitJson(null);
      return 0;
    }
    process.stderr.write(
      `${status.err('No active account.')} Run ${C.cyan}kortix accounts use <slug>${C.reset}.\n`,
    );
    return 1;
  }
  if (json) {
    emitJson({ account_id: active.id, slug: active.slug, name: active.name });
    return 0;
  }
  process.stdout.write(`${accountLabel(active)}\n`);
  return 0;
}

// ── info ───────────────────────────────────────────────────────────────────

async function accountsInfo(arg?: string, json = false): Promise<number> {
  const result = await fetchAccounts();
  if (typeof result === 'number') return result;
  const { me } = result;
  const activeId = activeAccount()?.id ?? loadAuth()?.account_id ?? '';
  const wanted = arg ?? activeId;
  const a = me.accounts.find((x) => x.account_id === wanted || x.slug === wanted);
  if (!a) {
    process.stderr.write(`${status.err(`No account "${wanted}".`)}\n`);
    return 1;
  }
  if (json) {
    emitJson(accountJson(a, a.account_id === activeId));
    return 0;
  }
  process.stdout.write('\n');
  process.stdout.write(
    `  ${C.bold}${a.name}${C.reset}${a.account_id === activeId ? `  ${C.green}● active${C.reset}` : ''}\n`,
  );
  process.stdout.write(`  ${C.dim}slug       ${C.reset}${a.slug}\n`);
  process.stdout.write(`  ${C.dim}account_id ${C.reset}${a.account_id}\n`);
  process.stdout.write(`  ${C.dim}role       ${C.reset}${a.role}\n`);
  if (a.personal_account) {
    process.stdout.write(`  ${C.dim}personal   ${C.reset}yes\n`);
  }
  process.stdout.write('\n');
  return 0;
}

// ── error surface ──────────────────────────────────────────────────────────

function surface(err: unknown): number {
  if (err instanceof ApiError) {
    if (err.status === 401) {
      process.stderr.write(
        `${status.err('Token rejected. Run `kortix login` to re-authenticate.')}\n`,
      );
    } else {
      process.stderr.write(`${status.err(`HTTP ${err.status}: ${err.message}`)}\n`);
    }
    return 1;
  }
  process.stderr.write(`${status.err((err as Error).message)}\n`);
  return 1;
}
