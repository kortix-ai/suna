/**
 * The public OpenAPI spec (/v1/openapi.json) must NOT advertise internal
 * routers. admin/ops are runtime-gated but their typed route DEFINITIONS still
 * merge into the shared registry via app.route() — so without filtering, the
 * spec published admin credit-debit / tier-change / ops shapes to anyone.
 * These tests pin both the pure filter and the end-to-end served document.
 */
import { createRoute } from '@hono/zod-openapi';
import { describe, expect, test } from 'bun:test';
import {
  addWorkspaceCompatibilityPaths,
  INTERNAL_SPEC_PREFIXES,
  filterSpecPaths,
  makeOpenApiApp,
  mountOpenApiDocs,
} from '../openapi';

describe('filterSpecPaths', () => {
  test('drops internal prefixes and everything beneath them', () => {
    const doc = {
      openapi: '3.1.0',
      paths: {
        '/v1/admin': {},
        '/v1/admin/api/accounts/{id}/credits/debit': {},
        '/v1/ops/overview': {},
        '/v1/projects/{id}': {},
        '/scim/v2/accounts/{accountId}/Users': {},
      },
    };
    const out = filterSpecPaths(doc);
    expect(Object.keys(out.paths).sort()).toEqual([
      '/scim/v2/accounts/{accountId}/Users', // SCIM stays public (RFC-7644)
      '/v1/projects/{id}',
    ]);
  });

  test('respects the prefix boundary — a sibling like /v1/administrators is kept', () => {
    const out = filterSpecPaths({ paths: { '/v1/administrators': {}, '/v1/admin/x': {} } });
    expect(Object.keys(out.paths)).toEqual(['/v1/administrators']);
  });

  test('is a no-op when there are no paths, and never mutates the input', () => {
    // Typed with the optional `paths` so it satisfies the helper's constraint
    // (a real OpenAPI doc has many more fields); asserts the no-paths early return.
    const noPaths: { openapi: string; paths?: Record<string, unknown> } = { openapi: '3.1.0' };
    expect(filterSpecPaths(noPaths)).toEqual({ openapi: '3.1.0' });
    const input = { paths: { '/v1/admin': {}, '/v1/projects': {} } };
    filterSpecPaths(input);
    expect(Object.keys(input.paths)).toContain('/v1/admin'); // input untouched
  });

  test('the internal prefix list covers admin + ops (and NOT scim)', () => {
    expect([...INTERNAL_SPEC_PREFIXES]).toEqual(['/v1/admin', '/v1/ops']);
  });
});

