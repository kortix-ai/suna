/**
 * The published spec names the canonical workspace API (design.md §3.1 #17):
 *   - the workspace resource has its own `Workspace` schema, including the
 *     `workspace` settings block, the role and the state;
 *   - the legacy names it marks `x-kortix-alias-of` are exactly the route
 *     manifest's `aliasOf` rows (one alias rule: `workspaceAliasOf`);
 *   - the canonical operations carry the `workspaces` tag and workspace words.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { app } from '../index';
import { WORKSPACE_LEGACY_REPLACEMENTS } from '@kortix/shared/workspace-routes';
import { canonicalSummary } from '../workspaces';

type Op = { summary?: string; description?: string; tags?: string[]; deprecated?: boolean; 'x-kortix-alias-of'?: string; 'x-kortix-replaced-by'?: string; responses?: Record<string, any> };
type Doc = {
  paths: Record<string, Record<string, Op>>;
  components: { schemas: Record<string, Schema> };
  tags?: Array<{ name: string }>;
};

type Schema = { properties?: Record<string, unknown>; allOf?: Array<Schema & { $ref?: string }> };
/** Every property of a component schema, through `allOf` and `$ref`. */
function propertiesOf(name: string): string[] {
  const walk = (schema: (Schema & { $ref?: string }) | undefined): string[] => {
    if (!schema) return [];
    const ref = schema.$ref?.replace('#/components/schemas/', '');
    return [
      ...Object.keys(schema.properties ?? {}),
      ...(schema.allOf ?? []).flatMap(walk),
      ...(ref ? walk(spec.components.schemas[ref]) : []),
    ];
  };
  return walk(spec.components.schemas[name]);
}

const spec = (await (await app.request('http://localhost/v1/openapi.json')).json()) as Doc;
const manifest = JSON.parse(
  readFileSync(new URL('../../../../tests/spec/routes.generated.json', import.meta.url), 'utf8'),
) as { routes: Array<{ method: string; path: string; aliasOf?: string }> };

const METHODS = ['get', 'put', 'post', 'delete', 'patch'];
/** A spec path back to its route template: legacy params were published as `{projectId}` / `{accountId}`. */
const toRouting = (path: string) =>
  path.replace(/(^|\/)\{(projectId|accountId)\}/g, '$1:workspaceId').replace(/(^|\/)\{([^}]+)\}/g, '$1:$2');

describe('the workspace resource in /v1/openapi.json', () => {
  test('GET /v1/workspaces/{workspaceId} answers a Workspace with role, state and the settings block', () => {
    const op = spec.paths['/v1/workspaces/{workspaceId}']?.get;
    expect(op?.summary).toBe('Get a workspace');
    expect(JSON.stringify(op?.responses?.['200'])).toContain('#/components/schemas/Workspace"');
    const props = propertiesOf('Workspace');
    for (const key of ['workspace_id', 'role', 'state', 'workspace', 'split_pending', 'deletion_scheduled_for']) {
      expect(props).toContain(key);
    }
    expect(propertiesOf('WorkspaceSettings')).toContain('mfa_required');
    expect(props).toContain('project_id');
  });

  test('the list and the create are workspace operations, not the project ones', () => {
    expect(spec.paths['/v1/workspaces']?.get?.summary).toBe('List workspaces');
    expect(spec.paths['/v1/workspaces']?.post?.summary).toBe('Create a workspace');
    // Their legacy names are different routes: not deprecated aliases.
    expect(spec.paths['/v1/projects']?.get?.['x-kortix-alias-of']).toBeUndefined();
    expect(spec.paths['/v1/projects']?.post?.['x-kortix-alias-of']).toBeUndefined();
    expect(spec.paths['/v1/projects/{projectId}']?.get?.['x-kortix-alias-of']).toBeUndefined();
    // The project audit slice is an alias of /audit/events, not of the workspace audit log.
    expect(spec.paths['/v1/projects/{projectId}/audit']?.get?.['x-kortix-alias-of']).toBe(
      'GET /v1/workspaces/{workspaceId}/audit/events',
    );
    // Account-scoped create and quota have no canonical name.
    expect(spec.paths['/v1/workspaces/provision']).toBeUndefined();
    expect(spec.paths['/v1/workspaces/quota']).toBeUndefined();
  });
});

