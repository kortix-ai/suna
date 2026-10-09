/** Project triggers: list, create, update, activate, delete, and manual fire. */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { projectTriggerRuntime, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { mutateManifestWithRetry } from '../../connectors/manifest-mutation';
import { loadProjectAgents } from '../agents';
import { assertMayRunAgent } from '../lib/agent-access';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json, lenientBody } from '../../openapi';
import { db } from '../../shared/db';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { OkSchema, TriggerFireResultSchema, TriggerListSchema, projectsApp } from '../lib/app';
import { guardSession } from '../lib/http-session-access';
import { withProjectGitAuth } from '../lib/git';
import { resolveSessionAgentName } from '../lib/session-create';
import { metadataMerge } from '../lib/metadata-merge';
import { requestAuditContext } from '../lib/serializers';
import { readJsonObject } from '../../shared/http-body';
import {
  draftToSpec,
  fireGitTrigger,
  loadTriggersForResponse,
  markGitTriggerFired,
  parseTriggerDraft,
  removeTriggerFromManifest,
  renderPromptTemplate,
  specToBody,
  upsertTriggerInManifest,
} from '../lib/triggers';
// From the leaf, not the barrel: suites that stub '../lib/triggers' by listing
// its exports would otherwise lose this name.
import { markGitTriggerAttemptFailed } from '../lib/trigger-fire';
import { raiseTriggerAlert } from '../lib/trigger-alerts';
import { deleteTriggerWatchers, triggerWatcherOf, upsertTriggerWatcher } from '../lib/trigger-watchers';
import { getRequestOnBehalfOf } from '../../middleware/on-behalf-of';
import { notificationsEnabled } from '../../notifications/enabled';
import { logger } from '../../lib/logger';
import type { AppEnv } from '../../types';
import { validateWebhookSecretConfiguration } from '../lib/webhook-secret-policy';
import { reconcileProjectTriggerRuntime } from '../trigger-runtime-catalog';
import { connectorInfo, eventPayload } from '../trigger-events/deliver';
import { listConnectorEventTypes, listEventApps, validateEventTrigger } from '../trigger-events/catalog';
import { reconcileEventSubscriptions } from '../trigger-events/subscriptions';
import {
  PRIVATE_TRIGGER_SESSION_ACCESS,
  parseTriggerSessionAccess,
  setTriggerSessionAccess,
  validateTriggerSessionAccessPrincipals,
} from '../trigger-session-access';
import {
  type ParsedManifest,
  extractTriggers,
  findProjectTriggerBySlug,
} from '../triggers';

/**
 * The person who created or edited a trigger follows its alerts (KRTX-1742).
 * Never an API key or a service account: they name no person. Only with the
 * project's `notification_center` flag on.
 */
async function followTrigger(
  c: Context<AppEnv>,
  project: { accountId: string; metadata: unknown },
  projectId: string,
  slug: string,
): Promise<void> {
  if (!notificationsEnabled(project.metadata)) return;
  const userId = triggerWatcherOf({
    authType: c.get('authType'),
    userId: c.get('userId'),
    sessionId: c.get('sessionId'),
    onBehalfOfUserId: getRequestOnBehalfOf(c),
  });
  if (!userId) return;
  // Best-effort: the manifest is already committed, so a failed write must not fail the route.
  await upsertTriggerWatcher({ accountId: project.accountId, projectId, slug, userId }).catch((err) =>
    logger.warn('[trigger-watchers] follow failed', { projectId, slug, error: err instanceof Error ? err.message : String(err) }));
}

/** Body keys that change which event a trigger subscribes to. */
const EVENT_BODY_KEYS = ['connector', 'event_account', 'event_source', 'event', 'event_config'];

/** Merge-body keys owned by one trigger type, dropped when a PATCH changes the type. */
const TYPE_SPECIFIC_BODY_KEYS = [
  'cron', 'run_at', 'timezone', 'secret_env', 'run', 'mode', 'interval',
  'expect_event_within', 'connector', 'event_account', 'event_source', 'event', 'event_config',
] as const;

