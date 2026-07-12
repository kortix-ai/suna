import { readFileSync, writeFileSync } from 'node:fs';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { loadAuth } from '../api/auth.ts';
import { activeAccount } from '../api/config.ts';
import { clientFromAuth, type ApiClient } from '../api/client.ts';
import { emitJson, surfaceApiError, takeFlagValue, takeFlagBool } from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';

// Account-scoped IAM custom roles + policy assignments. Mirrors the dashboard's
// account Roles tab + per-project "Custom roles" card, and wraps the same
// /accounts/:id/iam/{roles,policies,actions} routes the web SDK already uses.

type ResourceType = 'account' | 'project' | 'sandbox' | 'trigger' | 'channel' | 'member' | 'group';
type PrincipalType = 'member' | 'group' | 'token';

interface IamRole {
  role_id: string;
  key: string;
  name: string;
  description: string | null;
  resource_type: ResourceType;
  is_system: boolean;
  account_id: string | null;
}

interface IamPolicy {
  policy_id: string;
  principal_type: PrincipalType;
  principal_id: string;
  scope_type: string;
  scope_id: string | null;
  role_id: string;
  effect: 'allow' | 'deny';
  expires_at?: string | null;
  created_at: string;
}

interface ActionCatalogEntry {
  action: string;
  label: string;
  resource_type: string;
}

const HELP = help`Usage: kortix roles <subcommand> [options]

Manage account-level custom roles + their policy assignments — the CLI face
of the dashboard's Roles tab and a project's "Custom roles" card. Built-in
roles (owner/admin/member, manager/editor/user) are read-only references;
custom roles are yours to create, edit, and bind.

Roles:
  ls [--json]                         List roles (built-in + custom).
  show <role> [--json]                Show a role's permissions + usage.
  actions [--json]                    List the permission catalog.
  create <key> --name <n> [opts]      Create a custom role.
  set-actions <role> --actions a,b    Replace a custom role's permissions.
  rm <role>                           Delete a custom role.

Assignments (policies):
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
  --name <n>         Display name (create).
  --desc <text>      Description (create).
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
  kortix roles actions
  kortix roles create support_agent --name "Support Agent" \\
    --scope project --actions project.read,project.session.start,project.trigger.fire
  kortix roles assign support_agent --to member:<user-id> --project <project-id>
  kortix roles assignments --project <project-id>
  kortix roles export --out policies.toml
  kortix roles import policies.toml
`;

interface RolesContext {
  client: ApiClient;
  accountId: string;
}

/** Resolve the active (or --account) account + an account-scoped client. */
function resolveAccountContext(accountArg?: string): RolesContext | null {
  const auth = loadAuth();
  if (!auth?.token) {
    process.stderr.write(`${status.err('Not logged in. Run `kortix login`.')}\n`);
    return null;
  }
  const accountId = accountArg || activeAccount()?.id || auth.account_id || '';
  if (!accountId) {
    process.stderr.write(
      `${status.err('No active account. Run `kortix accounts use` or pass --account <id>.')}\n`,
    );
    return null;
  }
  return { client: clientFromAuth(auth, { accountId }), accountId };
}

function findRole(roles: IamRole[], ref: string): IamRole | undefined {
  return roles.find((r) => r.key === ref || r.role_id === ref);
}