describe('legacy routes with their own meaning', () => {
  test.each(Object.entries(WORKSPACE_LEGACY_REPLACEMENTS))(
    '%s is deprecated and names %s',
    (legacy, replacement) => {
      const [method, routing] = legacy.split(' ') as [string, string];
      const path = Object.keys(spec.paths).find((p) => toRouting(p) === routing);
      const op = path ? spec.paths[path]?.[method.toLowerCase()] : undefined;
      expect({ legacy, published: Boolean(op) }).toEqual({ legacy, published: true });
      expect(op?.deprecated).toBe(true);
      expect(op?.['x-kortix-alias-of']).toBeUndefined();
      const [rMethod, rRouting] = replacement.split(' ') as [string, string];
      expect(op?.['x-kortix-replaced-by']).toBe(`${rMethod} ${rRouting.replace(/(^|\/):([A-Za-z0-9_]+)/g, '$1{$2}')}`);
      expect(op?.description).toContain(`\`${rMethod} ${rRouting.replace(/(^|\/):([A-Za-z0-9_]+)/g, '$1{$2}')}\``);
    },
  );
});

describe('aliases in the spec and the manifest', () => {
  test('the spec marks exactly the manifest aliasOf rows', () => {
    const fromSpec = new Set<string>();
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const method of METHODS) {
        const alias = item[method]?.['x-kortix-alias-of'];
        if (alias) fromSpec.add(`${method.toUpperCase()} ${toRouting(path)} → ${toRouting(alias.split(' ')[1]!)}`);
      }
    }
    const specOps = new Set(
      Object.entries(spec.paths).flatMap(([path, item]) =>
        METHODS.filter((m) => item[m]).map((m) => `${m.toUpperCase()} ${toRouting(path)}`),
      ),
    );
    const fromManifest = new Set(
      manifest.routes
        .filter((r) => r.aliasOf && specOps.has(`${r.method} ${r.path}`) && specOps.has(`${r.method} ${r.aliasOf}`))
        .map((r) => `${r.method} ${r.path} → ${r.aliasOf}`),
    );
    expect([...fromSpec].filter((row) => !fromManifest.has(row))).toEqual([]);
    expect([...fromManifest].filter((row) => !fromSpec.has(row))).toEqual([]);
  });

  test('the canonical trigger webhook publishes {workspaceId}; the project path names it as its alias', () => {
    expect(spec.paths['/v1/webhooks/workspaces/{workspaceId}/{slug}']?.post).toBeDefined();
    expect(spec.paths['/v1/webhooks/projects/{projectId}/{slug}']?.post?.['x-kortix-alias-of']).toBe(
      'POST /v1/webhooks/workspaces/{workspaceId}/{slug}',
    );
  });

  test('a custom-verb legacy path is marked with its canonical twin', () => {
    const op = spec.paths['/v1/accounts/{accountId}/iam/policies:bulk-delete']?.post;
    expect(op?.['x-kortix-alias-of']).toBe('POST /v1/workspaces/{workspaceId}/iam/policies:bulk-delete');
  });
});

describe('canonical operation wording', () => {
  test('the spec publishes a workspaces tag and every copied canonical operation carries it', () => {
    expect((spec.tags ?? []).map((t) => t.name)).toContain('workspaces');
    expect(spec.paths['/v1/workspaces/{workspaceId}/sessions']?.get?.tags).toEqual(['workspaces']);
    expect(spec.paths['/v1/workspaces/{workspaceId}/iam/groups']?.get?.tags).toEqual(['workspaces']);
  });

  test('summaries say workspace; a qualified account keeps its meaning', () => {
    expect(canonicalSummary('List project secrets (names only, no values)')).toBe('List workspace secrets (names only, no values)');
    expect(canonicalSummary('Leave an account')).toBe('Leave a workspace');
    expect(canonicalSummary("Pause or resume all of a project's triggers server-side")).toBe(
      "Pause or resume all of a workspace's triggers server-side",
    );
    expect(canonicalSummary('Set or clear a per-project feature-flag override')).toBe('Set or clear a per-workspace feature-flag override');
    expect(canonicalSummary('Create a service account')).toBe('Create a service account');
    expect(canonicalSummary('List agent service-account identities (policy principal picker)')).toBe(
      'List agent service-account identities (policy principal picker)',
    );
    expect(canonicalSummary('Delete your own Claude accounts in this project')).toBe('Delete your own Claude accounts in this workspace');
    expect(canonicalSummary('Accounts this principal may run a connector as')).toBe('Accounts this principal may run a connector as');
    expect(canonicalSummary('Set the account capture policy; publishes orgs/<account_id>/policy.json')).toBe(
      'Set the workspace capture policy; publishes orgs/<account_id>/policy.json',
    );
    expect(spec.paths['/v1/workspaces/{workspaceId}/members']?.get?.summary).toBe('List workspace members');
    expect(spec.paths['/v1/workspaces/{workspaceId}/sessions']?.get?.summary).toBe('List sessions of a workspace');
  });
});
