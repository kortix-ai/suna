/**
 * The sandbox secret-sync route: a person re-pushes every project secret to
 * every active sandbox; an agent session pulls only its own. Split out of
 * routes/secrets.ts, whose registerSecretsRoutes() registers this route
 * after the write rate limit (./secret-rate-limit).
 */
import { createRoute, z } from '@hono/zod-openapi';
import { PROJECT_ACTIONS } from '../../iam';
import { isProjectSessionPrincipal } from '../../iam/agent-scope';
import { auth, errors, json } from '../../openapi';
import {
  propagateProjectSecretsToActiveSandboxes,
  syncSessionSecretsToSandbox,
} from '../../services/sandboxes/sandbox-env-sync';
import { reconcileStoredSessionAgentGrant } from '../../services/sessions/session-token-grant';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
export function registerSecretSyncRoutes(): void {
  // POST /v1/projects/:projectId/secrets/sync
  // Force a re-push of all project secrets to all active sandboxes. Use after
  // setting a secret via the intake link or when secrets are missing from a
  // session's environment despite being set in the store.
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/secrets/sync',
      tags: ['secrets'],
      summary: 'Re-push project secrets to active sandboxes',
      ...auth,
      request: { params: z.object({ projectId: z.string() }) },
      responses: {
        200: json(
          z.object({
            ok: z.boolean(),
            active_sandboxes: z.number().int().nonnegative(),
            targeted: z.number().int().nonnegative(),
            synced: z.number().int().nonnegative(),
            failed: z.number().int().nonnegative(),
            exported: z.number().int().nonnegative(),
            results: z.array(z.object({
              session_id: z.string(),
              sandbox_id: z.string().nullable(),
              status: z.enum(['synced', 'failed']),
              scope: z.enum(['inherit', 'restricted', 'none']).nullable(),
              revision: z.string().nullable(),
              exported: z.number().int().nonnegative(),
              managed: z.number().int().nonnegative().nullable(),
              withheld: z.number().int().nonnegative().nullable(),
              agent_env_written: z.boolean(),
              reason: z.string().optional(),
            })),
          }),
          'Secret delivery verification result',
        ),
        ...errors(403, 404),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      // An agent session pulls ITS OWN session: re-push this sandbox's env from
      // the store and its current grant. Every prompt already does exactly this
      // (pre-prompt env sync), so it grants nothing new — it lets the agent pick
      // up a secret or grant a person just saved without waiting for the next
      // message. It never reaches another session's box: the project-wide
      // re-push below stays a person's action, because re-minting every handle
      // in every sandbox is the re-mint half of the policy-widening chain
      // (d649d08932, finding F6).
      if (isProjectSessionPrincipal(c)) {
        const sessionId = c.get('sessionId') as string | undefined;
        if (!sessionId) {
          return c.json(
            { error: 'Only a session can sync its own secrets', code: 'agent_human_only_action' },
            403,
          );
        }
        // Pulling into its own box writes nothing: read is the gate.
        await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SECRET_READ);
        // Refresh the token's stored grant too, as a prompt does, so
        // `kortix secrets ls` in this same turn reflects a just-widened grant.
        // Best-effort: env delivery resolves the grant on its own.
        await reconcileStoredSessionAgentGrant({ projectId, sessionId }).catch((err: unknown) => {
          console.warn('[secrets] sync: could not refresh the session grant', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        return c.json(await syncSessionSecretsToSandbox(projectId, sessionId));
      }
      await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SECRET_WRITE);
      const result = await propagateProjectSecretsToActiveSandboxes(projectId);
      return c.json(result);
    },
  );
}
