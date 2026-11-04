/** Server-side `kortix.yaml` manifest validation. */
import { auth, boundedIssues, errors, json, lenientBody } from '../../openapi';
import { createRoute, z } from '@hono/zod-openapi';
import { loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { readJsonObject } from '../../shared/http-body';

export function registerManifestValidationRoutes(): void {
  // ─── Manifest validation ──────────────────────────────────────────────────
  // One schema, exercised in three places: the CLI (`kortix ship` pre-flight +
  // `kortix validate`), this server-side endpoint (lets dashboards / tooling
  // ask the server "is this valid?"), and the CR-merge gate.
  //
  // Body: { raw: string } — the kortix.yaml text. Always returns 200 — the
  // verdict is in the body so the caller can show issues without having to
  // handle HTTP error codes. CLI use: `kortix validate` runs locally, this is
  // for surfaces that don't have the file on disk.

  // POST /v1/projects/:projectId/manifest/validate

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/manifest/validate',
      tags: ['projects'],
      summary: 'Validate a project kortix.yaml manifest',
      ...auth,
        request: {
          params: z.object({ projectId: z.string() }),
          body: { content: { 'application/json': { schema: lenientBody({
              raw: z.string().openapi({ description: 'Manifest text (kortix.yaml) to validate.' }),
            }) } } },
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

    const { convertLegacyManifest, legacyFormatOf, locateIssues, validateManifest } = await import('@kortix/manifest-schema');
    const verdict = validateManifest(raw);
    // A legacy format (`kortix_version: 2`) runs converted: validate what runs. The text has no repo files beside it.
    const from = legacyFormatOf(verdict.parsed);
    if (from && verdict.parsed) {
      const converted = validateManifest(convertLegacyManifest(verdict.parsed, from, 'kortix.yaml', { paths: [], read: () => null }).raw).issues;
      locateIssues(raw, converted);
      verdict.issues.push(...converted);
    }
    const valid = !verdict.issues.some((issue) => issue.severity === 'error');
    return c.json({
      valid,
      ...boundedIssues(verdict.issues),
    });
  },
  );
}
