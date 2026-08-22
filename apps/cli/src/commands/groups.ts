import type { ApiClient } from '../api/client.ts';
import {
  emitJson,
  resolveAccountContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { iamBase, resolveUserId, UUID_RE } from '../iam.ts';
import { confirm } from '../prompts.ts';
import { C, help, pad, status } from '../style.ts';

// `kortix groups` — account groups, the principal you grant a role to when the
// role should follow a TEAM rather than a person.
//
// A group holds members; `kortix access grant --group <id> --role <r>` binds it
// to the account or to one project. That binding lives in the one grant table,
// so it is `kortix access`'s job, not this command's — `groups projects` only
// READS which projects a group reaches.
//
// A group whose `source` is `scim` is owned by the identity provider: renames
// and membership edits 409 with `group_idp_managed`. Change those in the IdP.

interface GroupRow {
  group_id: string;
  name: string;
  description?: string | null;
  source?: string;
  external_id?: string | null;
  member_count?: number;
  project_count?: number;
  created_at?: string;
  updated_at?: string;
}

interface GroupMemberRow {
  user_id: string;
  added_at: string;
  added_by: string | null;
}

interface GroupProjectGrant {
  project_id: string;
  project_name: string;
  role: string;
  granted_by: string | null;
  created_at: string;
  expires_at: string | null;
}

interface AccountMemberRow {
  user_id: string;
  email: string | null;
}

const HELP = help`Usage: kortix groups <subcommand> [options]

Account groups — a named set of people you grant a role to once. Reads need
group.read; create/rename/add need group.update or group.members.manage plus
the Enterprise \`rbac\` entitlement. Delete and remove-member are cleanup and
are never entitlement-gated.

Groups:
  ls [--json]                       List groups with member + project counts.
  create <name> [--description <t>] Create a group.
  set <group> [--name <n>]          Rename / re-describe a group.
      [--description <t>|--no-description]
  rm <group> [-y]                   Delete a group (its grants go with it).

Membership:
  members <group> [--json]          List a group's members.
  add <group> <user>...             Add one or more people.
  remove <group> <user>             Remove one person.

Reach:
  projects <group> [--json]         Which projects this group reaches, and at
                                    what role.

Bind a group to a scope with \`kortix access grant --group <id> --role <key>\`;
revoke with \`kortix access revoke <assignment-id>\`.

Options:
  --name <n>          New group name (set).
  --description <t>   Description (create, set).
  --no-description    Clear the description (set).
  --account <id>      Operate on this account (default: the active account).
  --host <name>       Operate against a non-default Kortix host.
  --json              Machine-readable output (read subcommands).
  -y, --yes           Skip the confirmation prompt.
  -h, --help          Show this help.

A <group> is a group id or its exact name. A <user> is a user id or the email
of someone already in the account.

Examples:
  kortix groups ls
  kortix groups create Engineering --description "Everyone who ships code"
  kortix groups add Engineering alice@corp.com bob@corp.com
  kortix groups projects Engineering
  kortix access grant --group Engineering --role member --project 1a2b…
`;

export async function runGroups(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  const f: Record<string, string | undefined> = {};
  let json = false;
  let yes = false;
  let clearDescription = false;
  try {
    f.account = takeFlagValue(rest, ['--account']);
    f.host = takeFlagValue(rest, ['--host']);
    f.name = takeFlagValue(rest, ['--name']);
    f.description = takeFlagValue(rest, ['--description', '--desc']);
    clearDescription = takeFlagBool(rest, ['--no-description', '--no-desc']);
    json = takeFlagBool(rest, ['--json']);
    yes = takeFlagBool(rest, ['-y', '--yes']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const positional = rest.filter((a) => !a.startsWith('-'));

  const ctx = resolveAccountContext({ accountArg: f.account, hostArg: f.host });
  if (!ctx) return 1;
  const base = `${iamBase(ctx.accountId)}/groups`;

  try {
    switch (sub) {
      case 'ls':
      case 'list': {
        const { groups } = await ctx.client.get<{ groups: GroupRow[] }>(base);
        if (json) {
          emitJson(groups);
          return 0;
        }
        if (groups.length === 0) {
          process.stdout.write(
            `\n  ${C.dim}No groups. Create one with ${C.reset}${C.cyan}kortix groups create <name>${C.reset}\n\n`,
          );
          return 0;
        }
        const nameW = Math.max(...groups.map((g) => g.name.length), 4);
        process.stdout.write('\n');
        process.stdout.write(
          `  ${C.dim}${pad('NAME', nameW)}   ${pad('MEMBERS', 7)}   ${pad('PROJECTS', 8)}   ${pad('SOURCE', 6)}   GROUP ID${C.reset}\n`,
        );
        for (const g of groups) {
          process.stdout.write(
            `  ${pad(g.name, nameW)}   ${pad(String(g.member_count ?? 0), 7)}   ` +
              `${pad(String(g.project_count ?? 0), 8)}   ${pad(g.source ?? 'local', 6)}   ` +
              `${C.faded}${g.group_id}${C.reset}\n`,
          );
        }
        process.stdout.write(
          `\n  ${C.dim}${groups.length} group${groups.length === 1 ? '' : 's'}${C.reset}\n\n`,
        );
        return 0;
      }

      case 'create':
      case 'new': {
        const name = positional[0];
        if (!name) return missing('a group name');
        const group = await ctx.client.post<GroupRow>(base, {
          name,
          ...(f.description !== undefined ? { description: f.description } : {}),
        });
        if (json) {
          emitJson(group);
          return 0;
        }
        process.stdout.write(
          `${status.ok(`Created group ${C.bold}${group.name}${C.reset}  ${C.faded}${group.group_id}${C.reset}`)}\n`,
        );
        process.stdout.write(
          `  ${C.dim}Add people with ${C.reset}${C.cyan}kortix groups add ${group.name} <email>${C.reset}\n`,
        );
        return 0;
      }

      case 'set':
      case 'update': {
        const ref = positional[0];
        if (!ref) return missing('a group id or name');
        if (f.name === undefined && f.description === undefined && !clearDescription) {
          return missing('--name, --description or --no-description');
        }
        if (f.description !== undefined && clearDescription) {
          process.stderr.write(
            `${status.err('--description and --no-description are mutually exclusive.')}\n`,
          );
          return 2;
        }
        const group = await resolveGroup(ctx.client, base, ref);
        if (!group) return 1;
        const body: Record<string, unknown> = {};
        if (f.name !== undefined) body.name = f.name;
        if (f.description !== undefined) body.description = f.description;
        if (clearDescription) body.description = null;
        const updated = await ctx.client.patch<GroupRow>(
          `${base}/${encodeURIComponent(group.group_id)}`,
          body,
        );
        if (json) {
          emitJson(updated);
          return 0;
        }
        process.stdout.write(`${status.ok(`Updated group ${C.bold}${updated.name}${C.reset}`)}\n`);
        return 0;
      }

      case 'rm':
      case 'remove-group':
      case 'delete': {
        const ref = positional[0];
        if (!ref) return missing('a group id or name');
        const group = await resolveGroup(ctx.client, base, ref);
        if (!group) return 1;
        if (!yes) {
          const ok = await confirm(
            `Delete group ${C.bold}${group.name}${C.reset}? Every role it grants goes with it.`,
            false,
            { onEndOfInput: false },
          );
          if (!ok) {
            process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
            return 0;
          }
        }
        await ctx.client.delete(`${base}/${encodeURIComponent(group.group_id)}`);
        process.stdout.write(`${status.ok(`Deleted group ${C.bold}${group.name}${C.reset}`)}\n`);
        return 0;
      }

      case 'members': {
        const ref = positional[0];
        if (!ref) return missing('a group id or name');
        const group = await resolveGroup(ctx.client, base, ref);
        if (!group) return 1;
        const { members } = await ctx.client.get<{ members: GroupMemberRow[] }>(
          `${base}/${encodeURIComponent(group.group_id)}/members`,
        );
        if (json) {
          emitJson(members);
          return 0;
        }
        if (members.length === 0) {
          process.stdout.write(`\n  ${C.dim}${group.name} has no members.${C.reset}\n\n`);
          return 0;
        }
        const emails = await emailMap(ctx.client, ctx.accountId);
        const label = (m: GroupMemberRow) => emails.get(m.user_id) ?? m.user_id;
        const w = Math.max(...members.map((m) => label(m).length), 6);
        process.stdout.write('\n');
        process.stdout.write(
          `  ${C.dim}${pad('MEMBER', w)}   ${pad('ADDED', 10)}   USER ID${C.reset}\n`,
        );
        for (const m of members) {
          process.stdout.write(
            `  ${pad(label(m), w)}   ${pad(m.added_at.slice(0, 10), 10)}   ${C.faded}${m.user_id}${C.reset}\n`,
          );
        }
        process.stdout.write(
          `\n  ${C.dim}${members.length} member${members.length === 1 ? '' : 's'} in ${group.name}${C.reset}\n\n`,
        );
        return 0;
      }

      case 'add': {
        const ref = positional[0];
        if (!ref) return missing('a group id or name');
        const who = positional.slice(1);
        if (who.length === 0) return missing('at least one user id or email');
        const group = await resolveGroup(ctx.client, base, ref);
        if (!group) return 1;
        const userIds: string[] = [];
        for (const w of who) {
          const id = await resolveUserId(ctx.client, ctx.accountId, w);
          if (!id) return 1;
          userIds.push(id);
        }
        const result = await ctx.client.post<{ added: number }>(
          `${base}/${encodeURIComponent(group.group_id)}/members`,
          { userIds },
        );
        if (json) {
          emitJson(result);
          return 0;
        }
        process.stdout.write(
          `${status.ok(`${result.added} added to ${C.bold}${group.name}${C.reset}${result.added < userIds.length ? ` ${C.faded}(${userIds.length - result.added} already a member)${C.reset}` : ''}`)}\n`,
        );
        return 0;
      }

      case 'remove': {
        const ref = positional[0];
        if (!ref) return missing('a group id or name');
        const who = positional[1];
        if (!who) return missing('a user id or email');
        const group = await resolveGroup(ctx.client, base, ref);
        if (!group) return 1;
        const userId = await resolveUserId(ctx.client, ctx.accountId, who);
        if (!userId) return 1;
        await ctx.client.delete(
          `${base}/${encodeURIComponent(group.group_id)}/members/${encodeURIComponent(userId)}`,
        );
        process.stdout.write(
          `${status.ok(`Removed ${C.bold}${who}${C.reset} from ${C.bold}${group.name}${C.reset}`)}\n`,
        );
        return 0;
      }

      case 'projects':
      case 'grants': {
        const ref = positional[0];
        if (!ref) return missing('a group id or name');
        const group = await resolveGroup(ctx.client, base, ref);
        if (!group) return 1;
        const { grants } = await ctx.client.get<{ grants: GroupProjectGrant[] }>(
          `${base}/${encodeURIComponent(group.group_id)}/project-grants`,
        );
        if (json) {
          emitJson(grants);
          return 0;
        }
        if (grants.length === 0) {
          process.stdout.write(
            `\n  ${C.dim}${group.name} reaches no projects. Grant one with ` +
              `${C.reset}${C.cyan}kortix access grant --group ${group.group_id} --role member --project <id>${C.reset}\n\n`,
          );
          return 0;
        }
        const nameW = Math.max(...grants.map((g) => g.project_name.length), 7);
        process.stdout.write('\n');
        process.stdout.write(
          `  ${C.dim}${pad('PROJECT', nameW)}   ${pad('ROLE', 8)}   ${pad('EXPIRES', 10)}   PROJECT ID${C.reset}\n`,
        );
        for (const g of grants) {
          process.stdout.write(
            `  ${pad(g.project_name, nameW)}   ${pad(g.role, 8)}   ` +
              `${pad(g.expires_at ? g.expires_at.slice(0, 10) : 'never', 10)}   ${C.faded}${g.project_id}${C.reset}\n`,
          );
        }
        process.stdout.write(
          `\n  ${C.dim}${grants.length} project${grants.length === 1 ? '' : 's'}${C.reset}\n\n`,
        );
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

/** Resolve `<group>` — a uuid passes through after a lookup, anything else is
 *  matched against the group list by exact name. */
async function resolveGroup(
  client: ApiClient,
  base: string,
  ref: string,
): Promise<GroupRow | null> {
  const { groups } = await client.get<{ groups: GroupRow[] }>(base);
  const hit =
    groups.find((g) => g.group_id === ref) ??
    groups.find((g) => g.name === ref) ??
    groups.find((g) => g.name.toLowerCase() === ref.trim().toLowerCase());
  if (hit) return hit;
  process.stderr.write(
    `${status.err(`No group "${ref}" in this account.`)}` +
      (UUID_RE.test(ref) ? '' : ` Run ${C.cyan}kortix groups ls${C.reset}.`) +
      '\n',
  );
  return null;
}

/** user-id → email, for a readable member listing. Best effort. */
async function emailMap(client: ApiClient, accountId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const members = await client
    .get<AccountMemberRow[]>(`/accounts/${encodeURIComponent(accountId)}/members`)
    .catch(() => [] as AccountMemberRow[]);
  for (const m of members) if (m.email) out.set(m.user_id, m.email);
  return out;
}

function missing(what: string): number {
  process.stderr.write(`${status.err(`Pass ${what}.`)}\n`);
  return 2;
}
