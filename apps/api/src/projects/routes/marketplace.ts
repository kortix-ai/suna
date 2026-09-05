/**
 * `POST /:projectId/marketplace/install-session` — start the agent-driven
 * install of one marketplace template into this project.
 *
 * That is the whole project-scoped surface. Browsing is the anonymous
 * `/v1/public/marketplace/templates` read, and nothing records what a project
 * has installed: an install is a change request the agent opens, everything it
 * adds lands in that one commit, and reverting the commit is the uninstall.
 *
 * Installing is agent-driven because merging into a LIVE project is
 * judgment-heavy — name collisions, an existing connector that may already
 * hold credentials, a `default_agent` that must not move. So the route starts
 * a session with a generated prompt, and the agent lands a change request a
 * human reviews. The route itself commits nothing.
 *
 * Authorization reuses `project.write` rather than a new permission leaf: the
 * permission catalog is DB-driven, so a new leaf costs a migration plus
 * system-role rows, and installing writes to the project's repo, which is
 * exactly what `project.write` already means.
 */

import { createRoute, z } from '@hono/zod-openapi';
import { manifestCandidatePaths } from '@kortix/manifest-schema';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { isProjectSessionPrincipal } from '../../iam/agent-scope';
import { findMarketplaceCatalogEntry } from '../../marketplace/templates';
import { auth, errors, json } from '../../openapi';
import { readManifestFromRepo } from '../git/files';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { loadGitProject } from '../lib/git';
import { readBody, requestAuditContext } from '../lib/serializers';
import { sendSessionCreateError } from '../lib/sessions';
import { createSession } from '../session-lifecycle';
import { buildMarketplaceInstallPrompt } from './marketplace-install-prompt';

/** The project's manifest raw text, preferring kortix.yaml (dual-format). */
async function manifestRawOrNull(
  project: Parameters<typeof readManifestFromRepo>[0],
): Promise<string | null> {
  const found = await readManifestFromRepo(
    project,
    manifestCandidatePaths(project.manifestPath).map((cand) => cand.path),
    project.defaultBranch,
  ).catch(() => null);
  return found?.content ?? null;
}

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/marketplace/install-session',
    tags: ['marketplace'],
    summary: 'POST /:projectId/marketplace/install-session',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      201: json(z.any(), 'Install session started'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    // Membership authz BEFORE the flag gate, so a stranger gets 404 rather than
    // learning whether this project has the marketplace enabled.
    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const gate = requireFeatureFlag(c, loaded.row.metadata, 'marketplace');
    if (gate) return gate;
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_WRITE,
    );

    const body = await readBody(c);
    const slug = typeof body?.slug === 'string' ? body.slug.trim() : '';
    if (!slug) return c.json({ error: 'slug is required' }, 400);

    const template = findMarketplaceCatalogEntry(slug);
    if (!template) return c.json({ error: 'Template not found' }, 404);

    const project = await loadGitProject(loaded);
    const result = await createSession({
      source: 'ui',
      project: loaded.row,
      userId: loaded.userId,
      requestingPrincipalType:
        c.get('authType') === 'service_account' ? 'service_account' : 'human',
      body: {
        initial_prompt: buildMarketplaceInstallPrompt(template, await manifestRawOrNull(project)),
        // An explicit name, so the session list is scannable and the titling
        // hook never runs the rendered install envelope through a title.
        name: `Install ${template.title}`,
        metadata: {
          kind: 'marketplace-install',
          template_slug: template.slug,
          template_repo: template.repo,
          template_sha: template.resolved_sha,
        },
      },
      visibility: 'project',
      authType: c.get('authType') as string | undefined,
      apiKeyType: c.get('apiKeyType') as string | undefined,
      inSession: isProjectSessionPrincipal(c),
      request: requestAuditContext(c),
      queuePolicy: 'never',
    });
    if (result.error) return sendSessionCreateError(c, result.error);
    if (!result.row) return c.json({ error: 'Session creation returned no row' }, 500);

    return c.json({ session_id: result.row.sessionId }, 201);
  },
);
