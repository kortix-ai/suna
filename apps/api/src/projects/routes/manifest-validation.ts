/** Server-side `kortix.toml` / `kortix.yaml` manifest validation. */
import { auth, errors, json } from '../../openapi';
import { createRoute, z } from '@hono/zod-openapi';
import { loadProjectForUser } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { resolveManifestValidateFormat } from '../lib/manifest-format';
import { readJsonObject } from '../../shared/http-body';

// ─── Manifest validation ──────────────────────────────────────────────────
// One schema, exercised in three places: the CLI (`kortix ship` pre-flight +
// `kortix validate`), this server-side endpoint (lets dashboards / tooling
// ask the server "is this valid?"), and the CR-merge gate.
//
// Body: { raw: string, format?: 'toml' | 'yaml' }. Always returns 200 — the
// verdict is in the body so the caller can show issues without having to
// handle HTTP error codes. CLI use: `kortix validate` runs locally, this is
// for surfaces that don't have the file on disk.
//
// DUAL-FORMAT: `raw` may be TOML or YAML text — see
// `resolveManifestValidateFormat` (lib/manifest-format.ts) for the resolution
// order (project manifestPath > body `format` > `toml` default).

// POST /v1/projects/:projectId/manifest/validate

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/manifest/validate',
    tags: ['projects'],
    summary: 'POST /:projectId/manifest/validate',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const body = await readJsonObject(c);
  const raw = typeof body.raw === 'string' ? body.raw : null;
  if (!raw) {
    return c.json({ error: 'Missing `raw` (manifest string) in body.' }, 400);
  }

  const format = resolveManifestValidateFormat(loaded.row.manifestPath, body.format);
  const { validateManifest } = await import('@kortix/manifest-schema');
  const verdict = validateManifest(raw, format);
  return c.json({
    valid: verdict.valid,
    issues: verdict.issues,
  });
},
);
