/**
 * The live-document routes of a doc Artifact read the workspace id from the
 * `:workspaceId` path parameter. The route-param codemod renamed the paths
 * from `:projectId`; a handler that still read `projectId` got `undefined`.
 */
import { describe, expect, mock, test } from 'bun:test';

const loaded: Array<{ projectId: string | undefined; artifactId: string | undefined }> = [];

mock.module('../lib/artifact-access', () => ({
  loadArtifactForCaller: async (
    c: { json: (body: unknown, status: number) => Response },
    projectId: string | undefined,
    artifactId: string | undefined,
  ) => {
    loaded.push({ projectId, artifactId });
    return { ok: false, response: c.json({ error: 'stop here' }, 418) };
  },
}));

const { projectsApp } = await import('../lib/app');
const { registerArtifactDocRoutes } = await import('./artifact-doc');
registerArtifactDocRoutes();

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000011';
const ARTIFACT_ID = '00000000-0000-4000-8000-000000000012';

describe('doc Artifact routes: the workspace path parameter', () => {
  test.each([
    ['GET', 'doc', undefined],
    ['POST', 'doc/lease', JSON.stringify({ holder: 'h' })],
  ])('%s /doc route %s loads the Artifact of the workspace in the path', async (method, suffix, body) => {
    loaded.length = 0;
    const res = await projectsApp.request(`/${WORKSPACE_ID}/artifacts/${ARTIFACT_ID}/${suffix}`, {
      method,
      body,
      headers: body ? { 'content-type': 'application/json' } : undefined,
    });
    expect(loaded).toEqual([{ projectId: WORKSPACE_ID, artifactId: ARTIFACT_ID }]);
    expect(res.status).toBe(418);
  });
});
