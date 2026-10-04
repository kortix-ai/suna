/**
 * Personal secret overrides: any project member manages THEIR OWN per-key
 * override. Split out of routes/secrets.ts, whose registerSecretsRoutes()
 * registers these routes after the write rate limit (./secret-rate-limit).
 */
import { createRoute, z } from '@hono/zod-openapi';
import { projectSecrets } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { auth, errors, json, lenientBody } from '../../openapi';
import { db } from '../../shared/db';
import { readJsonObject } from '../../shared/http-body';
import { roleAllows } from '../access';
import { loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { requestPersonalOwner } from '../lib/personal-resources';
import {
  CODEX_AUTH_JSON_SECRET_NAME,
  isSystemProjectSecretName,
  loadSecretViewsForUser,
} from '../lib/serializers';
import { propagateProjectSecretsToActiveSandboxes } from '../lib/sandbox-env-sync';
import { isGatewayManagedEnv } from '../../llm-gateway/sandbox-credentials';
import { encryptProjectSecret, isValidSecretName } from '../secrets';
export function registerSecretPersonalRoutes(): void {
  // PUT /v1/projects/:projectId/secrets/:name/personal
  // Any project member sets/updates THEIR OWN per-key override (the "use mine"
  // value) and/or flips whether it's active. Operates only on the caller's row;
  // never touches the shared value or anyone else's override.

  projectsApp.openapi(
    createRoute({
      method: 'put',
      path: '/{projectId}/secrets/{name}/personal',
      tags: ['secrets'],
      summary: 'Set your personal override of a project secret',
      ...auth,
        request: {
          params: z.object({ projectId: z.string(), name: z.string() }),
          body: {
            content: {
              'application/json': {
                schema: lenientBody({
                  value: z.string().optional().openapi({ description: 'Your override value.' }),
                  active: z.boolean().optional().openapi({ description: 'Turn the override on or off.' }),
                }),
              },
            },
          },
        },
      responses: {
          200: json(z.any(), 'OK'),
          ...errors(400, 404),
      },
    }),
    async (c: any) => {
    const projectId = c.req.param('projectId');
    const body = await readJsonObject(c);
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Spec 2026-09-22 §2.3: an agent-principal session writes a personal
    // override only for its on-behalf-of human, inside a private session.
    if ((await requestPersonalOwner(c, loaded)) !== loaded.userId) {
      return c.json(
        { error: 'This session cannot change a personal secret', code: 'personal_resource_unreachable' },
        403,
      );
    }

    const name = c.req.param('name')?.trim().toUpperCase();
    if (!name || !isValidSecretName(name)) {
      return c.json({ error: 'Invalid secret name' }, 400);
    }
    if (isSystemProjectSecretName(name)) {
      return c.json({ error: 'KORTIX_* names are reserved and cannot be overridden' }, 400);
    }
    if (name === CODEX_AUTH_JSON_SECRET_NAME) {
      return c.json({ error: `${CODEX_AUTH_JSON_SECRET_NAME} is managed by ChatGPT subscription onboarding` }, 400);
    }
    // LLM provider credentials are always project-wide. The gateway resolves
    // BYOK keys from the SHARED row only (getProjectSecretValue), so a personal
    // override would show the provider as connected in the UI while every model
    // turn 400s with "No upstream configured" (2026-07-07 prod incident).
    if (isGatewayManagedEnv(name)) {
      return c.json(
        {
          error: `${name} is an LLM provider credential — provider keys are always project-wide, update the shared value instead`,
          code: 'llm_credentials_project_wide',
        },
        400,
      );
    }

    const value = typeof body.value === 'string' ? body.value : null;
    const active = typeof body.active === 'boolean' ? body.active : undefined;
    if (value === null && active === undefined) {
      return c.json({ error: 'value or active is required' }, 400);
    }

    const [existingMine] = await db
      .select({ secretId: projectSecrets.secretId })
      .from(projectSecrets)
      .where(and(
        eq(projectSecrets.projectId, projectId),
        eq(projectSecrets.name, name),
        eq(projectSecrets.ownerUserId, loaded.userId),
      ))
      .limit(1);

    const now = new Date();
    if (!existingMine) {
      if (value === null) {
        return c.json({ error: 'value is required to create an override' }, 400);
      }
      await db.insert(projectSecrets).values({
        projectId,
        identifier: name,
        name,
        valueEnc: encryptProjectSecret(projectId, value),
        ownerUserId: loaded.userId,
        active: active ?? true,
        createdBy: loaded.userId,
        updatedAt: now,
      });
    } else {
      await db
        .update(projectSecrets)
        .set({
          ...(value !== null ? { valueEnc: encryptProjectSecret(projectId, value) } : {}),
          ...(active !== undefined ? { active } : {}),
          updatedAt: now,
        })
        .where(eq(projectSecrets.secretId, existingMine.secretId));
    }

    void propagateProjectSecretsToActiveSandboxes(projectId, { refreshModels: isGatewayManagedEnv(name) });

    const views = await loadSecretViewsForUser({
      projectId,
      userId: loaded.userId,
      canManageShared: roleAllows(loaded.effectiveRole, 'manage'),
    });
    return c.json(views.find((v) => v.name === name) ?? { name }, 200);
  },
  );

  // DELETE /v1/projects/:projectId/secrets/:name/personal
  // Remove the caller's own override for this key (falls back to the shared value).

  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{projectId}/secrets/{name}/personal',
      tags: ['secrets'],
      summary: 'Delete your personal override of a project secret',
      ...auth,
        request: {
          params: z.object({ projectId: z.string(), name: z.string() }),
        },
      responses: {
          200: json(z.any(), 'OK'),
          ...errors(400, 404),
      },
    }),
    async (c: any) => {
    const projectId = c.req.param('projectId');
    const name = c.req.param('name')?.trim().toUpperCase();
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    if (!name || !isValidSecretName(name)) {
      return c.json({ error: 'Invalid secret name' }, 400);
    }
    if (name === CODEX_AUTH_JSON_SECRET_NAME) {
      return c.json(
        { error: `${CODEX_AUTH_JSON_SECRET_NAME} must be disconnected as an OAuth provider` },
        400,
      );
    }
    // Spec 2026-09-22 §2.3: an agent-principal session writes a personal
    // override only for its on-behalf-of human, inside a private session.
    if ((await requestPersonalOwner(c, loaded)) !== loaded.userId) {
      return c.json(
        { error: 'This session cannot change a personal secret', code: 'personal_resource_unreachable' },
        403,
      );
    }

    await db
      .delete(projectSecrets)
      .where(and(
        eq(projectSecrets.projectId, projectId),
        eq(projectSecrets.name, name),
        eq(projectSecrets.ownerUserId, loaded.userId),
      ));

    void propagateProjectSecretsToActiveSandboxes(projectId, { refreshModels: isGatewayManagedEnv(name) });

    return c.json({ ok: true });
  },
  );
}
