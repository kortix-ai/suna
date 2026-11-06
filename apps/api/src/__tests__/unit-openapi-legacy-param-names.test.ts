/**
 * The published spec keeps every legacy path's parameter names as they were
 * before Workspaces: `/v1/projects/{projectId}/…`, `/v1/accounts/{accountId}/…`.
 * A client generated from the older spec names its arguments after them, so
 * renaming them breaks the build of every generated client. Only the canonical
 * `/v1/workspaces/…` names use `{workspaceId}`.
 */
import { describe, expect, test } from 'bun:test';
import { app } from '../index';

type Param = { name: string; in: string };
type Doc = { paths: Record<string, Record<string, { parameters?: Param[] } | Param[]>> };

const served = (await (await app.request('http://localhost/v1/openapi.json')).json()) as Doc;
const CANONICAL = /^\/(v1\/workspaces|v1\/me|v1\/invites|v1\/connectors\/workspaces|v1\/webhooks\/workspaces|scim\/v2\/workspaces)(\/|$)/;

describe('legacy path parameter names in /v1/openapi.json', () => {
  test('no legacy path publishes {workspaceId}', () => {
    const renamed = Object.keys(served.paths).filter((path) => !CANONICAL.test(path) && path.includes('{workspaceId}'));
    expect(renamed).toEqual([]);
  });

  test('each legacy family keeps its older name; the canonical twin uses {workspaceId}', () => {
    for (const path of [
      '/v1/projects/{projectId}/sessions',
      '/v1/accounts/{accountId}/iam/groups',
      '/scim/v2/accounts/{accountId}/Users',
      '/v1/workspaces/{workspaceId}/sessions',
      '/v1/workspaces/{workspaceId}/iam/groups',
      '/scim/v2/workspaces/{workspaceId}/Users',
    ]) {
      expect({ path, published: Boolean(served.paths[path]) }).toEqual({ path, published: true });
    }
    expect(Object.keys(served.paths).some((p) => p.startsWith('/v1/connectors/projects/{projectId}/'))).toBe(true);
  });

  test("every operation's path parameters match the names in its path", () => {
    const mismatched: string[] = [];
    for (const [path, item] of Object.entries(served.paths)) {
      const inPath = new Set([...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!));
      for (const [method, op] of Object.entries(item)) {
        if (Array.isArray(op)) continue;
        for (const param of op.parameters ?? []) {
          if (param.in === 'path' && !inPath.has(param.name)) mismatched.push(`${method.toUpperCase()} ${path}: ${param.name}`);
        }
      }
    }
    expect(mismatched).toEqual([]);
  });
});
