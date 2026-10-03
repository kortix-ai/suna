import type { ApiClient } from '../api/client.ts';
import { splitHelp } from '../command-argv.ts';
import {
  emitJson,
  missing,
  resolveAccountContext,
  surfaceApiError,
  takeFlagValue,
  takeFlagBool,
  fail,
} from '../command-helpers.ts';
import { findRole, type IamRole } from '../iam.ts';
import { C, help, pad, status } from '../style.ts';
import {
  notFound,
  rolesAssignments,
  rolesAssign,
  rolesUnassign,
} from './roles-policies.ts';
import { rolesExport, rolesImport } from './roles-port.ts';

// Account-scoped IAM roles. `ls` / `show` / `permissions` read the whole
// catalog — the seeded SYSTEM roles (owner/admin/member, manager/member,
// agent-user) plus this account's CUSTOM ones. Only custom roles are editable.
//
// Binding a role to a principal is `kortix access grant`, which writes the ONE
// grant table. The `assign` / `unassign` / `assignments` verbs here still write
// the legacy policy store; it dual-writes into the same table, so they keep
// working, but new work should use `kortix access`. Those handlers (and the
// `export` / `import` IAM-as-code port) live in roles-policies.ts /
// roles-port.ts.

type ResourceType = 'account' | 'project' | 'sandbox' | 'trigger' | 'channel' | 'member' | 'group';

interface ActionCatalogEntry {
  action: string;
  label: string;
  resource_type: string;
}

const HELP = help`Usage: kortix roles <subcommand> [options]

A role is a named set of permissions. People, groups and service accounts get
roles; agents get Kortix permissions in kortix.yaml. A session can only do what
both allow.

System roles (owner/admin/member, manager/member, agent-user) are read-only
references; custom roles are yours to create, edit, and bind.

Roles:
  ls [--json]                         List roles (system + custom).
  show <role> [--json]                Show a role's permissions + usage.
  permissions <role> [--json]         List just a role's permissions.
  actions [--json]                    Legacy catalog — use \`kortix permissions ls\`.
  create <key> --name <n> [opts]      Create a custom role.
  edit <role> [--name <n>]            Rename / re-describe a custom role. Its
       [--desc <t>|--no-desc]         key never changes. Needs role.update.
  set-actions <role> --actions a,b    Replace a custom role's permissions.
  rm <role>                           Delete a custom role.

Assignments (legacy policy store — prefer \`kortix access grant\`):
  assignments [--project <id>] [--json]   List policy bindings.
  assign <role> --to <type>:<id> [opts]   Bind a role to a principal.
  unassign <policy-id>                    Remove a binding.

IAM as code:
  export [--project <id>] [--out <file>]  Dump custom roles + bindings to TOML
                                          (or JSON with --format json).
  import <file>                           Apply a roles/policies file (creates
                                          missing roles, then bulk-imports binds).

A <role> may be its key (e.g. "support_agent") or its role id.
A principal is "member:<user-id>", "group:<group-id>", or "token:<sa-id>".

Options:
  --name <n>         Display name (create, edit).
  --desc <text>      Description (create, edit).
  --no-desc          Clear the description (edit).
  --scope <s>        account|project — resource type of a created role,
                     or the scope of an assignment (default: project).
  --actions <list>   Comma-separated action keys (create / set-actions).
  --to <type>:<id>   Principal for an assignment.
  --project <id>     Project id — scope an assignment / filter / export.
  --expires <iso>    Optional hard expiry for an assignment.
  --out <file>       Write export to a file (default: stdout).
  --format <f>       toml (default) | json — export format.
  --account <id>     Operate on this account (default: active account).
  --json             Machine-readable output (read subcommands).
  -h, --help         Show this help.

Examples:
  kortix roles ls
  kortix roles permissions manager
  kortix roles create support_agent --name "Support Agent" \\
    --scope project --actions project.read,project.session.start,project.trigger.fire
  kortix roles assign support_agent --to member:<user-id> --project <project-id>
  kortix roles assignments --project <project-id>
  kortix roles export --out policies.toml
  kortix roles import policies.toml
`;

