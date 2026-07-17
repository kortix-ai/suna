/**
 * GET/PUT /:projectId/acp/permission-policy — Task WS5-P1-a: the persistent
 * ACP permission-policy API. Additive, metadata-backed
 * (`projects.metadata.acp_permission_policy` — no migration), deny-by-
 * default: an absent policy resolves to the same conservative floor as
 * today's behavior (every ACP tool call prompts, nothing is remembered).
 * First task of the permission chain — the SDK hook and unified permission
 * surface (P1-b/c) consume `readAcpPermissionPolicy` (`../lib/acp-permission-
 * policy.ts`) built here.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { AcpPermissionPolicySchema } from '@kortix/api-contract';
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { PROJECT_ACTIONS } from '../../iam/actions';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { readAcpPermissionPolicy, writeAcpPermissionPolicy } from '../lib/acp-permission-policy';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';

// The PUT body is validated in STRICT mode — an unknown top-level key 422s
// instead of being silently stripped, so a client typo (or a future field
// added elsewhere without updating this contract) fails loudly rather than
// quietly no-opping. The exported `AcpPermissionPolicySchema` itself stays
// non-strict (it's the shared wire contract, consumed by P1-b/c); strictness
// here is a route-local request-validation choice, same posture as
// `agent-config.ts`'s `RuntimeProfilesBodySchema`.
const AcpPermissionPolicyBody = AcpPermissionPolicySchema.strict();

// The `createRoute` body schema below is intentionally the permissive
// `AnyObject` (docs-only, mirrors the PATCH /onboarding route in r6.ts) —
// `@hono/zod-openapi` auto-validates against whatever schema is declared
// there and 400s BEFORE the handler runs, which would preempt our own 422 on
// bad `autoApprove`/`toolDecisions` values. All real validation happens
// below via `AcpPermissionPolicyBody.safeParse`, the sole source of the
// route's error responses.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/acp/permission-policy',
    tags: ['projects'],
    summary: 'GET /:projectId/acp/permission-policy',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: { 200: json(AcpPermissionPolicySchema, 'The project ACP permission policy'), ...errors(404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    return c.json(readAcpPermissionPolicy(loaded.row.metadata));
  },
);

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/acp/permission-policy',
    tags: ['projects'],
    summary: 'PUT /:projectId/acp/permission-policy',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: { 200: json(AcpPermissionPolicySchema, 'The updated ACP permission policy'), ...errors(403, 404, 422) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    // Floor 'read'; project.customize.write is the real gate below — a
    // permission policy is project customization, same posture as
    // model-defaults.ts and the harness-connections PUT route.
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);

    const parsed = AcpPermissionPolicyBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Invalid ACP permission policy', code: 'invalid_body', issues: parsed.error.issues }, 422);
    }

    const metadata = writeAcpPermissionPolicy(loaded.row.metadata, parsed.data);
    await db.update(projects).set({ metadata, updatedAt: new Date() }).where(eq(projects.projectId, projectId));
    return c.json(parsed.data);
  },
);
