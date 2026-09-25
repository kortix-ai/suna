/** Inbound trigger webhooks: `POST /v1/webhooks/projects/:projectId/:slug` fires a webhook trigger. */
import { db } from '../../shared/db';
import { getProjectSecretValueForConsumer } from '../secrets';
import { loadProjectTriggers } from '../triggers';
import { invalidateProjectMirror } from '../git';
import { projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { projectWebhooksApp } from '../lib/app';
import { withProjectGitAuth } from '../lib/git';
import { UUID_V4_REGEX, requestAuditContext } from '../lib/serializers';
import { extractWebhookToken, fireGitTrigger, markGitTriggerFired, renderPromptTemplate, triggerFilterMatches, triggersPausedForProject, verifyWebhookSignature, verifyWebhookToken, webhookPayload } from '../lib/triggers';
import {
  validateWebhookSecretConfiguration,
  webhookSecretConfigurationError,
} from '../lib/webhook-secret-policy';
import {
  consumeProjectWebhookManifestRefreshBudget,
  createProjectWebhookRateLimitMiddleware,
} from '../../shared/rate-limit';
import { bindIntegrationPrincipal } from '../../shared/audit-scope';

projectWebhooksApp.use('/projects/:projectId/:slug', createProjectWebhookRateLimitMiddleware());

projectWebhooksApp.post('/projects/:projectId/:slug', async (c) => {
  const projectId = c.req.param('projectId');
  const slug = c.req.param('slug');
  if (!UUID_V4_REGEX.test(projectId)) return c.json({ error: 'Invalid project id' }, 400);
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
  if (!project) return c.json({ error: 'Not found' }, 404);

  // Trigger CRUD can commit on another API replica. Refresh this replica's
  // mirror before authentication, but bound the unauthenticated Git work by
  // project. Rotating source IPs cannot force more than one refresh per 30s.
  if (consumeProjectWebhookManifestRefreshBudget(projectId)) {
    invalidateProjectMirror(projectId);
  }
  const { specs } = await loadProjectTriggers(await withProjectGitAuth(project));
  const spec = specs.find((s) => s.slug === slug);
  if (!spec || spec.type !== 'webhook' || !spec.enabled) {
    return c.json({ error: 'Not found' }, 404);
  }

  const rawBody = await c.req.text();
  if (!spec.secretEnv) {
    return c.json(webhookSecretConfigurationError('missing'), 409);
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
    return c.json(configurationError ?? webhookSecretConfigurationError('unavailable'), 409);
  }

  // Primary auth: HMAC-SHA256 signature over the raw body (GitHub-compatible).
  // Fallback, ONLY when no signature header is present: a static shared token in
  // X-Kortix-Token or Authorization, for sources that can't HMAC-sign their body
  // (e.g. Better Stack error webhooks — custom headers / basic auth only). Both
  // paths require knowing the trigger's secret, so security is equivalent to a
  // shared bearer token; signed senders are unaffected.
  const signatureHeader =
    c.req.header('x-kortix-signature') || c.req.header('x-hub-signature-256') || null;
  const authed = signatureHeader
    ? verifyWebhookSignature(rawBody, secret, signatureHeader)
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
    ...webhookPayload(c, rawBody),
    trigger: { slug: spec.slug, type: spec.type, kind: 'git' },
    fired_at: new Date().toISOString(),
  };
  const renderedPrompt = renderPromptTemplate(spec.promptTemplate, payload);
  const deliveryId =
    c.req.header('x-kortix-delivery-id') ??
    c.req.header('x-github-delivery') ??
    c.req.header('x-request-id') ??
    null;
  const staticAuthFingerprint =
    c.req.header('x-kortix-token') ??
    c.req.header('authorization') ??
    '';
  const idempotencyKey = deliveryId
    ? `trigger:webhook:${project.projectId}:${spec.slug}:${deliveryId}`
    : `trigger:webhook:${project.projectId}:${spec.slug}:${createHash('sha256')
        .update(rawBody)
        .update(signatureHeader ?? '')
        .update(staticAuthFingerprint)
        .digest('hex')}`;

  // Server-side per-project kill-switch: a paused project ignores inbound
  // webhooks (acknowledged, not fired) so a repo deployed to two control planes
  // doesn't double-fire. Manual `…/fire` is unaffected. See triggersPausedForProject.
  if (triggersPausedForProject(project.metadata)) {
    return c.json({ status: 'skipped', reason: 'triggers are paused server-side for this project' }, 200);
  }

  // Payload guard. A non-matching delivery is a successful no-op, NOT an error:
  // the sender is behaving correctly and must not see a 4xx it would retry. The
  // canonical use is loop-breaking — a source that reports both directions of a
  // conversation would otherwise re-fire the agent with the agent's own reply.
  if (!triggerFilterMatches(spec, payload)) {
    return c.json({ status: 'skipped', reason: 'delivery did not match the trigger filter' }, 200);
  }

  const result = await fireGitTrigger({
    spec,
    project,
    payload,
    renderedPrompt,
    source: 'webhook',
    idempotencyKey,
    request: requestAuditContext(c),
  });

  if (result.status === 'queued') {
    await markGitTriggerFired(project.projectId, spec.slug, new Date());
    return c.json({
      status: 'queued',
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
  await markGitTriggerFired(project.projectId, spec.slug, new Date());
  return c.json({
    status: result.deduped ? 'deduped' : 'fired',
    command_id: result.commandId ?? null,
    session_id: result.sessionId ?? null,
    deduped: result.deduped ?? false,
  }, 202);
});