export async function runRoles(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }
  const sub = argv[0];
  const rest = argv.slice(1);
  const f: Record<string, string | undefined> = {};
  let json = false;
  try {
    f.account = takeFlagValue(rest, ['--account']);
    f.name = takeFlagValue(rest, ['--name']);
    f.desc = takeFlagValue(rest, ['--desc', '--description']);
    f.scope = takeFlagValue(rest, ['--scope']);
    f.actions = takeFlagValue(rest, ['--actions']);
    f.to = takeFlagValue(rest, ['--to']);
    f.project = takeFlagValue(rest, ['--project']);
    f.expires = takeFlagValue(rest, ['--expires']);
    f.out = takeFlagValue(rest, ['--out']);
    f.format = takeFlagValue(rest, ['--format']);
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const positional = rest.filter((a) => !a.startsWith('-'));

  const ctx = resolveAccountContext(f.account);
  if (!ctx) return 1;
  const base = `/accounts/${ctx.accountId}/iam`;

  try {
    switch (sub) {
      case 'ls':
      case 'list': {
        const { roles } = await ctx.client.get<{ roles: IamRole[] }>(`${base}/roles`);
        if (json) return emitJson(roles), 0;
        const keyW = Math.max(...roles.map((r) => r.key.length), 4);
        const nameW = Math.max(...roles.map((r) => r.name.length), 4);
        process.stdout.write('\n');
        process.stdout.write(`  ${C.dim}${pad('KEY', keyW)}   ${pad('NAME', nameW)}   SCOPE      KIND${C.reset}\n`);
        for (const r of roles) {
          const kind = r.is_system ? `${C.faded}built-in${C.reset}` : `${C.cyan}custom${C.reset}`;
          process.stdout.write(
            `  ${pad(r.key, keyW)}   ${pad(r.name, nameW)}   ${pad(r.resource_type, 8)}   ${kind}\n`,
          );
        }
        process.stdout.write(`\n  ${C.dim}${roles.length} role${roles.length === 1 ? '' : 's'}${C.reset}\n\n`);
        return 0;
      }

      case 'show': {
        const ref = positional[0];
        if (!ref) return missing('a role key or id');
        const { roles } = await ctx.client.get<{ roles: IamRole[] }>(`${base}/roles`);
        const role = findRole(roles, ref);
        if (!role) return notFound(`role "${ref}"`);
        const perms = await ctx.client.get<{ role_id: string; key: string; actions: string[] }>(
          `${base}/roles/${encodeURIComponent(role.role_id)}/permissions`,
        );
        const usage = await ctx.client
          .get<{ policy_count: number }>(`${base}/roles/${encodeURIComponent(role.role_id)}/usage`)
          .catch(() => ({ policy_count: 0 }));
        if (json) return emitJson({ ...role, actions: perms.actions, ...usage }), 0;
        process.stdout.write('\n');
        process.stdout.write(`  ${C.bold}${role.name}${C.reset}  ${C.faded}${role.key}${C.reset}${role.is_system ? `  ${C.faded}(built-in)${C.reset}` : ''}\n`);
        if (role.description) process.stdout.write(`  ${C.dim}${role.description}${C.reset}\n`);
        process.stdout.write(`  ${C.dim}scope ${role.resource_type} · ${usage.policy_count} assignment${usage.policy_count === 1 ? '' : 's'}${C.reset}\n\n`);
        process.stdout.write(`  ${C.dim}PERMISSIONS (${perms.actions.length})${C.reset}\n`);
        for (const a of perms.actions.slice().sort()) process.stdout.write(`    ${a}\n`);
        process.stdout.write('\n');
        return 0;
      }

      case 'actions': {
        const { actions } = await ctx.client.get<{ actions: ActionCatalogEntry[] }>(`${base}/actions`);
        if (json) return emitJson(actions), 0;
        const actW = Math.max(...actions.map((a) => a.action.length), 6);
        process.stdout.write('\n');
        for (const a of actions) {
          process.stdout.write(`  ${pad(a.action, actW)}   ${C.dim}${a.label}${C.reset}\n`);
        }
        process.stdout.write(`\n  ${C.dim}${actions.length} actions${C.reset}\n\n`);
        return 0;
      }

      case 'create': {
        const key = positional[0];
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
        if (!f.name) return missing('--name <display name>');
        const resourceType = (f.scope ?? 'project') as ResourceType;
        const actions = (f.actions ?? '').split(',').map((a) => a.trim()).filter(Boolean);
        const role = await ctx.client.post<IamRole>(`${base}/roles`, {
          key,
          name: f.name,
          ...(f.desc ? { description: f.desc } : {}),
          resourceType,
          actions,
        });
        process.stdout.write(
          `${status.ok(`Created role ${C.bold}${role.key}${C.reset} (${actions.length} permission${actions.length === 1 ? '' : 's'}, scope ${resourceType})`)}\n`,
        );
        return 0;
      }

      case 'set-actions':
      case 'set': {
        const ref = positional[0];
        if (!ref) return missing('a role key or id');
        if (f.actions === undefined) return missing('--actions <comma,separated,list>');
        const { roles } = await ctx.client.get<{ roles: IamRole[] }>(`${base}/roles`);
        const role = findRole(roles, ref);
        if (!role) return notFound(`role "${ref}"`);
        if (role.is_system) {
          process.stderr.write(`${status.err('Built-in roles are read-only — clone it as a custom role instead.')}\n`);
          return 2;
        }
        const actions = f.actions.split(',').map((a) => a.trim()).filter(Boolean);
        await ctx.client.put(`${base}/roles/${encodeURIComponent(role.role_id)}/permissions`, { actions });
        process.stdout.write(`${status.ok(`${C.bold}${role.key}${C.reset} → ${actions.length} permission${actions.length === 1 ? '' : 's'}`)}\n`);
        return 0;
      }

      case 'rm':
      case 'remove':
      case 'delete': {
        const ref = positional[0];
        if (!ref) return missing('a role key or id');
        const { roles } = await ctx.client.get<{ roles: IamRole[] }>(`${base}/roles`);
        const role = findRole(roles, ref);
        if (!role) return notFound(`role "${ref}"`);
        if (role.is_system) {
          process.stderr.write(`${status.err('Built-in roles cannot be deleted.')}\n`);
          return 2;
        }
        await ctx.client.delete(`${base}/roles/${encodeURIComponent(role.role_id)}`);
        process.stdout.write(`${status.ok(`Deleted role ${C.bold}${role.key}${C.reset}`)}\n`);
        return 0;
      }

      case 'assignments':
      case 'policies': {
        const qs = f.project ? `?scopeType=project&scopeId=${encodeURIComponent(f.project)}` : '';
        const { policies } = await ctx.client.get<{ policies: IamPolicy[] }>(`${base}/policies${qs}`);
        if (json) return emitJson(policies), 0;
        // Map role_id → key for a readable column.
        const { roles } = await ctx.client.get<{ roles: IamRole[] }>(`${base}/roles`);
        const roleKey = new Map(roles.map((r) => [r.role_id, r.key]));
        if (policies.length === 0) {
          process.stdout.write(`  ${C.dim}No assignments${f.project ? ' on this project' : ''}.${C.reset}\n`);
          return 0;
        }
        process.stdout.write('\n');
        process.stdout.write(`  ${C.dim}ROLE             PRINCIPAL                 SCOPE      POLICY ID${C.reset}\n`);
        for (const p of policies) {
          const principal = `${p.principal_type}:${p.principal_id}`;
          const scope = p.scope_id ? `${p.scope_type}:${p.scope_id.slice(0, 8)}` : p.scope_type;
          process.stdout.write(
            `  ${pad(roleKey.get(p.role_id) ?? p.role_id, 16)} ${pad(principal, 25)} ${pad(scope, 10)} ${C.faded}${p.policy_id}${C.reset}\n`,
          );
        }
        process.stdout.write(`\n  ${C.dim}${policies.length} assignment${policies.length === 1 ? '' : 's'}${C.reset}\n\n`);
        return 0;
      }

      case 'assign': {
        const ref = positional[0];
        if (!ref) return missing('a role key or id');
        if (!f.to) return missing('--to <type>:<id> (member:<id> | group:<id> | token:<id>)');
        const [principalType, ...idParts] = f.to.split(':');
        const principalId = idParts.join(':');
        if (!['member', 'group', 'token'].includes(principalType) || !principalId) {
          process.stderr.write(`${status.err('--to must be member:<id>, group:<id>, or token:<id>')}\n`);
          return 2;
        }
        const { roles } = await ctx.client.get<{ roles: IamRole[] }>(`${base}/roles`);
        const role = findRole(roles, ref);
        if (!role) return notFound(`role "${ref}"`);
        // Resolve scope: --project pins a project scope; otherwise --scope (default account).
        const scope = f.project
          ? { scopeType: 'project', scopeId: f.project as string | null }
          : { scopeType: f.scope ?? 'account', scopeId: null as string | null };
        const policy = await ctx.client.post<IamPolicy>(`${base}/policies`, {
          principalType,
          principalId,
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          roleId: role.role_id,
          ...(f.expires ? { expires_at: f.expires } : {}),
        });
        process.stdout.write(
          `${status.ok(`Assigned ${C.bold}${role.key}${C.reset} → ${principalType}:${principalId} (${scope.scopeType}${scope.scopeId ? ` ${scope.scopeId}` : ''})  ${C.faded}${policy.policy_id}${C.reset}`)}\n`,
        );
        return 0;
      }

      case 'unassign': {
        const policyId = positional[0];
        if (!policyId) return missing('a policy id (see `kortix roles assignments`)');
        await ctx.client.delete(`${base}/policies/${encodeURIComponent(policyId)}`);
        process.stdout.write(`${status.ok(`Removed assignment ${C.bold}${policyId}${C.reset}`)}\n`);
        return 0;
      }

      case 'export': {
        // Custom roles (with their actions) + policy bindings → a portable
        // doc. Bindings reference roles by KEY (not id) so the file survives a
        // round-trip into a different account.
        const { roles } = await ctx.client.get<{ roles: IamRole[] }>(`${base}/roles`);
        const roleKeyById = new Map(roles.map((r) => [r.role_id, r.key]));
        const custom = roles.filter((r) => !r.is_system);
        const roleDocs = await Promise.all(
          custom.map(async (r) => {
            const perms = await ctx.client.get<{ actions: string[] }>(
              `${base}/roles/${encodeURIComponent(r.role_id)}/permissions`,
            );
            return {
              key: r.key,
              name: r.name,
              ...(r.description ? { description: r.description } : {}),
              resource_type: r.resource_type,
              actions: perms.actions,
            };
          }),
        );
        const qs = f.project ? `?scopeType=project&scopeId=${encodeURIComponent(f.project)}` : '';
        const { policies } = await ctx.client.get<{ policies: IamPolicy[] }>(`${base}/policies${qs}`);
        const policyDocs = policies.map((p) => ({
          role_key: roleKeyById.get(p.role_id) ?? p.role_id,
          principal_type: p.principal_type,
          principal_id: p.principal_id,
          scope_type: p.scope_type,
          ...(p.scope_id ? { scope_id: p.scope_id } : {}),
          ...(p.effect && p.effect !== 'allow' ? { effect: p.effect } : {}),
          ...(p.expires_at ? { expires_at: p.expires_at } : {}),
        }));
        const doc = { roles: roleDocs, policies: policyDocs };
        const fmt = (f.format ?? (f.out?.endsWith('.json') ? 'json' : 'toml')).toLowerCase();
        const text = fmt === 'json' ? JSON.stringify(doc, null, 2) + '\n' : stringifyToml(doc) + '\n';
        if (f.out) {
          writeFileSync(f.out, text, 'utf8');
          process.stdout.write(`${status.ok(`Exported ${roleDocs.length} role${roleDocs.length === 1 ? '' : 's'} + ${policyDocs.length} binding${policyDocs.length === 1 ? '' : 's'} → ${C.bold}${f.out}${C.reset}`)}\n`);
        } else {
          process.stdout.write(text);
        }
        return 0;
      }

      case 'import': {
        const file = positional[0];
        if (!file) return missing('a file (e.g. policies.toml)');
        let raw: string;
        try {
          raw = readFileSync(file, 'utf8');
        } catch {
          process.stderr.write(`${status.err(`Could not read ${file}.`)}\n`);
          return 1;
        }
        let doc: { roles?: any[]; policies?: any[] };
        try {
          doc = file.endsWith('.json') ? JSON.parse(raw) : (parseToml(raw) as any);
        } catch (err) {
          process.stderr.write(`${status.err(`Parse error in ${file}: ${(err as Error).message}`)}\n`);
          return 2;
        }
        const existing = await ctx.client.get<{ roles: IamRole[] }>(`${base}/roles`);
        const haveKey = new Set(existing.roles.map((r) => r.key));
        // 1) Create roles that don't exist yet (by key). Existing keys are left
        //    untouched — import is additive, never destructive.
        let created = 0;
        let skipped = 0;
        for (const r of doc.roles ?? []) {
          if (!r?.key) continue;
          if (haveKey.has(r.key)) { skipped++; continue; }
          await ctx.client.post(`${base}/roles`, {
            key: r.key,
            name: r.name ?? r.key,
            ...(r.description ? { description: r.description } : {}),
            resourceType: r.resource_type ?? 'project',
            actions: Array.isArray(r.actions) ? r.actions : [],
          });
          created++;
        }
        // 2) Bind the policies — idempotently. The server's :bulk-import does
        //    NOT dedupe, so re-running would create duplicate bindings; we skip
        //    any binding that already exists (same principal + scope + role).
        const wanted = doc.policies ?? [];
        const rolesNow = (await ctx.client.get<{ roles: IamRole[] }>(`${base}/roles`)).roles;
        const idByKey = new Map(rolesNow.map((r) => [r.key, r.role_id]));
        const livePolicies = (await ctx.client.get<{ policies: IamPolicy[] }>(`${base}/policies`)).policies;
        const bindKey = (pt: string, pid: string, st: string, sid: string | null | undefined, rid: string) =>
          `${pt}|${pid}|${st}|${sid ?? ''}|${rid}`;
        const have = new Set(
          livePolicies.map((p) => bindKey(p.principal_type, p.principal_id, p.scope_type, p.scope_id, p.role_id)),
        );
        const fresh = wanted.filter((p: any) => {
          const rid = idByKey.get(p.role_key);
          if (!rid) return true; // unknown role → let the server report the error
          return !have.has(bindKey(p.principal_type, p.principal_id, p.scope_type, p.scope_id ?? null, rid));
        });
        const alreadyBound = wanted.length - fresh.length;
        let result = { attempted: 0, created: 0, skipped: 0, errors: [] as Array<{ index: number; error: string }> };
        if (fresh.length > 0) {
          result = await ctx.client.post(`${base}/policies:bulk-import`, { policies: fresh });
        }
        process.stdout.write(
          `${status.ok(`Roles: ${created} created, ${skipped} existing. Bindings: ${result.created} created, ${alreadyBound + result.skipped} existing of ${wanted.length}.`)}\n`,
        );
        for (const e of result.errors ?? []) {
          process.stderr.write(`  ${C.yellow}binding ${e.index}:${C.reset} ${e.error}\n`);
        }
        return result.errors?.length ? 1 : 0;
      }

      default:
        process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    return surfaceApiError(err);
  }
}

function missing(what: string): number {
  process.stderr.write(`${status.err(`Pass ${what}.`)}\n`);
  return 2;
}

function notFound(what: string): number {
  process.stderr.write(`${status.err(`No ${what} in this account. Try \`kortix roles ls\`.`)}\n`);
  return 1;
}
