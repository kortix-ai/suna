import { type AuthedPrincipal } from '@kortix/llm-gateway';
import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json } from '../../openapi';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { verifyProviderConnection } from '../../llm-gateway/provider-verify';
import { assertGatewayBudget, GatewayBudgetExceededError } from '../../llm-gateway/hooks';

export function registerGatewayProvidersRoutes(): void {
  // GAP C1 — "Connected" (a secret row exists) is not the same claim as "the
  // key works". This makes ONE cheap, single-attempt completion through the
  // same resolveCandidates -> callUpstream path a real turn uses and reports
  // verified/invalid/unknown/not_connected — see provider-verify.ts for the
  // full classification rationale. Gated on PROJECT_SECRET_READ (same leaf as
  // GET /secrets): it never exposes the key itself, only whether it works, so
  // any member who can already see that the provider is connected can check
  // whether it's actually usable.
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/gateway/providers/{providerId}/verify',
      tags: ['gateway'],
      summary: 'Verify a project LLM provider credential',
      ...auth,
      request: { params: z.object({ projectId: z.string(), providerId: z.string() }) },
      responses: {
        200: json(z.any(), 'Provider credential verification result'),
        ...errors(403, 404),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const providerId = c.req.param('providerId');
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_SECRET_READ,
      );

      const principal: AuthedPrincipal = {
        userId: c.get('userId'),
        accountId: loaded.row.accountId,
        projectId,
      };
      // The ping is a real (if tiny) paid upstream call for a platform-fee-billed
      // BYOK project — it must respect an already-exceeded project budget like
      // any other gateway call (see playground's identical guard above). Caught
      // rather than left to propagate: a budget block is exactly the "couldn't
      // verify" case this endpoint already models, not a hard failure.
      try {
        await assertGatewayBudget(principal);
      } catch (err) {
        if (!(err instanceof GatewayBudgetExceededError)) throw err;
        return c.json({
          status: 'unknown',
          message: err instanceof Error ? err.message : 'Project budget exceeded — try again later.',
          checked_at: new Date().toISOString(),
        });
      }
      const result = await verifyProviderConnection(principal, providerId);
      return c.json({ ...result, checked_at: new Date().toISOString() });
    },
  );
}