describe('addWorkspaceCompatibilityPaths', () => {
  test('derives deprecated Project docs from a canonical Workspace-first registry', () => {
    const output = addWorkspaceCompatibilityPaths({
      paths: {
        '/v1/workspaces/{workspaceId}/connections': {
          get: {
            tags: ['workspaces'],
            summary: 'List Workspace connections',
            parameters: [{ in: 'path', name: 'workspaceId', required: true }],
            responses: {
              200: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['workspace_id'],
                      properties: {
                        workspace_id: { type: 'string' },
                        owner_type: { type: 'string', enum: ['workspace', 'member'] },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }) as { paths: Record<string, any> };

    const canonical = output.paths['/v1/workspaces/{workspaceId}/connections'].get;
    const legacy = output.paths['/v1/projects/{projectId}/connections'].get;
    expect(canonical.deprecated).toBeUndefined();
    expect(canonical.responses[200].content['application/json'].schema).toMatchObject({
      required: ['workspace_id'],
      properties: { owner_type: { enum: ['workspace', 'member'] } },
    });
    expect(legacy).toMatchObject({
      deprecated: true,
      tags: ['projects'],
      summary: 'List Project connections',
      parameters: [{ in: 'path', name: 'projectId', required: true }],
    });
    expect(legacy.responses[200].content['application/json'].schema).toMatchObject({
      required: ['project_id'],
      properties: { owner_type: { enum: ['project', 'member'] } },
    });
  });

  test('keeps legacy Project paths and adds canonical Workspace paths with Workspace parameters and fields', () => {
    const projectPath = '/v1/projects/{workspaceId}/channels/teams/manifest';
    const workspacePath = '/v1/workspaces/{workspaceId}/channels/teams/manifest';
    const input = {
      openapi: '3.1.0',
      info: { title: 'Kortix API', version: 'test' },
      paths: {
        [projectPath]: {
          get: {
            tags: ['projects'],
            summary: 'Read project manifest',
            parameters: [
              {
                in: 'path',
                name: 'workspaceId',
                required: true,
                schema: { type: 'string' },
              },
            ],
            responses: {
              200: {
                description: 'Workspace manifest',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['project_id', 'project_role'],
                      properties: {
                        project_id: { type: 'string' },
                        project_role: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const output = addWorkspaceCompatibilityPaths(input) as {
      paths: Record<string, any>;
    };

    expect(output).not.toBe(input);
    expect(Object.keys(output.paths)[0]).toBe(workspacePath);
    const normalizedProjectPath = '/v1/projects/{projectId}/channels/teams/manifest';
    expect(output.paths[projectPath]).toBeUndefined();
    expect(output.paths[normalizedProjectPath].get).toMatchObject({
      tags: ['projects'],
      summary: 'Read project manifest',
      deprecated: true,
    });
    expect(output.paths[normalizedProjectPath].get.parameters[0].name).toBe('projectId');
    expect(output.paths[workspacePath]).toBeDefined();
    expect(output.paths[workspacePath].get.tags).toEqual(['workspaces']);
    expect(output.paths[workspacePath].get.summary).toBe('Read workspace manifest');
    expect(output.paths[workspacePath].get.parameters[0].name).toBe('workspaceId');
    expect(
      output.paths[workspacePath].get.responses[200].content['application/json'].schema,
    ).toMatchObject({
      required: ['workspace_id', 'workspace_role'],
      properties: {
        workspace_id: { type: 'string' },
        workspace_role: { type: 'string' },
      },
    });
    expect(input.paths[projectPath].get.parameters[0].name).toBe('workspaceId');
  });

  test('normalizes an explicitly registered Workspace route without mutating its registry entry', () => {
    const explicit = {
      get: {
        tags: ['projects'],
        summary: 'Read project settings',
        description: 'Returns the project configuration.',
      },
    };
    const output = addWorkspaceCompatibilityPaths({
      paths: {
        '/v1/projects/{workspaceId}': { get: { summary: 'Workspace route' } },
        '/v1/workspaces/{workspaceId}': explicit,
      },
    }) as { paths: Record<string, any> };

    expect(output.paths['/v1/workspaces/{workspaceId}']).not.toBe(explicit);
    expect(output.paths['/v1/workspaces/{workspaceId}'].get).toMatchObject({
      tags: ['workspaces'],
      summary: 'Read workspace settings',
      description: 'Returns the workspace configuration.',
    });
    expect(explicit.get).toEqual({
      tags: ['projects'],
      summary: 'Read project settings',
      description: 'Returns the project configuration.',
    });
    expect(output.paths['/v1/projects/{projectId}'].get).toMatchObject({
      tags: ['projects'],
      summary: 'Read project settings',
      deprecated: true,
    });
  });

  test('publishes canonical connector Workspace paths and deprecates both legacy namespaces', () => {
    const output = addWorkspaceCompatibilityPaths({
      paths: {
        '/v1/projects/{projectId}': { get: { summary: 'Get project' } },
        '/v1/connectors/projects/{projectId}/catalog': {
          get: {
            tags: ['projects'],
            summary: 'List project connectors',
            parameters: [{ in: 'path', name: 'projectId', required: true }],
          },
        },
      },
    }) as { paths: Record<string, any> };

    expect(Object.keys(output.paths).slice(0, 2)).toEqual([
      '/v1/workspaces/{workspaceId}',
      '/v1/connectors/workspaces/{workspaceId}/catalog',
    ]);
    expect(output.paths['/v1/workspaces/{workspaceId}'].get.deprecated).toBeUndefined();
    expect(output.paths['/v1/connectors/workspaces/{workspaceId}/catalog'].get).toMatchObject({
      tags: ['workspaces'],
      summary: 'List workspace connectors',
      parameters: [{ in: 'path', name: 'workspaceId', required: true }],
    });
    expect(output.paths['/v1/projects/{projectId}'].get.deprecated).toBe(true);
    expect(output.paths['/v1/connectors/projects/{projectId}/catalog'].get.deprecated).toBe(true);
  });
});

describe('mountOpenApiDocs — served spec excludes internal routers', () => {
  test('/v1/openapi.json omits internal routes and publishes both Workspace and Project contracts', async () => {
    const app = makeOpenApiApp();

    const publicRoute = createRoute({
      method: 'get',
      path: '/v1/projects/{id}',
      responses: { 200: { description: 'ok' } },
    });
    app.openapi(publicRoute, (c: any) => c.json({}));

    const admin = makeOpenApiApp();
    const adminRoute = createRoute({
      method: 'post',
      path: '/api/accounts/{id}/credits/debit',
      responses: { 200: { description: 'ok' } },
    });
    admin.openapi(adminRoute, (c: any) => c.json({}));
    app.route('/v1/admin', admin);

    mountOpenApiDocs(app, 'test');

    const res = await app.request('/v1/openapi.json');
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { paths: Record<string, unknown> };
    const paths = Object.keys(spec.paths);
    expect(paths).toContain('/v1/projects/{id}');
    expect(paths).toContain('/v1/workspaces/{id}');
    expect(paths.some((p) => p.startsWith('/v1/admin'))).toBe(false);
  });
});
