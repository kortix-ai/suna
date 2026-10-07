/** Inbound trigger webhooks: `POST /v1/webhooks/projects/:projectId/:slug` fires a webhook trigger. */
import { db } from '../../shared/db';
import { getProjectSecretValueForConsumer } from '../secrets';
import { loadProjectTriggers } from '../triggers';
import { invalidateProjectMirror } from '../git';
import { projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { createRoute, z } from '@hono/zod-openapi';
import { errors, json } from '../../openapi';
import { TriggerFireResultSchema, projectWebhooksApp } from '../lib/app';
import { withProjectGitAuth } from '../lib/git';
import { requestAuditContext } from '../lib/serializers';
import { isUuid } from '../../shared/validate';
import { releaseWebhookDeliveryKey, webhookDeliveryKey } from '../lib/webhook-delivery';
import { extractWebhookToken, fireGitTrigger, markGitTriggerFired, renderPromptTemplate, triggerFilterMatches, triggersPausedForProject, verifyWebhookSignature, verifyWebhookToken, webhookPayload } from '../lib/triggers';
import {
  validateWebhookSecretConfiguration,
  webhookSecretConfigurationError,
} from '../lib/webhook-secret-policy';
import { consumeProjectWebhookManifestRefreshBudget, createProjectWebhookRateLimitMiddleware } from '../../middleware/rate-limit';
import { logger } from '../../lib/logger';
import { bindIntegrationPrincipal } from '../../shared/audit-scope';

const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

export function registerTriggerWebhooksRoutes(): void {
  projectWebhooksApp.use('/projects/:projectId/:slug', createProjectWebhookRateLimitMiddleware());

  projectWebhooksApp.openapi(createRoute({
    method: 'post',
    path: '/projects/{projectId}/{slug}',
    tags: ['triggers'],
    summary: 'Fire a webhook trigger',
    description:
      'Authenticated by the trigger secret, not a bearer token: send `X-Kortix-Signature` / `X-Hub-Signature-256` (HMAC of the raw body), `X-Kortix-Token`, or `Authorization: Bearer <secret>`. Add `X-Kortix-Timestamp` (epoch seconds, within 5 minutes) to sign `<timestamp>.<body>` and stop replay. Every pre-authentication miss answers 401. The JSON body is the payload the prompt template renders.',
    // No body schema: the handler HMACs the raw bytes, so nothing may parse them first.
    request: { params: z.object({ projectId: z.string(), slug: z.string() }) },
    responses: {
      200: json(z.object({ status: z.literal('skipped'), reason: z.string() }), 'Accepted, not fired'),
      202: json(TriggerFireResultSchema, 'Queued or fired'),
      ...errors(400, 401, 500),
    },
  }), async (c) => {
    const projectId = c.req.param('projectId');
    const slug = c.req.param('slug');
    if (!isUuid(projectId)) return c.json({ error: 'Invalid project id' }, 400);
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug)) {
      return c.json({ error: 'Invalid trigger slug' }, 400);
    }

    const hasCredentialHeader = Boolean(
      c.req.header('x-kortix-signature') ||
        c.req.header('x-hub-signature-256') ||
        c.req.header('x-kortix-token') ||
        c.req.header('authorization'),
    );
    if (!hasCredentialHeader) {
      return c.json({ error: 'Invalid webhook signature' }, 401);
    }

    const [project] = await db
      .select()
      .from(projects)
      .where(and(
        eq(projects.projectId, projectId),
        eq(projects.status, 'active'),
      ))
      .limit(1);
    // Every pre-authentication miss answers the same 401 as a bad signature, so a
    // caller holding any credential header cannot tell which projects, slugs or
    // secret configurations exist. The reason is logged for the owner.
    const reject = (reason: string, extra?: Record<string, unknown>) => {
      logger.warn('[trigger-webhook] rejected before authentication', { projectId, slug, reason, ...extra });
      return c.json({ error: 'Invalid webhook signature' }, 401);
    };
    if (!project) return reject('project_not_found');

    // Trigger CRUD can commit on another API replica. Refresh this replica's
    // mirror before authentication, but bound the unauthenticated Git work by
    // project. Rotating source IPs cannot force more than one refresh per 30s.
    if (consumeProjectWebhookManifestRefreshBudget(projectId)) {
      invalidateProjectMirror(projectId);
    }
    const { specs } = await loadProjectTriggers(await withProjectGitAuth(project));
    const spec = specs.find((s) => s.slug === slug);
    if (!spec || spec.type !== 'webhook' || !spec.enabled) return reject('trigger_not_found');

    const rawBody = await c.req.text();
    if (!spec.secretEnv) {
      return reject('webhook_secret_missing');
    }
    const secret = await getProjectSecretValueForConsumer({
      projectId: project.projectId,
      accountId: project.accountId,
      name: spec.secretEnv,
      consumer: 'connector',
    });
    if (!secret) {
      const configurationError = await validateWebhookSecretConfiguration({
        projectId: project.projectId,
        secretEnv: spec.secretEnv,
      });
      return reject((configurationError ?? webhookSecretConfigurationError('unavailable')).code);
    }

    // Primary auth: HMAC-SHA256 signature over the raw body (GitHub-compatible).
    // Fallback, ONLY when no signature header is present: a static shared token in
    // X-Kortix-Token or Authorization, for sources that can't HMAC-sign their body
    // (e.g. Better Stack error webhooks — custom headers / basic auth only). Both
    // paths require knowing the trigger's secret, so security is equivalent to a
    // shared bearer token; signed senders are unaffected.
    const signatureHeader =
      c.req.header('x-kortix-signature') || c.req.header('x-hub-signature-256') || null;
    // Optional replay guard: a sender that adds `X-Kortix-Timestamp` (epoch
    // seconds) signs `<timestamp>.<body>`; a stale or future timestamp is refused.
    const timestampHeader = c.req.header('x-kortix-timestamp');
    if (signatureHeader && timestampHeader) {
      const seconds = Number(timestampHeader);
      if (!Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) {
        return c.json({ error: 'Invalid webhook signature' }, 401);
      }
    }
    const authed = signatureHeader
      ? verifyWebhookSignature(timestampHeader ? `${timestampHeader}.${rawBody}` : rawBody, secret, signatureHeader)
      : verifyWebhookToken(
          extractWebhookToken(c.req.header('x-kortix-token'), c.req.header('authorization')),
          secret,
        );
    if (!authed) {
      return c.json({ error: 'Invalid webhook signature' }, 401);
    }
    bindIntegrationPrincipal('project_webhook', {
      accountId: project.accountId,
      projectId: project.projectId,
    });

    (c as any).set('accountId', project.accountId);

    const payload = {
      ...webhookPayload((name) => c.req.header(name), rawBody),
      trigger: { slug: spec.slug, type: spec.type, kind: 'git' },
      fired_at: new Date().toISOString(),
    };
    const renderedPrompt = renderPromptTemplate(spec.promptTemplate, payload);
    // One delivery runs once: keyed on the event when the sender names one,
    // else on the body inside a replay window (projects/lib/webhook-delivery.ts).
    const delivery = webhookDeliveryKey({
      projectId: project.projectId,
      slug: spec.slug,
      header: (name) => c.req.header(name),
      rawBody,
      signatureHeader,
      staticAuthFingerprint: c.req.header('x-kortix-token') ?? c.req.header('authorization') ?? '',
    });
    const idempotencyKey = delivery.key;

    // Server-side per-project kill-switch: a paused project ignores inbound
    // webhooks (acknowledged, not fired) so a repo deployed to two control planes
    // doesn't double-fire. Manual `…/fire` is unaffected. See triggersPausedForProject.
    if (triggersPausedForProject(project.metadata)) {
      return c.json({ status: 'skipped' as const, reason: 'triggers are paused server-side for this project' }, 200);
    }

    // Payload guard. A non-matching delivery is a successful no-op, NOT an error:
    // the sender is behaving correctly and must not see a 4xx it would retry. The
    // canonical use is loop-breaking — a source that reports both directions of a
    // conversation would otherwise re-fire the agent with the agent's own reply.
    if (!triggerFilterMatches(spec, payload)) {
      return c.json({ status: 'skipped' as const, reason: 'delivery did not match the trigger filter' }, 200);
    }

    // A key whose earlier run dead-lettered, lost its session, or (body-hash
    // keys) aged out of the replay window answers for nothing: free it so
    // this delivery runs instead of replaying that outcome.
    await releaseWebhookDeliveryKey(idempotencyKey, { byEvent: delivery.byEvent });
    const result = await fireGitTrigger({
      spec,
      project,
      payload,
      renderedPrompt,
      source: 'webhook',
      idempotencyKey,
      request: requestAuditContext(c),
    });

    // A duplicate ran nothing: it answers `deduped` and leaves last_fired_at alone.
    if (result.status === 'queued') {
      if (!result.deduped) await markGitTriggerFired(project.projectId, spec.slug, new Date());
      return c.json({
        status: result.deduped ? ('deduped' as const) : ('queued' as const),
        command_id: result.commandId ?? null,
        session_id: result.sessionId ?? null,
        reason: result.reason ?? null,
        deduped: result.deduped ?? false,
      }, 202);
    }
    if (result.status === 'failed') {
      return c.json({ error: result.error ?? 'Failed to fire trigger' }, 500);
    }
    // Stamp runtime last_fired_at so the UI's "last fired N ago" matches the
    // cron-fire path even when the webhook is the actual source.
    if (!result.deduped) await markGitTriggerFired(project.projectId, spec.slug, new Date());
    return c.json({
      status: result.deduped ? ('deduped' as const) : ('fired' as const),
      command_id: result.commandId ?? null,
      session_id: result.sessionId ?? null,
      deduped: result.deduped ?? false,
    }, 202);
  });
}
