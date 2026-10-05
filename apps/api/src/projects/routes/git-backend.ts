/**
 * The instance git backend — "Kortix managed" git, ONE deployment-wide thing.
 *
 * It has its own namespace on purpose. It used to ride inside
 * `GET /projects/github/installations` as a synthetic installation with the
 * id `pat`, which made an instance-global credential look like one account's
 * GitHub connection: the same conflation that let a platform admin replace
 * production's App from a customer's settings page (2026-09-16).
 *
 *   GET /v1/projects/git/backend               — any authenticated user
 *   GET /v1/projects/git/backend/repositories  — self-host operator only
 */

import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json } from '../../openapi';
import { isSelfHostOperator } from '../../shared/platform-roles';
import { resolveGitBackend } from '../../platform/services/managed-git-backend';
import { createInstallationToken, listOwnerRepositories } from '../github';
import { projectsApp } from '../lib/app';
import { serializeGitHubRepo } from '../lib/serializers';

const GitBackendSchema = z
  .object({
    configured: z.boolean(),
    kind: z.enum(['app', 'pat']).nullable(),
    owner: z.string().nullable(),
  })
  .openapi('InstanceGitBackend');

// GET /v1/projects/git/backend
//
// Readable by any authenticated user: it exposes only the owner login, which
// every managed project's `repo_url` already carries. The credential and the
// installation id never leave the server.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/git/backend',
    tags: ['github'],
    summary: 'Read the instance git backend',
    ...auth,
    responses: {
      200: json(GitBackendSchema, 'The instance git backend'),
      ...errors(401),
    },
  }),
  async (c: any) => {
    const backend = resolveGitBackend();
    return c.json({
      configured: Boolean(backend),
      kind: backend?.kind ?? null,
      owner: backend?.owner ?? null,
    });
  },
);

// GET /v1/projects/git/backend/repositories?search=&limit=
//
// `isSelfHostOperator`, NOT `isPlatformAdmin`. This lists the WHOLE backend
// owner, which on cloud is `managed-kortix` — every customer's project repo.
// Kortix staff are platform admins too, so gating on that role once put every
// customer's private repository in the import picker (reported 2026-08-29).

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/git/backend/repositories',
    tags: ['github'],
    summary: 'List repositories under the instance git backend owner',
    ...auth,
    request: {
      query: z.object({
        search: z.string().optional(),
        limit: z.string().optional(),
      }),
    },
    responses: {
      200: json(z.any(), 'Repositories under the instance backend owner'),
      ...errors(401, 403, 409, 502),
    },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    if (!(await isSelfHostOperator(userId))) {
      return c.json(
        { error: 'The instance git backend is only browsable by a self-host operator' },
        403,
      );
    }

    const backend = resolveGitBackend();
    if (!backend) {
      return c.json({ error: 'This server has no instance git backend configured' }, 409);
    }

    const rawSearch = c.req.query('search');
    const search =
      typeof rawSearch === 'string' && rawSearch.trim() ? rawSearch.trim().slice(0, 120) : undefined;
    const requestedLimit = Number.parseInt(c.req.query('limit') ?? '', 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(100, Math.max(1, requestedLimit))
      : 100;

    try {
      // One resolved backend, one credential — the token and the owner always
      // come from the same source.
      const token =
        backend.kind === 'pat'
          ? backend.token
          : (await createInstallationToken(backend.installationId)).token;
      const repos = await listOwnerRepositories({
        owner: backend.owner,
        ownerType: backend.kind === 'app' ? (backend.ownerType ?? undefined) : undefined,
        auth: { token },
        search,
        limit,
      });
      return c.json({ owner: backend.owner, repositories: repos.map(serializeGitHubRepo) });
    } catch (error) {
      return c.json(
        { error: (error as Error).message || 'Failed to list instance backend repositories' },
        502,
      );
    }
  },
);
