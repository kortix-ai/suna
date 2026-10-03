import { loadAuth, loadAuthForHost, type Auth } from '../api/auth.ts';
import { activeHostName, defaultProject, listHosts } from '../api/config.ts';
import { ApiError, clientFromAuth } from '../api/client.ts';
import { takeFlags } from '../command-argv.ts';
import { emitJson, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { C, help, status } from '../style.ts';
import type { AccountMembership, MeResponse } from '../api/types.ts';
import type { DefaultProjectRef } from '@kortix/shared/host-config';

const HELP = help`Usage: kortix whoami [options]

Print the currently authenticated user + active account on the
selected host.

Shortcut for the active host — same as \`kortix hosts whoami\`. Use
\`kortix hosts whoami <name>\` to probe a different instance.

Options:
  --host <name>     Probe a specific host (default: active).
  --json            Machine-readable JSON output.
  --token-only      Print only the active token context.
  -h, --help        Show this help.
`;

export async function runWhoami(argv: string[]): Promise<number> {
  const flags = takeFlags(argv, HELP, (rest) => ({
    host: takeFlagValue(rest, ['--host']),
    json: takeFlagBool(rest, ['--json']),
    tokenOnly: takeFlagBool(rest, ['--token-only']),
  }));
  if (typeof flags === 'number') return flags;
  return performWhoami(flags);
}

interface PerformWhoamiOptions {
  /** Probe a specific host (default: active). */
  host?: string;
  /** Machine-readable JSON output. */
  json: boolean;
  /** Print only the active token context. */
  tokenOnly: boolean;
}

/**
 * Shared whoami implementation used by both the top-level `kortix whoami`
 * alias and the `kortix hosts whoami` subcommand. Resolves the identity
 * for the named host (default: active) and renders it (human, JSON, or
 * token-only).
 */
export async function performWhoami(opts: PerformWhoamiOptions): Promise<number> {
  const auth = opts.host ? loadAuthForHost(opts.host) : loadAuth();
  if (!auth?.token) {
    if (opts.host) {
      process.stderr.write(
        `${status.err(`Host "${opts.host}" is not logged in.`)} Run ` +
          `${C.cyan}kortix hosts login ${opts.host}${C.reset}.\n`,
      );
    } else {
      process.stderr.write(`${status.err('Not logged in. Run `kortix login`.')}\n`);
    }
    return 1;
  }

  let me: MeResponse;
  try {
    me = await clientFromAuth(auth).get<MeResponse>('/accounts/me');
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

  const resolvedHost = opts.host ?? activeHostName();
  const active = me.accounts.find((a) => a.account_id === auth.account_id) ?? me.accounts[0];
  // Default project is read from the active host only (a --host probe shows
  // the other host's identity, not this machine's active default).
  const def = opts.host ? null : defaultProject();

  if (opts.json) {
    whoamiJson(me, auth, resolvedHost, active, def);
    return 0;
  }
  if (opts.tokenOnly) {
    whoamiTokenOnly(me);
    return 0;
  }
  whoamiHuman(me, auth, resolvedHost, active, def);
  return 0;
}

/** The machine-readable rendering (`--json`): the raw identity payload. */
function whoamiJson(
  me: MeResponse,
  auth: Auth,
  resolvedHost: string | null,
  active: AccountMembership | undefined,
  def: DefaultProjectRef | null,
): void {
  emitJson({
    host: resolvedHost ?? null,
    url: auth.api_base,
    user_id: me.user_id,
    user_email: me.email || null,
    account_id: active?.account_id ?? auth.account_id ?? null,
    account: active ?? null,
    accounts: me.accounts,
    token_context: me.token_context ?? null,
    default_project: def,
  });
}

/** The `--token-only` rendering: just the active token's context block. */
function whoamiTokenOnly(me: MeResponse): void {
  const ctx = me.token_context;
  const { kind, details } = renderTokenContext(ctx, 'user token');
  process.stdout.write(`\n  ${C.bold}${kind}${C.reset}\n${details}`);
  const permissions = ctx?.kortix_permissions ?? ctx?.kortix_cli;
  if (permissions != null) {
    process.stdout.write(`  ${C.dim}permissions ${C.reset}${formatGrant(permissions)}\n`);
  }
  if (ctx?.env != null) {
    process.stdout.write(`  ${C.dim}env       ${C.reset}${formatGrant(ctx.env)}\n`);
  }
  process.stdout.write('\n');
}

/** The default human rendering: identity, account, then the token context. */
function whoamiHuman(
  me: MeResponse,
  auth: Auth,
  resolvedHost: string | null,
  active: AccountMembership | undefined,
  def: DefaultProjectRef | null,
): void {
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
      `  ${C.dim}${me.accounts.length} accounts total — switch with ${C.reset}${C.cyan}kortix accounts use <slug>${C.reset}\n`,
    );
  }
  if (def) {
    process.stdout.write(
      `  ${C.dim}project   ${C.reset}${def.name || def.project_id} ${C.faded}(default)${C.reset}\n`,
    );
  }
  process.stdout.write(`  ${C.dim}host      ${C.reset}${resolvedHost ?? '—'} ${C.faded}(${auth.api_base})${C.reset}\n`);
  const ctx = me.token_context;
  if (ctx?.project_id || ctx?.session_id || ctx?.agent) {
    const { kind, details } = renderTokenContext(ctx, 'token');
    process.stdout.write(`  ${C.dim}token     ${C.reset}${kind}\n${details}`);
  }
  const totalHosts = listHosts().length;
  if (totalHosts > 1) {
    process.stdout.write(
      `  ${C.dim}${totalHosts} hosts configured — list with \`kortix hosts ls\`${C.reset}\n`,
    );
  }
  process.stdout.write('\n');
}

/**
 * The token-kind label and the project/session/agent/connectors detail lines
 * that the `--token-only` block and the human summary both render.
 *
 * `fallbackKind` exists because the two renderings drifted before they were
 * shared: with no kind in the token context, `--token-only` says `user token`
 * while the human summary's token line says just `token`. Byte-identical
 * output pins them apart, so each caller keeps its own spelling.
 */
function renderTokenContext(
  ctx: MeResponse['token_context'],
  fallbackKind: string,
): { kind: string; details: string } {
  const kind = ctx?.session_id
    ? 'session token'
    : ctx?.project_id
      ? 'project token'
      : ctx?.auth_type || fallbackKind;
  let details = '';
  if (ctx?.project_id) details += `  ${C.dim}project   ${C.reset}${ctx.project_id}\n`;
  if (ctx?.session_id) details += `  ${C.dim}session   ${C.reset}${ctx.session_id}\n`;
  if (ctx?.agent) details += `  ${C.dim}agent     ${C.reset}${ctx.agent}\n`;
  if (ctx?.connectors != null) {
    details += `  ${C.dim}connectors ${C.reset}${formatGrant(ctx.connectors)}\n`;
  }
  return { kind, details };
}

function formatGrant(value: string[] | 'all'): string {
  return value === 'all' ? 'all' : value.length ? value.join(', ') : 'none';
}