export async function runRoles(argv: string[]): Promise<number> {
  const helpCode = splitHelp(argv, HELP);
  if (helpCode !== null) return helpCode;
  const sub = argv[0];
  const rest = argv.slice(1);
  const f: Record<string, string | undefined> = {};
  let json = false;
  let clearDesc = false;
  try {
    f.account = takeFlagValue(rest, ['--account']);
    f.name = takeFlagValue(rest, ['--name']);
    f.desc = takeFlagValue(rest, ['--desc', '--description']);
    clearDesc = takeFlagBool(rest, ['--no-desc', '--no-description']);
    f.scope = takeFlagValue(rest, ['--scope']);
    f.actions = takeFlagValue(rest, ['--actions']);
    f.to = takeFlagValue(rest, ['--to']);
    f.project = takeFlagValue(rest, ['--project']);
    f.expires = takeFlagValue(rest, ['--expires']);
    f.out = takeFlagValue(rest, ['--out']);
    f.format = takeFlagValue(rest, ['--format']);
    f.host = takeFlagValue(rest, ['--host']);
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    return fail((err as Error).message);
  }
  const positional = rest.filter((a) => !a.startsWith('-'));

  const ctx = resolveAccountContext({ accountArg: f.account, hostArg: f.host });
  if (!ctx) return 1;
  const base = `/accounts/${ctx.accountId}/iam`;

  try {
    switch (sub) {
      case 'ls':
      case 'list':
        return await rolesLs(ctx.client, base, json);

      case 'show':
        return await rolesShow(ctx.client, base, positional[0], json);

      case 'permissions':
      case 'perms':
        return await rolesPermissions(ctx.client, base, positional[0], json);

      case 'actions':
        return await rolesActions(ctx.client, base, json);

      case 'create':
        return await rolesCreate(ctx.client, base, positional[0], f.name, f.desc, f.scope, f.actions);

      case 'edit':
        return await rolesEdit(ctx.client, base, positional[0], f.name, f.desc, clearDesc, json);

      case 'set-actions':
      case 'set':
        return await rolesSetActions(ctx.client, base, positional[0], f.actions);

      case 'rm':
      case 'remove':
      case 'delete':
        return await rolesRm(ctx.client, base, positional[0]);

      case 'assignments':
      case 'policies':
        return await rolesAssignments(ctx.client, base, f.project, json);

      case 'assign':
        return await rolesAssign(ctx.client, base, positional[0], f.to, f.project, f.scope, f.expires);

      case 'unassign':
        return await rolesUnassign(ctx.client, base, positional[0]);

      case 'export':
        return await rolesExport(ctx.client, base, f.project, f.out, f.format);

      case 'import':
        return await rolesImport(ctx.client, base, positional[0]);

      default:
        process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    return surfaceApiError(err);
  }
}

// ── roles ls ───────────────────────────────────────────────────────────────

async function rolesLs(client: ApiClient, base: string, json: boolean): Promise<number> {
  const { roles } = await client.get<{ roles: IamRole[] }>(`${base}/roles`);
  if (json) return emitJson(roles), 0;
  const keyW = Math.max(...roles.map((r) => r.key.length), 4);
  const nameW = Math.max(...roles.map((r) => r.name.length), 4);
  process.stdout.write('\n');
  process.stdout.write(`  ${C.dim}${pad('KEY', keyW)}   ${pad('NAME', nameW)}   SCOPE      KIND${C.reset}\n`);
  for (const r of roles) {
    const kind = r.is_system ? `${C.faded}system${C.reset}` : `${C.cyan}custom${C.reset}`;
    process.stdout.write(
      `  ${pad(r.key, keyW)}   ${pad(r.name, nameW)}   ${pad(r.resource_type, 8)}   ${kind}\n`,
    );
  }
  process.stdout.write(`\n  ${C.dim}${roles.length} role${roles.length === 1 ? '' : 's'}${C.reset}\n\n`);
  return 0;
}

// ── roles show / permissions ───────────────────────────────────────────────

async function rolesShow(
  client: ApiClient,
  base: string,
  ref: string | undefined,
  json: boolean,
): Promise<number> {
  if (!ref) return missing('a role key or id');
  const { roles } = await client.get<{ roles: IamRole[] }>(`${base}/roles`);
  const role = findRole(roles, ref);
  if (!role) return notFound(`role "${ref}"`);
  const perms = await client.get<{ role_id: string; key: string; actions: string[] }>(
    `${base}/roles/${encodeURIComponent(role.role_id)}/permissions`,
  );
  const usage = await client
    .get<{ policy_count: number }>(`${base}/roles/${encodeURIComponent(role.role_id)}/usage`)
    .catch(() => ({ policy_count: 0 }));
  if (json) return emitJson({ ...role, actions: perms.actions, ...usage }), 0;
  process.stdout.write('\n');
  process.stdout.write(`  ${C.bold}${role.name}${C.reset}  ${C.faded}${role.key}${C.reset}${role.is_system ? `  ${C.faded}(system)${C.reset}` : ''}\n`);
  if (role.description) process.stdout.write(`  ${C.dim}${role.description}${C.reset}\n`);
  process.stdout.write(`  ${C.dim}scope ${role.resource_type} · ${usage.policy_count} assignment${usage.policy_count === 1 ? '' : 's'}${C.reset}\n\n`);
  process.stdout.write(`  ${C.dim}PERMISSIONS (${perms.actions.length})${C.reset}\n`);
  for (const a of perms.actions.slice().sort()) process.stdout.write(`    ${a}\n`);
  process.stdout.write('\n');
  return 0;
}

async function rolesPermissions(
  client: ApiClient,
  base: string,
  ref: string | undefined,
  json: boolean,
): Promise<number> {
  // Just the leaf actions, no usage round-trip — the shape `roles
  // create --actions` / `set-actions --actions` consume.
  if (!ref) return missing('a role key or id');
  const { roles } = await client.get<{ roles: IamRole[] }>(`${base}/roles`);
  const role = findRole(roles, ref);
  if (!role) return notFound(`role "${ref}"`);
  const perms = await client.get<{ role_id: string; key: string; actions: string[] }>(
    `${base}/roles/${encodeURIComponent(role.role_id)}/permissions`,
  );
  const actions = perms.actions.slice().sort();
  if (json) return emitJson({ role_id: role.role_id, key: role.key, is_system: role.is_system, actions }), 0;
  process.stdout.write('\n');
  process.stdout.write(
    `  ${C.bold}${role.key}${C.reset}  ${C.faded}${role.resource_type} scope${role.is_system ? ' · system' : ''}${C.reset}\n\n`,
  );
  for (const a of actions) process.stdout.write(`  ${a}\n`);
  process.stdout.write(
    `\n  ${C.dim}${actions.length} permission${actions.length === 1 ? '' : 's'} · \`kortix permissions show <action>\` for one${C.reset}\n\n`,
  );
  return 0;
}

// ── roles actions ──────────────────────────────────────────────────────────

async function rolesActions(client: ApiClient, base: string, json: boolean): Promise<number> {
  const { actions } = await client.get<{ actions: ActionCatalogEntry[] }>(`${base}/actions`);
  if (json) return emitJson(actions), 0;
  const actW = Math.max(...actions.map((a) => a.action.length), 6);
  process.stdout.write('\n');
  for (const a of actions) {
    process.stdout.write(`  ${pad(a.action, actW)}   ${C.dim}${a.label}${C.reset}\n`);
  }
  process.stdout.write(`\n  ${C.dim}${actions.length} actions${C.reset}\n\n`);
  return 0;
}

// ── roles create ───────────────────────────────────────────────────────────

async function rolesCreate(
  client: ApiClient,
  base: string,
  key: string | undefined,
  name: string | undefined,
  desc: string | undefined,
  scopeArg: string | undefined,
  actionsArg: string | undefined,
): Promise<number> {
  if (!key) return missing('a role key (e.g. "support_agent")');
  // Match the backend rule client-side so the error is friendly + offline.
  if (!/^[a-z0-9_]{2,64}$/.test(key)) {
    const suggestion = key.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
    process.stderr.write(
      `${status.err(`Role key must be 2–64 chars of [a-z0-9_] (lowercase, digits, underscore — no hyphens or spaces).`)}\n` +
        (suggestion.length >= 2 ? `   ${C.dim}Try: ${C.cyan}${suggestion}${C.reset}\n` : ''),
    );
    return 2;
  }
  if (!name) return missing('--name <display name>');
  const resourceType = (scopeArg ?? 'project') as ResourceType;
  const actions = (actionsArg ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  const role = await client.post<IamRole>(`${base}/roles`, {
    key,
    name,
    ...(desc ? { description: desc } : {}),
    resourceType,
    actions,
  });
  process.stdout.write(
    `${status.ok(`Created role ${C.bold}${role.key}${C.reset} (${actions.length} permission${actions.length === 1 ? '' : 's'}, scope ${resourceType})`)}\n`,
  );
  return 0;
}

// ── roles edit / set-actions / rm ──────────────────────────────────────────

async function rolesEdit(
  client: ApiClient,
  base: string,
  ref: string | undefined,
  name: string | undefined,
  desc: string | undefined,
  clearDesc: boolean,
  json: boolean,
): Promise<number> {
  // Rename / re-describe only. The key is the stable identifier every
  // exported policy file and grant references, so it is not editable —
  // change it by creating a new role and re-binding.
  if (!ref) return missing('a role key or id');
  if (name === undefined && desc === undefined && !clearDesc) {
    return missing('--name, --desc or --no-desc');
  }
  if (desc !== undefined && clearDesc) return fail('--desc and --no-desc are mutually exclusive.');
  const { roles } = await client.get<{ roles: IamRole[] }>(`${base}/roles`);
  const role = findRole(roles, ref);
  if (!role) return notFound(`role "${ref}"`);
  if (role.is_system) return fail('Built-in roles cannot be edited — clone it as a custom role instead.');
  const body: Record<string, unknown> = {};
  if (name !== undefined) body.name = name;
  if (desc !== undefined) body.description = desc;
  if (clearDesc) body.description = null;
  const updated = await client.patch<IamRole>(`${base}/roles/${encodeURIComponent(role.role_id)}`, body);
  if (json) return emitJson(updated), 0;
  process.stdout.write(
    `${status.ok(`Updated role ${C.bold}${updated.key}${C.reset} — ${updated.name}`)}\n`,
  );
  return 0;
}

async function rolesSetActions(
  client: ApiClient,
  base: string,
  ref: string | undefined,
  actionsArg: string | undefined,
): Promise<number> {
  if (!ref) return missing('a role key or id');
  if (actionsArg === undefined) return missing('--actions <comma,separated,list>');
  const { roles } = await client.get<{ roles: IamRole[] }>(`${base}/roles`);
  const role = findRole(roles, ref);
  if (!role) return notFound(`role "${ref}"`);
  if (role.is_system) return fail('System roles are read-only — clone it as a custom role instead.');
  const actions = actionsArg.split(',').map((a) => a.trim()).filter(Boolean);
  await client.put(`${base}/roles/${encodeURIComponent(role.role_id)}/permissions`, { actions });
  process.stdout.write(`${status.ok(`${C.bold}${role.key}${C.reset} → ${actions.length} permission${actions.length === 1 ? '' : 's'}`)}\n`);
  return 0;
}

async function rolesRm(client: ApiClient, base: string, ref: string | undefined): Promise<number> {
  if (!ref) return missing('a role key or id');
  const { roles } = await client.get<{ roles: IamRole[] }>(`${base}/roles`);
  const role = findRole(roles, ref);
  if (!role) return notFound(`role "${ref}"`);
  if (role.is_system) return fail('System roles cannot be deleted.');
  await client.delete(`${base}/roles/${encodeURIComponent(role.role_id)}`);
  process.stdout.write(`${status.ok(`Deleted role ${C.bold}${role.key}${C.reset}`)}\n`);
  return 0;
}