// Body keys that change the trigger's *repo manifest* (committed to git). A PATCH
// whose body touches none of these has nothing to commit, so we skip git entirely
// and treat it as a no-op.
const TRIGGER_MANIFEST_KEYS = [
  'name',
  'type',
  'agent',
  'model',
  'enabled',
  'prompt_template',
  'promptTemplate',
  'cron',
  'schedule',
  'run_at',
  'runAt',
  'timezone',
  'secret_env',
  'secretEnv',
  'session_mode',
  'sessionMode',
  'session_id',
  'sessionId',
  'session_key',
  'sessionKey',
  'filter',
  'connector',
  'event_account',
  'event_source',
  'event',
  'event_config',
] as const;

export function registerTriggersRoutes(): void {
  // GET /v1/projects/:projectId/triggers
  //
  // Lists triggers defined as files in `.opencode/triggers/*.md` on the
  // project's default branch, plus any parse errors and runtime state
  // (last_fired_at). The repo is the source of truth — POST/PATCH/DELETE
  // below commit/update/delete the underlying file.

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/triggers',
      tags: ['triggers'],
      summary: 'List project triggers',
      ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
      responses: {
        200: json(TriggerListSchema, 'Triggers, the pause switch and manifest parse errors'),
        ...errors(404),
      },
    }),
    async (c) => {
      const projectId = c.req.param('projectId');
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      // Leaf-gate the read (a custom role can omit project.trigger.read) — and, via
      // the central agent-grant fold, an agent token must hold it in its Kortix permissions.
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_TRIGGER_READ,
      );

      return c.json(await loadTriggersForResponse(projectId, loaded.row));
    },
  );

  // GET /v1/projects/:projectId/triggers/event-apps
  //
  // ⚠️ Keep registered BEFORE the `…/triggers/{slug}` routes (see `activation` below).
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/triggers/event-apps',
      tags: ['triggers'],
      summary: 'List the apps that can trigger an event',
      description: 'Apps with at least one event type, with the project connector for each and whether a project-shared account is connected.',
      ...auth,
      request: { params: z.object({ projectId: z.string() }) },
      responses: {
        200: json(
          z.object({
            apps: z.array(z.object({
              source: z.string().openapi({ description: 'Event source adapter id, such as composio. The trigger `event_source` value.' }),
              provider: z.string().openapi({ deprecated: true, description: 'Deprecated alias of `source`.' }),
              app: z.string(),
              name: z.string(),
              logo: z.string().nullable(),
              event_count: z.number(),
              new_connector_slug: z.string(),
              connector: z.string().nullable().openapi({ description: 'Slug of the project connector for this app, or null.' }),
              connected: z.boolean().openapi({ description: 'The project has an active shared account for this app.' }),
              connectors: z.array(z.object({
                slug: z.string(),
                name: z.string(),
                accounts: z.array(z.object({
                  label: z.string().openapi({ description: 'Account label, unique per connector. The trigger `account` value.' }),
                  connected_as: z.string().nullable().openapi({ description: 'Identity the account was authorized as.' }),
                  is_default: z.boolean().openapi({ description: 'Used when a trigger names no account.' }),
                  connected: z.boolean().openapi({ description: 'Authorization finished.' }),
                })),
              })).openapi({ description: 'Every connector (profile) of this app with its shared accounts: project-owned, active, open to the whole project.' }),
            })),
          }),
          'Event-capable apps',
        ),
        ...errors(404),
      },
    }),
    async (c) => {
      const projectId = c.req.param('projectId');
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_TRIGGER_READ,
      );
      const apps = await listEventApps(projectId, loaded.row.accountId);
      return c.json({
        apps: apps.map((a) => ({
          source: a.provider,
          provider: a.provider,
          app: a.app,
          name: a.name,
          logo: a.logo,
          event_count: a.eventCount,
          new_connector_slug: a.newConnectorSlug,
          connector: a.connector,
          connected: a.connected,
          connectors: a.connectors.map((k) => ({
            slug: k.slug,
            name: k.name,
            accounts: k.accounts.map((x) => ({ label: x.label, connected_as: x.connectedAs, is_default: x.isDefault, connected: x.connected })),
          })),
        })),
      }, 200);
    },
  );

  // GET /v1/projects/:projectId/triggers/event-types?connector=<slug>
  //
  // ⚠️ Keep registered BEFORE the `…/triggers/{slug}` routes (see `activation` below).
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/triggers/event-types',
      tags: ['triggers'],
      summary: 'List the app events a connector can trigger on',
      ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        query: z.object({ connector: z.string().min(1).openapi({ description: 'Connector slug.' }) }),
      },
      responses: {
        200: json(
          z.object({
            source: z.string().openapi({ description: 'Event source adapter id, such as composio.' }),
            provider: z.string().openapi({ deprecated: true, description: 'Deprecated alias of `source`.' }),
            app: z.string(),
            event_types: z.array(z.object({
              type: z.string(),
              name: z.string(),
              description: z.string(),
              app: z.string(),
              delivery: z.enum(['poll', 'push']).nullable(),
              config_schema: z.record(z.string(), z.any()),
              payload_schema: z.record(z.string(), z.any()).nullable(),
            })),
          }),
          'Event types of the connector app',
        ),
        ...errors(400, 404, 409, 502),
      },
    }),
    async (c) => {
      const projectId = c.req.param('projectId');
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_TRIGGER_READ,
      );
      const slug = c.req.query('connector')?.trim();
      if (!slug) return c.json({ error: 'connector is required' }, 400);
      const catalog = await listConnectorEventTypes(projectId, slug);
      if (catalog.kind === 'connector_not_found') return c.json({ error: `Connector "${slug}" not found` }, 404);
      if (catalog.kind === 'unavailable') return c.json({ error: 'event_source_unavailable' }, 409);
      if (catalog.kind === 'provider_error') return c.json({ error: `Could not list events: ${catalog.message}` }, 502);
      return c.json({
        source: catalog.provider,
        provider: catalog.provider,
        app: catalog.app,
        event_types: catalog.items.map((t) => ({
          type: t.type,
          name: t.name,
          description: t.description,
          app: t.app,
          delivery: t.delivery,
          config_schema: t.configSchema,
          payload_schema: t.payloadSchema,
        })),
      }, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/triggers',
      tags: ['triggers'],
      summary: 'Create a project trigger (cron, webhook or event)',
      description:
        'Create a trigger. It is committed to kortix.yaml. Send name, type and prompt_template, plus cron, secret_env or run by type.',
      ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: lenientBody({
            name: z.string().openapi({ description: 'Trigger name. The slug derives from it.' }),
            type: z.enum(['cron', 'webhook', 'monitor', 'event']).openapi({ description: 'cron runs on a schedule, webhook runs on an HTTP call, monitor supervises a command, event runs when an app event happens on a connector.' }),
            prompt_template: z.string().openapi({ description: 'Prompt the agent receives on each fire. Webhook payload templates like {{ body.x }} are allowed.' }),
            slug: z.string().optional().openapi({ description: 'Explicit slug (a-z, 0-9, _, -). Defaults to a slug of name.' }),
            agent: z.string().optional().openapi({ description: 'Agent to run. Default "default".' }),
            model: z.string().optional().openapi({ description: 'Model as provider/model. Empty uses the default model.' }),
            enabled: z.boolean().optional().openapi({ description: 'Default true.' }),
            cron: z.string().optional().openapi({ description: 'Cron expression. Required for a cron trigger unless run_at is set.' }),
            run_at: z.string().optional().openapi({ description: 'ISO-8601 instant for a one-off cron trigger.' }),
            timezone: z.string().optional().openapi({ description: 'IANA timezone for cron. Default UTC.' }),
            secret_env: z.string().optional().openapi({ description: 'Project secret holding the webhook signing secret. Required for a webhook trigger.' }),
            connector: z.string().optional().openapi({ description: 'Connector slug the event happens on. Required for an event trigger.' }),
            event_account: z.string().nullish().openapi({ description: 'Label of one shared account of the connector. Omit or null for the connector default. Event triggers only.' }),
            event_source: z.string().nullish().openapi({ description: 'Event source adapter id, such as composio. Omit for the connector provider. Event triggers only.' }),
            event: z.string().optional().openapi({ description: 'The adapter event type id, such as GITHUB_PULL_REQUEST_EVENT. Required for an event trigger.' }),
            event_config: z.record(z.string(), z.any()).optional().openapi({ description: 'Provider event config. Event triggers only.' }),
            run: z.string().optional().openapi({ description: 'Repo-relative command a monitor supervises. Required for a monitor.' }),
            mode: z.enum(['poll', 'stream']).optional().openapi({ description: 'Monitor mode. Required for a monitor.' }),
            interval: z.string().optional().openapi({ description: 'Poll period such as 5m. Monitors with mode poll only.' }),
            expect_event_within: z.string().optional().openapi({ description: 'Silence watchdog such as 1h. Monitors only.' }),
            session_mode: z.enum(['fresh', 'reuse', 'pinned', 'keyed']).optional().openapi({ description: 'Whether each fire starts a new session, reuses one, pins one, or keys by session_key.' }),
            session_id: z.string().optional().openapi({ description: 'Session to pin when session_mode is pinned.' }),
            session_key: z.string().optional().openapi({ description: 'Template deriving one session per key when session_mode is keyed.' }),
            filter: z.record(z.string(), z.any()).optional().openapi({ description: 'Payload path to expected value; a delivery fires only if all match.' }),
            session_access: z.object({ mode: z.enum(['private', 'members', 'project']), memberIds: z.array(z.string()).optional(), groupIds: z.array(z.string()).optional() }).optional().optional().openapi({ description: 'Who can see the sessions this trigger creates. Default private.' }),
          }) } } },
      },
      responses: {
        201: json(TriggerListSchema, 'Every trigger after the create'),
        ...errors(400, 404, 409, 502),
      },
    }),
    async (c) => {
      const projectId = c.req.param('projectId');
      const body = await readJsonObject(c);
      const loaded = await loadProjectForUser(c, projectId, 'manage');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      // Specific IAM gate so the audit trail records the precise action.
      // assertProjectCapability (not bare assertAuthorized) so the acting token is
      // threaded and the agent-grant fold fires.
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE,
      );

      const draft = parseTriggerDraft(body, { existingSlug: null });
      if ('error' in draft) return c.json({ error: draft.error }, 400);
      if (draft.event) {
        const problem = await validateEventTrigger(projectId, draft.event);
        if (problem) return c.json({ error: problem }, 400);
      }
      if (draft.type === 'webhook' && draft.secretEnv) {
        const configurationError = await validateWebhookSecretConfiguration({
          projectId,
          secretEnv: draft.secretEnv,
        });
        if (configurationError) return c.json(configurationError, 409);
      }
      const parsedAccess =
        body.session_access === undefined
          ? { ok: true as const, access: PRIVATE_TRIGGER_SESSION_ACCESS }
          : parseTriggerSessionAccess(body.session_access);
      if (!parsedAccess.ok) return c.json({ error: parsedAccess.error }, 400);
      const accessValidationError = await validateTriggerSessionAccessPrincipals(
        loaded.row.accountId,
        parsedAccess.access,
      );
      if (accessValidationError) return c.json({ error: accessValidationError }, 400);

      // A `pinned` trigger may only target a session of THIS project that the
      // author may see — never a nonexistent, another project's, or another
      // member's private session. Every fire prompts that session.
      if (draft.sessionMode === 'pinned' && draft.pinnedSessionId) {
        const pinned = await guardSession(c, loaded, draft.pinnedSessionId, 'read');
        if (!pinned.ok) {
          return c.json(
            { error: `Pinned session "${draft.pinnedSessionId}" was not found in this project.` },
            400,
          );
        }
      }

      let committedManifest: ParsedManifest | undefined;
      const result = await mutateManifestWithRetry(
        loaded.row,
        `trigger ${draft.slug} was being created`,
        (manifest) => {
          if (extractTriggers(manifest).specs.some((s) => s.slug === draft.slug)) {
            return {
              ok: false,
              error: `A trigger with slug "${draft.slug}" already exists. Pick a different name.`,
              status: 409,
            };
          }
          const next = upsertTriggerInManifest(manifest, draftToSpec(draft, manifest.path));
          manifest.raw = next.raw;
          committedManifest = manifest;
          return { ok: true, commitMessage: `chore: add trigger ${draft.slug}` };
        },
      );
      if (!result.ok) {
        return c.json({ error: result.error }, result.status as 400 | 409 | 502);
      }
      if (!committedManifest) throw new Error('trigger create completed without a manifest');
      const createdSpecs = extractTriggers(committedManifest).specs;
      await reconcileProjectTriggerRuntime(projectId, createdSpecs);
      await reconcileEventSubscriptions(projectId, loaded.row.accountId, createdSpecs);
      await setTriggerSessionAccess({
        projectId,
        accountId: loaded.row.accountId,
        slug: draft.slug,
        access: parsedAccess.access,
        pinnedSessionId: draft.pinnedSessionId,
      });
      await followTrigger(c, loaded.row, projectId, draft.slug);

      return c.json(await loadTriggersForResponse(projectId, loaded.row), 201);
    },
  );

  // PATCH /:projectId/triggers/activation — server-side, per-project trigger
  // kill-switch. Body { paused: boolean }. When paused, the platform won't
  // auto-run any of this project's triggers (the cron sweep skips it, inbound
  // webhooks are ignored) regardless of each trigger's repo `enabled`. Use it to
  // stop ONE repo deployed to TWO control planes (e.g. dev + prod) from
  // double-firing every cron — pause the deployment you don't want firing. A
  // manual `…/triggers/:slug/fire` is explicit and still runs.
  //
  // ⚠️ ORDER MATTERS: this static route MUST stay registered BEFORE the
  // `…/triggers/{slug}` routes below. OpenAPIHono matches in registration order,
  // so when `…/triggers/{slug}` is declared first it captures `activation` as a
  // slug and this handler is shadowed — the PATCH 404s because no trigger is
  // named "activation", which silently breaks the whole pause kill-switch.
  // Covered by unit-trigger-activation-route.test.ts.
  projectsApp.openapi(
    createRoute({
      method: 'patch',
      path: '/{projectId}/triggers/activation',
      tags: ['triggers'],
      summary: "Pause or resume all of a project's triggers server-side",
      ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: lenientBody({
            paused: z.boolean().openapi({ description: 'true stops the platform from auto-running every trigger of the project.' }),
          }) } } },
      },
      responses: {
        200: json(TriggerListSchema, 'Every trigger after the switch'),
        ...errors(400, 401, 403, 404),
      },
    }),
    async (c) => {
      const projectId = c.req.param('projectId');
      const body = await readJsonObject(c);
      const loaded = await loadProjectForUser(c, projectId, 'manage');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE,
      );
      const paused = body.paused;
      if (typeof paused !== 'boolean') {
        return c.json({ error: 'paused must be a boolean' }, 400);
      }
      // FIX-J: SQL-side atomic merge of ONLY `triggers_paused` (set true / delete)
      // so this kill-switch write can't revert a routing pin written concurrently.
      const [row] = await db
        .update(projects)
        .set({
          metadata: paused
            ? metadataMerge({ triggers_paused: true })
            : metadataMerge({}, ['triggers_paused']),
          updatedAt: new Date(),
        })
        .where(eq(projects.projectId, projectId))
        .returning();
      if (!row || row.status === 'archived') return c.json({ error: 'Not found' }, 404);
      return c.json(await loadTriggersForResponse(projectId, row));
    },
  );

  // PATCH /v1/projects/:projectId/triggers/:slug

  projectsApp.openapi(
    createRoute({
      method: 'patch',
      path: '/{projectId}/triggers/{slug}',
      tags: ['triggers'],
      summary: 'Update a project trigger',
      description:
        'Update a trigger. Send only the fields to change.',
      ...auth,
      request: {
        params: z.object({ projectId: z.string(), slug: z.string() }),
        body: { content: { 'application/json': { schema: lenientBody({
            name: z.string().optional().openapi({ description: 'New name.' }),
            prompt_template: z.string().optional().openapi({ description: 'New prompt.' }),
            agent: z.string().optional().openapi({ description: 'Agent to run.' }),
            model: z.string().optional().openapi({ description: 'Model as provider/model.' }),
            enabled: z.boolean().optional().openapi({ description: 'Turn the trigger on or off.' }),
            cron: z.string().optional().openapi({ description: 'Cron expression.' }),
            run_at: z.string().optional().openapi({ description: 'ISO-8601 instant for a one-off trigger.' }),
            timezone: z.string().optional().openapi({ description: 'IANA timezone.' }),
            secret_env: z.string().optional().openapi({ description: 'Webhook signing secret name.' }),
            connector: z.string().optional().openapi({ description: 'Connector slug of an event trigger.' }),
            event_account: z.string().nullish().openapi({ description: 'Label of one shared account of the connector; null clears it to the connector default.' }),
            event_source: z.string().nullish().openapi({ description: 'Event source adapter id of an event trigger; null clears it to the connector provider.' }),
            event: z.string().optional().openapi({ description: 'The adapter event type id of an event trigger.' }),
            event_config: z.record(z.string(), z.any()).optional().openapi({ description: 'Provider event config of an event trigger.' }),
            session_mode: z.enum(['fresh', 'reuse', 'pinned', 'keyed']).optional().openapi({ description: 'Session reuse mode.' }),
            session_id: z.string().optional().openapi({ description: 'Session to pin.' }),
            session_key: z.string().optional().openapi({ description: 'Session key template.' }),
            filter: z.record(z.string(), z.any()).optional().openapi({ description: 'Payload filter.' }),
            session_access: z.object({ mode: z.enum(['private', 'members', 'project']), memberIds: z.array(z.string()).optional(), groupIds: z.array(z.string()).optional() }).optional().optional().openapi({ description: 'Who can see the sessions this trigger creates.' }),
          }) } } },
      },
      responses: {
        200: json(TriggerListSchema, 'Every trigger after the update'),
        ...errors(400, 404, 409, 502),
      },
    }),
    async (c) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const body = await readJsonObject(c);
      const loaded = await loadProjectForUser(c, projectId, 'manage');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE,
      );

      // Only commit the repo manifest when a manifest field actually changed; a
      // PATCH that touches none is a no-op that skips git entirely.
      const touchesManifest = TRIGGER_MANIFEST_KEYS.some((k) => k in body);
      const parsedAccess =
        body.session_access === undefined ? null : parseTriggerSessionAccess(body.session_access);
      if (parsedAccess && !parsedAccess.ok) return c.json({ error: parsedAccess.error }, 400);
      if (parsedAccess?.ok) {
        const accessValidationError = await validateTriggerSessionAccessPrincipals(
          loaded.row.accountId,
          parsedAccess.access,
        );
        if (accessValidationError) return c.json({ error: accessValidationError }, 400);
      }
      let committedManifest: ParsedManifest | undefined;
      let effectivePinnedSessionId: string | null = null;
      const result = await mutateManifestWithRetry(
        loaded.row,
        `trigger ${slug} was being updated`,
        async (manifest) => {
          const current = extractTriggers(manifest).specs.find((s) => s.slug === slug);
          if (!current) return { ok: false, error: 'Not found', status: 404 };
          if (!touchesManifest) {
            effectivePinnedSessionId = current.pinnedSessionId;
            return { ok: true, commitMessage: null };
          }

          // Merge the patch onto the current spec so callers can send partial bodies
          // (e.g. just `{ enabled: false }`). The parsed result becomes the new entry.
          const base = specToBody(current);
          // Setting a `session_key` is itself the opt-in to keyed sessions (see
          // parseTriggerDraft). The merge base always carries an explicit
          // `session_mode`, which would outvote a caller that sent ONLY a key — so
          // drop it and let the key decide. An explicit mode in the patch still wins.
          const patchesKey = 'session_key' in body || 'sessionKey' in body;
          const patchesMode = 'session_mode' in body || 'sessionMode' in body;
          if (patchesKey && !patchesMode) delete base.session_mode;
          // A type change starts from the shared fields only: the old type's wiring
          // (cron, secret, monitor command, event source) would fail the new type.
          if (typeof body.type === 'string' && body.type !== current.type) {
            for (const key of TYPE_SPECIFIC_BODY_KEYS) delete base[key];
          }
          // An account label belongs to one connector: naming another connector drops it.
          if ('connector' in body && !('event_account' in body)) delete base.event_account;
          if ('connector' in body && !('event_source' in body)) delete base.event_source;
          const draft = parseTriggerDraft({ ...base, ...body, slug: slug }, { existingSlug: slug });
          if ('error' in draft) return { ok: false, error: draft.error, status: 400 };
          if (draft.event && (body.type === 'event' || EVENT_BODY_KEYS.some((k) => k in body))) {
            const problem = await validateEventTrigger(projectId, draft.event);
            if (problem) return { ok: false, error: problem, status: 400 };
          }
          if (draft.type === 'webhook' && draft.secretEnv) {
            const configurationError = await validateWebhookSecretConfiguration({
              projectId,
              secretEnv: draft.secretEnv,
            });
            if (configurationError) {
              return { ok: false, status: 409, ...configurationError };
            }
          }
          effectivePinnedSessionId = draft.pinnedSessionId;

          // A `pinned` trigger may only target a session of THIS project that the
          // author may see.
          if (draft.sessionMode === 'pinned' && draft.pinnedSessionId) {
            const pinned = await guardSession(c, loaded, draft.pinnedSessionId, 'read');
            if (!pinned.ok) {
              return {
                ok: false,
                error: `Pinned session "${draft.pinnedSessionId}" was not found in this project.`,
                status: 400,
              };
            }
          }

          const next = upsertTriggerInManifest(manifest, draftToSpec(draft, manifest.path));
          manifest.raw = next.raw;
          committedManifest = manifest;
          return { ok: true, commitMessage: `chore: update trigger ${slug}` };
        },
      );
      if (!result.ok) {
        return c.json(
          {
            error: result.error,
            ...(result.code ? { code: result.code } : {}),
            ...(result.remediation ? { remediation: result.remediation } : {}),
          },
          result.status as 400 | 404 | 409 | 502,
        );
      }
      if (touchesManifest) {
        if (!committedManifest) throw new Error('trigger update completed without a manifest');
        const updatedSpecs = extractTriggers(committedManifest).specs;
        await reconcileProjectTriggerRuntime(projectId, updatedSpecs);
        await reconcileEventSubscriptions(projectId, loaded.row.accountId, updatedSpecs);
      }
      if (parsedAccess?.ok) {
        await setTriggerSessionAccess({
          projectId,
          accountId: loaded.row.accountId,
          slug,
          access: parsedAccess.access,
          pinnedSessionId: effectivePinnedSessionId,
        });
      }
      await followTrigger(c, loaded.row, projectId, slug);

      return c.json(await loadTriggersForResponse(projectId, loaded.row));
    },
  );

  // DELETE /v1/projects/:projectId/triggers/:slug

  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{projectId}/triggers/{slug}',
      tags: ['triggers'],
      summary: 'Delete a project trigger',
      ...auth,
      request: {
        params: z.object({ projectId: z.string(), slug: z.string() }),
      },
      responses: {
        200: json(OkSchema, 'Deleted'),
        ...errors(400, 404, 409, 502),
      },
    }),
    async (c) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const loaded = await loadProjectForUser(c, projectId, 'manage');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_TRIGGER_DELETE,
      );

      if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug)) {
        return c.json({ error: 'Invalid slug' }, 400);
      }

      let remainingManifest: ParsedManifest | undefined;
      const result = await mutateManifestWithRetry(
        loaded.row,
        `trigger ${slug} was being deleted`,
        (manifest) => {
          if (!extractTriggers(manifest).specs.some((s) => s.slug === slug)) {
            return { ok: false, error: 'Not found', status: 404 };
          }
          const next = removeTriggerFromManifest(manifest, slug);
          manifest.raw = next.raw;
          remainingManifest = manifest;
          return { ok: true, commitMessage: `chore: delete trigger ${slug}` };
        },
      );
      if (!result.ok) {
        return c.json({ error: result.error }, result.status as 400 | 404 | 409 | 502);
      }

      // Drop runtime state too — a re-created trigger of the same slug should
      // start with a clean last_fired_at.
      await db
        .delete(projectTriggerRuntime)
        .where(
          and(eq(projectTriggerRuntime.projectId, projectId), eq(projectTriggerRuntime.slug, slug)),
        );
      await deleteTriggerWatchers({ projectId, slug }).catch((err) =>
        logger.warn('[trigger-watchers] cleanup failed', { projectId, slug, error: err instanceof Error ? err.message : String(err) }));
      if (remainingManifest) {
        await reconcileEventSubscriptions(projectId, loaded.row.accountId, extractTriggers(remainingManifest).specs);
      }

      return c.json({ ok: true as const });
    },
  );

  // POST /v1/projects/:projectId/triggers/:slug/fire
  //
  // Manual fire for git-backed triggers. Reads the file, renders the prompt
  // against a synthetic payload, spawns a session. Manage role required.

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/triggers/{slug}/fire',
      tags: ['triggers'],
      summary: 'Fire a project trigger now',
      ...auth,
      request: {
        params: z.object({ projectId: z.string(), slug: z.string() }),
      },
      responses: {
        202: json(TriggerFireResultSchema, 'Queued or fired'),
        ...errors(404, 500),
      },
    }),
    async (c) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      // Floor 'read' (membership); project.trigger.fire is the real gate. The floor
      // was 'manage' (= project.write) — which the floor `member` role LACKS even
      // though it HOLDS trigger.fire, so a plain member could never fire a trigger
      // (its designed fire grant was dead behind the floor). Now member/
      // manager all fire (all hold the leaf); a custom role without it is denied.
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE,
      );

      const gitProject = await withProjectGitAuth(loaded.row);
      const spec = await findProjectTriggerBySlug(gitProject, slug);
      if (!spec) return c.json({ error: 'Not found' }, 404);
      // Agents as principals (spec 2026-09-22 §2.2, closes V2): the fired run
      // acts as the trigger's agent, so the FIRER must be allowed to run that
      // agent. `default` is resolved exactly as session creation resolves it
      // (KRTX-1720): the manifest's default first; the metadata mirror, which
      // can lag a git push, only for a v1 manifest that declares none.
      // Asking about the mirror instead refused a member allowed to run the
      // real default, and admitted one allowed to run only the stale name.
      const mirroredDefault = (loaded.row.metadata as Record<string, unknown> | null)?.default_agent;
      const firedAgent =
        spec.agent === 'default'
          ? resolveSessionAgentName({
              requestedAgent: null,
              manifestDefaultAgent:
                (await loadProjectAgents(gitProject, { forceRefresh: 'tip-proof' })).defaultAgent?.trim() || null,
              mirroredDefaultAgent:
                typeof mirroredDefault === 'string' && mirroredDefault.trim() ? mirroredDefault.trim() : null,
            })
          : spec.agent;
      await assertMayRunAgent(
        c,
        loaded.row.accountId,
        projectId,
        firedAgent,
        PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE,
      );

      const now = new Date();
      // An event trigger fires with an empty event, so the user can test the prompt.
      const eventConnector = spec.event ? await connectorInfo(projectId, spec.event.connector) : null;
      const eventRoot = spec.event && eventConnector
        ? eventPayload({
            spec,
            ...eventConnector,
            eventId: `manual-${crypto.randomUUID()}`,
            type: spec.event.type,
            occurredAt: now.toISOString(),
            data: {},
            firedAt: now,
          })
        : {};
      const payload = {
        trigger: { slug: spec.slug, type: spec.type, kind: 'git' },
        fired_at: now.toISOString(),
        ...eventRoot,
        source: 'manual',
        actor: loaded.userId,
        message: { text: '', source: 'manual_test' },
      };
      const renderedPrompt = renderPromptTemplate(spec.promptTemplate, payload);

      const result = await fireGitTrigger({
        spec,
        project: loaded.row,
        payload,
        renderedPrompt,
        source: 'manual',
        request: requestAuditContext(c),
      });

      if (result.status === 'queued') {
        // Not run yet: its delivery ends an alert streak, not this handoff (KRTX-1742).
        await markGitTriggerFired(projectId, slug, now, 'fired', { endsAlert: false });
        return c.json(
          {
            status: 'queued' as const,
            command_id: result.commandId ?? null,
            session_id: result.sessionId ?? null,
            reason: result.reason ?? null,
            deduped: result.deduped ?? false,
          },
          202,
        );
      }
      if (result.status === 'failed') {
        const error = result.error ?? 'Failed to fire trigger';
        // Recorded like a failed cron fire, so the trigger says it failed (KRTX-1743).
        await markGitTriggerAttemptFailed(projectId, slug, now, error).catch(() => {});
        // The first failure of a streak alerts the watchers, not only the firer
        // (KRTX-1742). A create that went back to the queue alerts from the
        // drain only if it dead-letters.
        if (!result.requeued) {
          await raiseTriggerAlert({ projectId, accountId: loaded.row.accountId, slug, source: 'fire', error });
        }
        return c.json({ error }, 500);
      }
      await markGitTriggerFired(projectId, slug, now);
      return c.json(
        {
          status: result.deduped ? ('deduped' as const) : ('fired' as const),
          command_id: result.commandId ?? null,
          session_id: result.sessionId ?? null,
          deduped: result.deduped ?? false,
        },
        202,
      );
    },
  );
}
