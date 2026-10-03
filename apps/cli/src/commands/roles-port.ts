/**
 * `kortix roles export | import` — IAM as code. Export dumps the account's
 * custom roles (with their actions) and policy bindings into a portable doc;
 * import applies one, creating missing roles and bulk-importing bindings
 * idempotently. Split out of roles.ts; RolesDoc is the round-trip contract
 * with the exporter — bindings reference roles by KEY so the file survives a
 * move into a different account.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { fail, missing } from '../command-helpers.ts';
import type { IamRole } from '../iam.ts';
import { C, status } from '../style.ts';
import type { IamPolicy, RolesCall } from './roles-policies.ts';

/** The portable doc `roles export` writes and `roles import` reads. */
interface RolesDoc {
  roles?: Array<{
    key: string;
    name?: string;
    description?: string;
    resource_type?: string;
    actions?: string[];
  }>;
  policies?: Array<{
    role_key: string;
    principal_type: string;
    principal_id: string;
    scope_type: string;
    scope_id?: string;
    effect?: string;
    expires_at?: string;
  }>;
}

export async function rolesExport(call: RolesCall): Promise<number> {
  const { ctx, base, json, positional, f, clearDesc } = call;
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

export async function rolesImport(call: RolesCall): Promise<number> {
  const { ctx, base, json, positional, f, clearDesc } = call;
    const file = positional[0];
    if (!file) return missing('a file (e.g. policies.toml)');
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      process.stderr.write(`${status.err(`Could not read ${file}.`)}\n`);
      return 1;
    }
    let doc: RolesDoc;
    try {
      doc = file.endsWith('.json') ? JSON.parse(raw) : (parseToml(raw) as RolesDoc);
    } catch (err) {
      return fail(`Parse error in ${file}: ${(err as Error).message}`);
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
    const fresh = wanted.filter((p: NonNullable<RolesDoc['policies']>[number]) => {
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
