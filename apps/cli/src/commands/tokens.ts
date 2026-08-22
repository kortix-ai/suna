import {
  emitJson,
  resolveAccountContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { iamBase } from '../iam.ts';
import { confirm } from '../prompts.ts';
import { C, help, pad, status } from '../style.ts';

// `kortix tokens` — the two kinds of non-interactive credential an account
// issues, in one place:
//
//   personal API keys  (`/accounts/tokens`)          — act as YOU. Revoked
//                                                      automatically when you
//                                                      leave the account.
//   service accounts   (`/accounts/:id/iam/…`)       — act as THEMSELVES. The
//                                                      engine evaluates a
//                                                      service-account request
//                                                      purely against the SA's
//                                                      own role assignments, so
//                                                      it never inherits the
//                                                      minter's access.
//
// A service account starts with NO permissions. Give it one with
// `kortix access grant --service-account <id> --role <key>`.
//
// Note `kortix token` (singular) is a different, unrelated command: it prints
// the ACTIVE token's context (`whoami --token-only`).

const RELATIVE_SPAN = /^(\d+)\s*(h|d|w|y)$/i;
const SPAN_MS: Record<string, number> = {
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  y: 31_536_000_000,
};

/**
 * Resolve `--expires` to the ISO-8601 instant the API stores.
 *
 * Accepts an ISO timestamp or a FORWARD span (`30d`, `12h`, `6w`, `1y`) —
 * "expires in 30 days" is what anyone minting a key actually means, and the
 * API only speaks ISO. Resolved here so `--json` shows the instant really sent.
 */
export function resolveExpiry(input: string, now: Date = new Date()): string | null {
  const value = input.trim();
  if (!value) return null;
  const relative = RELATIVE_SPAN.exec(value);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]!.toLowerCase();
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return new Date(now.getTime() + amount * SPAN_MS[unit]!).toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

interface AccountToken {
  token_id: string;
  name: string;
  project_id: string | null;
  public_key: string;
  status: string;
  expires_at: string | null;
  last_used_at?: string | null;
  created_at: string;
  revoked_at?: string | null;
  secret_key?: string;
}

interface ServiceAccount {
  service_account_id: string;
  name: string;
  description: string | null;
  public_prefix: string;
  status?: string;
  secret?: string;
  last_used_at?: string | null;
  expires_at?: string | null;
  created_at: string;
  disabled_at?: string | null;
}

const HELP = help`Usage: kortix tokens <subcommand> [options]

Non-interactive credentials for this account. Reads need token.read; minting
needs token.create; revoking needs token.revoke.

Personal API keys — act as YOU, and die with your membership:
  ls [--mine] [--json]              List the account's keys. --mine narrows to
                                    the ones you minted yourself.
  new <name> [--expires <when>]     Mint a key. The secret prints ONCE.
      [--project <id>]              Bind the key to one project (it can never
                                    reach another).
  rm <token-id> [-y]                Revoke a key immediately.

Service accounts — act as THEMSELVES, with no inherited access:
  service-accounts ls [--json]              List service accounts.
  service-accounts new <name>               Create one. The bearer prints ONCE.
      [--description <t>] [--expires <when>]
  service-accounts disable <id>             Disable (reversible only by
                                            deleting and re-creating).
  service-accounts rm <id> [-y]             Delete permanently.

A new service account holds NO permissions. Grant it one with
\`kortix access grant --service-account <id> --role <key>\`.

Options:
  --mine              ls: only the keys you minted.
  --expires <when>    ISO-8601, or a forward span: 30d, 12h, 6w, 1y.
  --project <id>      new: bind the key to one project.
  --description <t>   service-accounts new: what this identity is for.
  --account <id>      Operate on this account (default: the active account).
  --host <name>       Operate against a non-default Kortix host.
  --json              Machine-readable output.
  -y, --yes           Skip the confirmation prompt.
  -h, --help          Show this help.

Examples:
  kortix tokens ls --mine
  kortix tokens new ci-deploy --expires 90d
  kortix tokens new laptop --project 1a2b… --expires 2027-01-01
  kortix tokens service-accounts new nightly-reporter --description "Cron"
  kortix access grant --service-account <id> --role member --project 1a2b…
`;

export async function runTokens(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  // The root help promises `kortix <cmd> <subcommand> --help`. None of the
  // subcommands below own dedicated help text, so without this a bare
  // `--help` falls through as an ordinary positional arg and the command
  // runs (or fails on auth) instead of printing usage.
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }
  const f: Record<string, string | undefined> = {};
  let json = false;
  let mine = false;
  let yes = false;
  try {
    f.account = takeFlagValue(rest, ['--account']);
    f.host = takeFlagValue(rest, ['--host']);
    f.expires = takeFlagValue(rest, ['--expires']);
    f.project = takeFlagValue(rest, ['--project']);
    f.description = takeFlagValue(rest, ['--description', '--desc']);
    json = takeFlagBool(rest, ['--json']);
    mine = takeFlagBool(rest, ['--mine']);
    yes = takeFlagBool(rest, ['-y', '--yes']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const positional = rest.filter((a) => !a.startsWith('-'));

  let expiresAt: string | undefined;
  if (f.expires !== undefined) {
    const iso = resolveExpiry(f.expires);
    if (!iso) {
      process.stderr.write(
        `${status.err(`--expires "${f.expires}" is not an ISO-8601 instant or a span like 30d/12h/6w/1y.`)}\n`,
      );
      return 2;
    }
    expiresAt = iso;
  }

  const ctx = resolveAccountContext({ accountArg: f.account, hostArg: f.host });
  if (!ctx) return 1;
  const saBase = `${iamBase(ctx.accountId)}/service-accounts`;

  try {
    switch (sub) {
      case 'ls':
      case 'list': {
        // The client already appends `?account_id=`; `mine` narrows to the
        // caller's own hand-minted keys (no session or connector tokens).
        const tokens = await ctx.client.get<AccountToken[]>(
          `/accounts/tokens${mine ? '?mine=true' : ''}`,
        );
        if (json) {
          emitJson(tokens);
          return 0;
        }
        if (tokens.length === 0) {
          process.stdout.write(
            `\n  ${C.dim}No API keys${mine ? ' minted by you' : ''}. Mint one with ` +
              `${C.reset}${C.cyan}kortix tokens new <name>${C.reset}\n\n`,
          );
          return 0;
        }
        const nameW = Math.max(...tokens.map((t) => t.name.length), 4);
        const keyW = Math.max(...tokens.map((t) => t.public_key.length), 6);
        process.stdout.write('\n');
        process.stdout.write(
          `  ${C.dim}${pad('NAME', nameW)}   ${pad('PUBLIC KEY', keyW)}   ${pad('STATUS', 7)}   ${pad('EXPIRES', 10)}   TOKEN ID${C.reset}\n`,
        );
        for (const t of tokens) {
          const state =
            t.status === 'active' ? t.status : `${C.yellow}${t.status}${C.reset}`;
          process.stdout.write(
            `  ${pad(t.name, nameW)}   ${pad(t.public_key, keyW)}   ${pad(state, 7)}   ` +
              `${pad(t.expires_at ? t.expires_at.slice(0, 10) : 'never', 10)}   ${C.faded}${t.token_id}${C.reset}\n`,
          );
        }
        process.stdout.write(
          `\n  ${C.dim}${tokens.length} key${tokens.length === 1 ? '' : 's'}${C.reset}\n\n`,
        );
        return 0;
      }

      case 'new':
      case 'create': {
        const name = positional[0];
        if (!name) return missing('a key name');
        // account_id rides in the BODY: this route resolves the account from
        // the body, not the query string, and would otherwise fall back to the
        // caller's earliest-joined account.
        const token = await ctx.client.post<AccountToken>('/accounts/tokens', {
          name,
          account_id: ctx.accountId,
          ...(expiresAt ? { expires_at: expiresAt } : {}),
          ...(f.project ? { project_id: f.project } : {}),
        });
        if (json) {
          emitJson(token);
          return 0;
        }
        process.stdout.write(`${status.ok(`Minted ${C.bold}${token.name}${C.reset}`)}\n\n`);
        process.stdout.write(`  ${token.secret_key ?? '(no secret returned)'}\n\n`);
        process.stdout.write(
          `${status.warn('This is the only time the secret is shown. Store it now.')}\n`,
        );
        process.stdout.write(`  ${C.dim}token_id ${C.reset}${token.token_id}\n`);
        process.stdout.write(
          `  ${C.dim}expires  ${C.reset}${token.expires_at ? token.expires_at.slice(0, 10) : 'never'}\n`,
        );
        if (token.project_id) {
          process.stdout.write(`  ${C.dim}project  ${C.reset}${token.project_id}\n`);
        }
        return 0;
      }

      case 'rm':
      case 'revoke':
      case 'delete': {
        const tokenId = positional[0];
        if (!tokenId) return missing('a token id (see `kortix tokens ls`)');
        if (!yes) {
          const ok = await confirm(
            `Revoke API key ${C.bold}${tokenId}${C.reset}? Anything using it stops working immediately.`,
            false,
            { onEndOfInput: false },
          );
          if (!ok) {
            process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
            return 0;
          }
        }
        await ctx.client.delete(`/accounts/tokens/${encodeURIComponent(tokenId)}`);
        process.stdout.write(`${status.ok(`Revoked ${C.bold}${tokenId}${C.reset}`)}\n`);
        return 0;
      }

      case 'service-accounts':
      case 'sa':
        return await serviceAccounts(ctx.client, saBase, positional, {
          json,
          yes,
          expiresAt,
          description: f.description,
        });

      default:
        process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    return surfaceApiError(err);
  }
}

async function serviceAccounts(
  client: NonNullable<ReturnType<typeof resolveAccountContext>>['client'],
  base: string,
  positional: string[],
  opts: { json: boolean; yes: boolean; expiresAt?: string; description?: string },
): Promise<number> {
  const verb = positional[0];
  const id = positional[1];
  switch (verb) {
    case undefined:
    case 'ls':
    case 'list': {
      const { service_accounts: rows } = await client.get<{ service_accounts: ServiceAccount[] }>(
        base,
      );
      if (opts.json) {
        emitJson(rows);
        return 0;
      }
      if (rows.length === 0) {
        process.stdout.write(
          `\n  ${C.dim}No service accounts. Create one with ` +
            `${C.reset}${C.cyan}kortix tokens service-accounts new <name>${C.reset}\n\n`,
        );
        return 0;
      }
      const nameW = Math.max(...rows.map((r) => r.name.length), 4);
      const prefixW = Math.max(...rows.map((r) => r.public_prefix.length), 6);
      process.stdout.write('\n');
      process.stdout.write(
        `  ${C.dim}${pad('NAME', nameW)}   ${pad('PREFIX', prefixW)}   ${pad('STATUS', 8)}   ${pad('EXPIRES', 10)}   SERVICE ACCOUNT ID${C.reset}\n`,
      );
      for (const r of rows) {
        const state =
          r.status === 'active' ? (r.status ?? '—') : `${C.yellow}${r.status ?? '—'}${C.reset}`;
        process.stdout.write(
          `  ${pad(r.name, nameW)}   ${pad(r.public_prefix, prefixW)}   ${pad(state, 8)}   ` +
            `${pad(r.expires_at ? r.expires_at.slice(0, 10) : 'never', 10)}   ${C.faded}${r.service_account_id}${C.reset}\n`,
        );
      }
      process.stdout.write(
        `\n  ${C.dim}${rows.length} service account${rows.length === 1 ? '' : 's'}${C.reset}\n\n`,
      );
      return 0;
    }

    case 'new':
    case 'create': {
      const name = positional[1];
      if (!name) return missing('a service account name');
      const created = await client.post<ServiceAccount>(base, {
        name,
        ...(opts.description !== undefined ? { description: opts.description } : {}),
        ...(opts.expiresAt ? { expires_at: opts.expiresAt } : {}),
      });
      if (opts.json) {
        emitJson(created);
        return 0;
      }
      process.stdout.write(
        `${status.ok(`Created service account ${C.bold}${created.name}${C.reset}`)}\n\n`,
      );
      process.stdout.write(`  ${created.secret ?? '(no secret returned)'}\n\n`);
      process.stdout.write(
        `${status.warn('This is the only time the bearer is shown. Store it now.')}\n`,
      );
      process.stdout.write(`  ${C.dim}id      ${C.reset}${created.service_account_id}\n`);
      process.stdout.write(
        `  ${C.dim}expires ${C.reset}${created.expires_at ? created.expires_at.slice(0, 10) : 'never'}\n\n`,
      );
      process.stdout.write(
        `  ${C.dim}It holds no permissions yet. Grant one with${C.reset}\n` +
          `  ${C.cyan}kortix access grant --service-account ${created.service_account_id} --role <key>${C.reset}\n`,
      );
      return 0;
    }

    case 'disable': {
      if (!id) return missing('a service account id');
      await client.post(`${base}/${encodeURIComponent(id)}/disable`, {});
      process.stdout.write(`${status.ok(`Disabled ${C.bold}${id}${C.reset}`)}\n`);
      return 0;
    }

    case 'rm':
    case 'delete': {
      if (!id) return missing('a service account id');
      if (!opts.yes) {
        const ok = await confirm(
          `Delete service account ${C.bold}${id}${C.reset}? Its bearer stops working immediately.`,
          false,
          { onEndOfInput: false },
        );
        if (!ok) {
          process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
          return 0;
        }
      }
      await client.delete(`${base}/${encodeURIComponent(id)}`);
      process.stdout.write(`${status.ok(`Deleted ${C.bold}${id}${C.reset}`)}\n`);
      return 0;
    }

    default:
      process.stderr.write(
        `${status.err(`unknown service-accounts verb "${verb}" — use ls|new|disable|rm`)}\n`,
      );
      return 2;
  }
}

function missing(what: string): number {
  process.stderr.write(`${status.err(`Pass ${what}.`)}\n`);
  return 2;
}
