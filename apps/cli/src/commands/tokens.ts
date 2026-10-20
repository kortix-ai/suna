import { ApiError } from '../api/client.ts';
import { splitHelp } from '../command-argv.ts';
import {
  emitJson,
  fail,
  missing,
  resolveAccountContext,
  resolveSpanInstant,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { iamBase } from '../iam.ts';
import { confirm } from '../prompts.ts';
import { C, help, pad, status, visibleWidth } from '../style.ts';

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

/**
 * Resolve `--expires` to the ISO-8601 instant the API stores.
 *
 * Accepts an ISO timestamp or a FORWARD span (`30d`, `12h`, `6w`, `1y`) —
 * "expires in 30 days" is what anyone minting a key actually means, and the
 * API only speaks ISO. Resolved here so `--json` shows the instant really sent.
 */
export function resolveExpiry(input: string, now: Date = new Date()): string | null {
  return resolveSpanInstant(input, now, 1);
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

/** One row of `GET /oauth/grants`. */
interface ConnectedApp {
  client_id: string;
  name: string;
  self_registered: boolean;
  redirect_hosts: string[];
  granted_at: string | null;
  last_active_at: string | null;
}

const HELP = help`Usage: kortix tokens <subcommand> [options]

Non-interactive credentials for this account. Reads need token.read. Every
member may mint and revoke their OWN personal keys (token.personal.create,
token.personal.revoke). Service accounts and other people's keys need
token.create / token.revoke.

Personal API keys — act as YOU, and die with your membership:
  ls [--mine] [--all] [--json]      List the account's keys. --mine narrows to
                                    the ones you minted yourself. Keys that
                                    cannot authenticate are hidden; --all
                                    lists them too.
  new <name> [--expires <when>]     Mint a key. The secret prints ONCE.
      [--project <id>]              Bind the key to one project (it can never
                                    reach another).
  rm <token-id> [-y] [--force]      Revoke a key; delete it if already revoked.
                                    Refuses the key this CLI is signed in
                                    with unless --force.

Service accounts — act as THEMSELVES, with no inherited access:
  service-accounts ls [--json]              List service accounts.
  service-accounts new <name>               Create one. The bearer prints ONCE.
      [--description <t>] [--expires <when>]
  service-accounts disable <id>             Disable the service account (it
                                            cannot authorize; delete and
                                            re-create to return).
  service-accounts rm <id> [-y]             Delete permanently.

Connected apps — apps you approved with "Sign in with Kortix" (MCP clients
such as Claude Code or Cursor). Yours, across every account:
  apps ls [--json]                  List them.
  apps rm <client-id> [-y]          Revoke one: its tokens stop working at
                                    once, and it must ask you again.

A new service account holds NO permissions. Grant it one with
\`kortix access grant --service-account <id> --role <key>\`.

Options:
  --mine              ls: only the keys you minted.
  --all               ls: with --mine, also list the keys that cannot
                      authenticate (revoked, or revoked_at stamped on a row
                      still reading active).
  --expires <when>    ISO-8601, or a forward span: 30d, 12h, 6w, 1y.
  --project <id>      new: bind the key to one project.
  --description <t>   service-accounts new: what this identity is for.
  --account <id>      Operate on this account (default: the active account).
  --host <name>       Operate against a non-default Kortix host.
  --json              Machine-readable output. List rows of both kinds
                      carry a shared \`id\`.
  -y, --yes           Skip the confirmation prompt.
  -h, --help          Show this help.

Examples:
  kortix tokens ls --mine
  kortix tokens new ci-deploy --expires 90d
  kortix tokens new laptop --project 1a2b… --expires 2027-01-01
  kortix tokens apps ls
  kortix tokens service-accounts new nightly-reporter --description "Cron"
  kortix access grant --service-account <id> --role member --project 1a2b…
`;

export async function runTokens(argv: string[]): Promise<number> {
  const helpCode = splitHelp(argv, HELP);
  if (helpCode !== null) return helpCode;

  const sub = argv[0];
  const rest = argv.slice(1);
  const f: Record<string, string | undefined> = {};
  let json = false;
  let mine = false;
  let all = false;
  let yes = false;
  let force = false;
  try {
    f.account = takeFlagValue(rest, ['--account']);
    f.host = takeFlagValue(rest, ['--host']);
    f.expires = takeFlagValue(rest, ['--expires']);
    f.project = takeFlagValue(rest, ['--project']);
    f.description = takeFlagValue(rest, ['--description', '--desc']);
    json = takeFlagBool(rest, ['--json']);
    mine = takeFlagBool(rest, ['--mine']);
    all = takeFlagBool(rest, ['--all']);
    yes = takeFlagBool(rest, ['-y', '--yes']);
    force = takeFlagBool(rest, ['--force']);
  } catch (err) {
    return fail((err as Error).message);
  }
  const positional = rest.filter((a) => !a.startsWith('-'));

  let expiresAt: string | undefined;
  if (f.expires !== undefined) {
    const iso = resolveExpiry(f.expires);
    if (!iso)
      return fail(
        `--expires "${f.expires}" is not an ISO-8601 instant or a span like 30d/12h/6w/1y.`,
      );
    expiresAt = iso;
  }

  const ctx = resolveAccountContext({
    accountArg: f.account,
    hostArg: f.host,
    accountOptional: sub === 'apps',
  });
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
        // `?mine=true` keeps dead keys as history — the settings page renders
        // them muted — but a CLI list means "keys that still authenticate":
        // status='active' AND revoked_at null, the server's own live predicate
        // (listAccountTokens / validateAccountToken / isRevokedRow in
        // apps/api/src/repositories/account-tokens.ts; the two columns are not
        // tied by any DB constraint, so both halves are needed). `--all` brings
        // the history back.
        const visible =
          mine && !all
            ? tokens.filter((t) => t.status === 'active' && !t.revoked_at)
            : tokens;
        const hidden = tokens.length - visible.length;
        if (json) {
          // `id` is the key every token kind shares (KRTX-2829); `token_id` stays.
          emitJson(visible.map((t) => ({ id: t.token_id, ...t })));
          return 0;
        }
        if (visible.length === 0) {
          process.stdout.write(
            `\n  ${C.dim}No API keys${mine ? ' minted by you' : ''}. Mint one with ` +
              `${C.reset}${C.cyan}kortix tokens new <name>${C.reset}\n`,
          );
          if (hidden > 0) {
            process.stdout.write(
              `  ${C.dim}${hidden} revoked key${hidden === 1 ? '' : 's'} hidden — list them with ` +
                `${C.reset}${C.cyan}kortix tokens ls --all${C.reset}\n`,
            );
          }
          process.stdout.write('\n');
          return 0;
        }
        const nameW = Math.max(...visible.map((t) => t.name.length), 4);
        const keyW = Math.max(...visible.map((t) => t.public_key.length), 6);
        process.stdout.write('\n');
        process.stdout.write(
          `  ${C.dim}${pad('NAME', nameW)}   ${pad('PUBLIC KEY', keyW)}   ${pad('STATUS', 7)}   ${pad('EXPIRES', 10)}   TOKEN ID${C.reset}\n`,
        );
        for (const t of visible) {
          const state = t.status === 'active' ? t.status : `${C.yellow}${t.status}${C.reset}`;
          process.stdout.write(
            `  ${pad(t.name, nameW)}   ${pad(t.public_key, keyW)}   ${pad(state, 7)}   ` +
              `${pad(t.expires_at ? t.expires_at.slice(0, 10) : 'never', 10)}   ${C.faded}${t.token_id}${C.reset}\n`,
          );
        }
        const count =
          hidden > 0
            ? `${visible.length} key${visible.length === 1 ? '' : 's'} · ${hidden} revoked hidden (--all lists them)`
            : `${visible.length} key${visible.length === 1 ? '' : 's'}`;
        process.stdout.write(`\n  ${C.dim}${count}${C.reset}\n\n`);
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

      case 'apps':
        return await connectedApps(ctx.client, positional, { json, yes });

      case 'rm':
      case 'revoke':
      case 'delete':
        return await revokeToken(ctx.client, positional, { yes, force });

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

/** `kortix tokens rm` — revoke a key, or delete an already-revoked personal key. */
async function revokeToken(
  client: NonNullable<ReturnType<typeof resolveAccountContext>>['client'],
  positional: string[],
  opts: { yes: boolean; force: boolean },
): Promise<number> {
  const tokenId = positional[0];
  if (!tokenId) return missing('a token id (see `kortix tokens ls`)');
  // Revoking the key this CLI signs in with locks the host out: every next
  // command answers "token rejected" (KRTX-1842). `/accounts/me` names the
  // calling token; a failed probe never blocks the revoke.
  if (!opts.force) {
    const me = await client
      .get<{ token_context?: { token_id?: string | null } }>('/accounts/me')
      .catch(() => null);
    if (me?.token_context?.token_id === tokenId) {
      process.stderr.write(
        `${status.err(`${tokenId} is the key this CLI is signed in with.`)} Revoking it signs this host out. ` +
          `Sign in with another key first (${C.cyan}kortix login${C.reset}), or pass ${C.cyan}--force${C.reset} to revoke it anyway.\n`,
      );
      return 2;
    }
  }
  if (!opts.yes) {
    const ok = await confirm(
      `Revoke API key ${C.bold}${tokenId}${C.reset}, or permanently delete it if already revoked?`,
      false,
      { onEndOfInput: false },
    );
    if (!ok) {
      process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
      return 0;
    }
  }
  const tokens = await client.get<AccountToken[]>('/accounts/tokens?mine=true');
  const token = tokens.find((row) => row.token_id === tokenId);
  const query = token?.status === 'revoked' ? '?delete_revoked=true' : '';
  let deleted = false;
  try {
    const result = await client.delete<{ deleted?: boolean }>(
      `/accounts/tokens/${encodeURIComponent(tokenId)}${query}`,
    );
    deleted = result.deleted === true;
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404 || !token) throw error;
    // A lost response can replay a completed operation. Verify its intended
    // result without issuing a second, different mutation.
    const remaining = await client.get<AccountToken[]>('/accounts/tokens?mine=true');
    const current = remaining.find((row) => row.token_id === tokenId);
    deleted = token.status === 'revoked';
    if (deleted ? current !== undefined : current?.status !== 'revoked') throw error;
  }
  process.stdout.write(`${status.ok(`${deleted ? 'Deleted' : 'Revoked'} ${C.bold}${tokenId}${C.reset}`)}\n`);
  return 0;
}

/** `kortix tokens apps` — OAuth grants you approved ("Sign in with Kortix"). */
async function connectedApps(
  client: NonNullable<ReturnType<typeof resolveAccountContext>>['client'],
  positional: string[],
  opts: { json: boolean; yes: boolean },
): Promise<number> {
  const action = positional[0] ?? 'ls';
  if (action === 'ls' || action === 'list') {
    const { grants } = await client.get<{ grants: ConnectedApp[] }>('/oauth/grants');
    if (opts.json) {
      emitJson(grants);
      return 0;
    }
    if (grants.length === 0) {
      process.stdout.write(`\n  ${C.dim}No connected apps.${C.reset}\n\n`);
      return 0;
    }
    const label = (g: ConnectedApp) =>
      g.self_registered ? `${g.name} ${C.yellow}(unverified)${C.reset}` : g.name;
    const nameW = Math.max(...grants.map((g) => visibleWidth(label(g))), 4);
    process.stdout.write('\n');
    process.stdout.write(
      `  ${C.dim}${pad('NAME', nameW)}   ${pad('SIGNS IN AT', 22)}   ${pad('LAST ACTIVE', 11)}   CLIENT ID${C.reset}\n`,
    );
    for (const g of grants) {
      process.stdout.write(
        `  ${pad(label(g), nameW)}   ${pad(g.redirect_hosts.join(', ') || '-', 22)}   ` +
          `${pad((g.last_active_at ?? g.granted_at ?? '-').slice(0, 10), 11)}   ${C.faded}${g.client_id}${C.reset}\n`,
      );
    }
    process.stdout.write(
      `\n  ${C.dim}${grants.length} app${grants.length === 1 ? '' : 's'}${C.reset}\n\n`,
    );
    return 0;
  }
  if (action === 'rm' || action === 'revoke') {
    const clientId = positional[1];
    if (!clientId) return missing('a client id (see `kortix tokens apps ls`)');
    if (!opts.yes) {
      const ok = await confirm(
        `Revoke ${C.bold}${clientId}${C.reset}? It loses access to your account at once.`,
        false,
        { onEndOfInput: false },
      );
      if (!ok) {
        process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
        return 0;
      }
    }
    const r = await client.delete<{ revoked_tokens: number }>(
      `/oauth/grants/${encodeURIComponent(clientId)}`,
    );
    if (opts.json) {
      emitJson(r);
      return 0;
    }
    process.stdout.write(
      `${status.ok(`Revoked ${C.bold}${clientId}${C.reset} (${r.revoked_tokens} live token${r.revoked_tokens === 1 ? '' : 's'})`)}\n`,
    );
    return 0;
  }
  return fail(`Unknown \`tokens apps\` action "${action}". Use ls or rm.`);
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
        // The same shared `id` as `tokens ls --json`; `service_account_id` stays.
        emitJson(rows.map((r) => ({ id: r.service_account_id, ...r })));
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
      return fail(`unknown service-accounts verb "${verb}" — use ls|new|disable|rm`);
  }
}
