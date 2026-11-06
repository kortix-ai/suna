/**
 * The App fleet routes read the workspace id from the `:workspaceId` path
 * parameter. The route-param codemod renamed the paths from `:projectId`;
 * a handler that still read `projectId` got `undefined` on every route.
 */
import { describe, expect, mock, test } from 'bun:test';
import { makeOpenApiApp } from '../openapi';
import type { AppEnv } from '../types';

const app = makeOpenApiApp<AppEnv>();
const authorized: Array<string | undefined> = [];

mock.module('../projects/surface', () => ({ projectsApp: app }));
mock.module('./route-access', () => ({
  authorizedProject: async (c: { json: (body: unknown, status: number) => Response }, projectId: string | undefined) => {
    authorized.push(projectId);
    return c.json({ error: 'stop here' }, 418);
  },
  visibleApp: async () => null,
}));

const { registerAppFleetRoutes } = await import('./fleet-routes');
registerAppFleetRoutes();

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
const APP_ID = '00000000-0000-4000-8000-000000000002';
const VOLUME_ID = '00000000-0000-4000-8000-000000000003';

describe('App fleet routes: the workspace path parameter', () => {
  test.each([
    ['GET', `/${WORKSPACE_ID}/apps/${APP_ID}/machines`],
    ['GET', `/${WORKSPACE_ID}/apps/${APP_ID}/volumes`],
    ['GET', `/${WORKSPACE_ID}/apps/${APP_ID}/volumes/${VOLUME_ID}/snapshots`],
  ])('%s %s authorizes the workspace id from the path', async (method, path) => {
    authorized.length = 0;
    const res = await app.request(path, { method });
    expect(res.status).toBe(418);
    expect(authorized).toEqual([WORKSPACE_ID]);
  });
});
