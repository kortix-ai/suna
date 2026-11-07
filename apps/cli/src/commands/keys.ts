import { splitHelp } from '../command-argv.ts';
import {
  emitJson,
  fail,
  missing,
  resolveAccountContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { confirm } from '../prompts.ts';
import { C, help, pad, status } from '../style.ts';
import { parseScopeFlag, resolveExpiry } from './tokens.ts';

// `kortix keys` — Workspace settings › API keys from the terminal. One list of
// the workspace's keys, and one create that asks who the key acts as:
//
//   --as me            you, in your current role; revoked when you leave
//   --as agent:<name>  a kortix.yaml agent's own identity (its grant ∩ its role)
//   --as bot:<name>    a bot for CI or an integration (its roles); a new name
//                      creates the bot with the Member role
//
// Agent and bot keys need token.create. No agent or bot key mints a key.

/** Who `--as` names. */
export type ActsAs = { type: 'me' } | { type: 'agent'; agent: string } | { type: 'bot'; bot: string };

/** Parse `--as`: `me`, `agent:<name>` or `bot:<name>`. Null for anything else. */
export function parseActsAs(input: string | undefined): ActsAs | null {
  const value = (input ?? 'me').trim();
  if (value === 'me' || value === '') return { type: 'me' };
  const colon = value.indexOf(':');
  if (colon < 0) return null;
  const kind = value.slice(0, colon).trim();
  const name = value.slice(colon + 1).trim();
  if (!name) return null;
  if (kind === 'agent') return { type: 'agent', agent: name };
  if (kind === 'bot') return { type: 'bot', bot: name };
  return null;
}

/** The ACTS AS column: `you`, `agent:<name>` or `bot:<name>`. */
export function actsAsLabel(actsAs: { type: string; name: string | null }): string {
  if (actsAs.type === 'me') return 'you';
  return `${actsAs.type}:${actsAs.name ?? '?'}`;
}

interface WorkspaceKey {
  key_id: string;
  name: string;
  acts_as: { type: 'me' | 'agent' | 'bot'; name: string | null; service_account_id: string | null };
  credential: 'token' | 'service_account_bearer';
  public_key: string;
  status: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
  created_by_email: string | null;
  scope: 'full' | 'read' | 'custom';
  workspace_permissions: string[] | null;
  secret_key?: string;
}

interface KeyList {
  keys: WorkspaceKey[];
  can_manage_principals: boolean;
  agents: Array<{ name: string }>;
  bots: Array<{ bot_id: string; name: string; has_role: boolean }>;
}

function scopeLabel(k: WorkspaceKey): string {
  return k.scope === 'custom' ? `custom (${k.workspace_permissions?.length ?? 0})` : k.scope;
}

function stateOf(k: WorkspaceKey, now = Date.now()): string {
  if (k.status !== 'active' || k.revoked_at) return 'revoked';
  if (k.expires_at && Date.parse(k.expires_at) <= now) return 'expired';
  return 'active';
}

const HELP = help`Usage: kortix keys <subcommand> [options]

The API keys of this workspace: one list, and a create that asks who the key
acts as. Every member manages their own keys. Keys that act as an agent or a
bot need token.create.

Subcommands:
  ls [--all] [--json]                List the keys you may see. --all also
                                     lists revoked and expired keys.
  create <name> [--as <who>]         Create a key. The secret prints ONCE.
      [--scope read|full|<list>]     Default scope: full. Default expiry: 90
      [--expires <when>]             days; at most 365.
  rm <key-id> [-y]                   Revoke a key.

Who a key acts as (--as):
  me                 You, in your current role. Revoked when you leave.
  agent:<name>       A kortix.yaml agent: its grant, inside its role. It keeps
                     working when the person who created it leaves.
  bot:<name>         A bot for CI or an integration: its roles. A new name
                     creates the bot with the Member role.

Options:
  --scope <s>        full, read (every *.read permission; GET only), or a
                     comma-separated permission list inside the principal's rights.
  --expires <when>   ISO-8601, a forward span (30d, 12h, 6w, 1y), or never
                     (only where the workspace key policy allows it).
  --workspace <id>   The workspace (default: the active one).
  --host <name>      Operate against a non-default Kortix host.
  --json             Machine-readable output.
  -y, --yes          Skip the confirmation prompt.
  -h, --help         Show this help.

Examples:
  kortix keys ls
  kortix keys create laptop
  kortix keys create nightly --as agent:reporter --scope read
  kortix keys create deploy --as bot:github-actions --expires 30d
  kortix keys rm 1a2b…
`;

export async function runKeys(argv: string[]): Promise<number> {
  const helpCode = splitHelp(argv, HELP);
  if (helpCode !== null) return helpCode;
  const sub = argv[0];
  const rest = argv.slice(1);
  const f: Record<string, string | undefined> = {};
  let json = false;
  let all = false;
  let yes = false;
  try {
    f.as = takeFlagValue(rest, ['--as']);
    f.scope = takeFlagValue(rest, ['--scope', '--scopes']);
    f.expires = takeFlagValue(rest, ['--expires']);
    f.workspace = takeFlagValue(rest, ['--workspace', '--project']);
    f.account = takeFlagValue(rest, ['--account']);
    f.host = takeFlagValue(rest, ['--host']);
    json = takeFlagBool(rest, ['--json']);
    all = takeFlagBool(rest, ['--all']);
    yes = takeFlagBool(rest, ['-y', '--yes']);
  } catch (err) {
    return fail((err as Error).message);
  }
  const positional = rest.filter((a) => !a.startsWith('-'));
  const ctx = resolveAccountContext({ workspaceArg: f.workspace, accountArg: f.account, hostArg: f.host });
  if (!ctx) return 1;
  const base = `/workspaces/${encodeURIComponent(ctx.accountId)}/keys`;

  try {
    switch (sub) {
      case undefined:
      case 'ls':
      case 'list': {
        const list = await ctx.client.get<KeyList>(base);
        const visible = all ? list.keys : list.keys.filter((k) => stateOf(k) === 'active');
        if (json) {
          emitJson({ ...list, keys: visible });
          return 0;
        }
        if (visible.length === 0) {
          process.stdout.write(`\n  ${C.dim}No API keys. Create one with ${C.reset}${C.cyan}kortix keys create <name>${C.reset}\n`);
        } else {
          const nameW = Math.max(...visible.map((k) => k.name.length), 4);
          const asW = Math.max(...visible.map((k) => actsAsLabel(k.acts_as).length), 7);
          process.stdout.write('\n');
          process.stdout.write(
            `  ${C.dim}${pad('NAME', nameW)}   ${pad('ACTS AS', asW)}   ${pad('SCOPE', 10)}   ${pad('EXPIRES', 10)}   ${pad('LAST USED', 10)}   KEY ID${C.reset}\n`,
          );
          for (const k of visible) {
            const state = stateOf(k);
            const expires = state === 'active' ? (k.expires_at?.slice(0, 10) ?? 'never') : `${C.yellow}${state}${C.reset}`;
            process.stdout.write(
              `  ${pad(k.name, nameW)}   ${pad(actsAsLabel(k.acts_as), asW)}   ${pad(scopeLabel(k), 10)}   ${pad(expires, 10)}   ` +
                `${pad(k.last_used_at?.slice(0, 10) ?? 'never', 10)}   ${C.faded}${k.key_id}${C.reset}\n`,
            );
          }
        }
        if (list.can_manage_principals && list.agents.length > 0) {
          process.stdout.write(
            `\n  ${C.dim}A key can act as an agent:${C.reset} ${list.agents.map((a) => `agent:${a.name}`).join(', ')}\n`,
          );
        }
        process.stdout.write('\n');
        return 0;
      }

      case 'create':
      case 'new': {
        const name = positional[0];
        if (!name) return missing('a key name');
        const actsAs = parseActsAs(f.as);
        if (!actsAs) return fail(`--as "${f.as}" is not me, agent:<name> or bot:<name>.`);
        const scopes = f.scope !== undefined ? parseScopeFlag(f.scope) : undefined;
        if (scopes === null) return fail('--scope needs full, read, or a comma-separated list of permissions.');
        let expiresAt: string | null | undefined;
        if (f.expires !== undefined && f.expires.trim() === 'never') expiresAt = null;
        else if (f.expires !== undefined) {
          const iso = resolveExpiry(f.expires);
          if (!iso) return fail(`--expires "${f.expires}" is not an ISO-8601 instant or a span like 30d/12h/6w/1y.`);
          expiresAt = iso;
        }
        const created = await ctx.client.post<WorkspaceKey>(base, {
          name,
          acts_as: actsAs.type,
          ...(actsAs.type === 'agent' ? { agent: actsAs.agent } : {}),
          ...(actsAs.type === 'bot' ? { bot: actsAs.bot } : {}),
          ...(scopes !== undefined ? { scopes } : {}),
          ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
        });
        if (json) {
          emitJson(created);
          return 0;
        }
        process.stdout.write(`${status.ok(`Created ${C.bold}${created.name}${C.reset}`)}\n\n`);
        process.stdout.write(`  ${created.secret_key ?? '(no secret returned)'}\n\n`);
        process.stdout.write(`${status.warn('This is the only time the secret is shown. Store it now.')}\n`);
        process.stdout.write(`  ${C.dim}acts as  ${C.reset}${actsAsLabel(created.acts_as)}\n`);
        process.stdout.write(`  ${C.dim}scope    ${C.reset}${scopeLabel(created)}\n`);
        process.stdout.write(`  ${C.dim}expires  ${C.reset}${created.expires_at?.slice(0, 10) ?? 'never'}\n`);
        process.stdout.write(`  ${C.dim}key id   ${C.reset}${created.key_id}\n`);
        return 0;
      }

      case 'rm':
      case 'revoke': {
        const keyId = positional[0];
        if (!keyId) return missing('a key id (see `kortix keys ls`)');
        if (!yes) {
          const ok = await confirm(`Revoke API key ${C.bold}${keyId}${C.reset}? Requests with it stop at once.`, false, {
            onEndOfInput: false,
          });
          if (!ok) {
            process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
            return 0;
          }
        }
        await ctx.client.delete(`${base}/${encodeURIComponent(keyId)}`);
        process.stdout.write(`${status.ok(`Revoked ${C.bold}${keyId}${C.reset}`)}\n`);
        return 0;
      }

      default:
        process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    return surfaceApiError(err);
  }
}
