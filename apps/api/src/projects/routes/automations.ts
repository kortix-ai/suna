/**
 * Automations (`lib/automations.ts`): one list and one create for triggers and
 * loops.
 *
 *   GET    /v1/projects/:projectId/automations            kortix.yaml + runtime, each marked `origin`
 *   POST   /v1/projects/:projectId/automations            create a runtime automation (source + target)
 *   PATCH  /v1/projects/:projectId/automations/:id        pause/resume a runtime automation
 *   DELETE /v1/projects/:projectId/automations/:id        delete a runtime automation
 *   POST   /v1/projects/:projectId/automations/:id/run    fire a runtime automation once now
 *
 * A kortix.yaml automation is changed through `/triggers/:slug` (a commit), a
 * runtime one here. A session-target automation takes the loop gates
 * (`routes/session-reminders.ts`): who may prompt that session decides. An
 * agent-target one takes the trigger gates (`project.trigger.*`).
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { PROJECT_ACTIONS } from '../../iam';
import { logger } from '../../lib/logger';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { getRequestOnBehalfOf } from '../../middleware/on-behalf-of';
import { notificationsEnabled } from '../../notifications/enabled';
import { auth, errors, json, lenientBody } from '../../openapi';
import { readJsonObject } from '../../shared/http-body';
import type { AppEnv } from '../../types';
import { getCrById } from '../change-requests';
import { validateEventTrigger } from '../trigger-events/catalog';
import { reconcileEventSubscriptionsFromCatalog } from '../trigger-events/subscriptions';
import { recordTriggerRun, triggerRunFromFire } from '../trigger-execution-store';
import { initialTriggerScheduleSlot } from '../trigger-schedule';
import type { GitTriggerSpec } from '../triggers';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { resolveAndAuthorizeAgent } from '../lib/agent-access';
import { projectsApp } from '../lib/app';
import {
  automationTargetOf,
  deleteRuntimeAutomation,
  insertRuntimeAgentAutomation,
  listRuntimeAgentAutomations,
  loadRuntimeAutomation,
  newAutomationId,
  parseRuntimeAutomationBody,
  runtimeAutomationSpec,
  serializeDeclaredAutomation,
  serializeRuntimeAutomation,
} from '../lib/automations';
import { assertMayRunAgent } from '../lib/http-agent-access';
import { setSessionReminderEnabled } from '../lib/session-reminders';
import { loadTriggersForResponse, validateAppTriggerTarget } from '../lib/trigger-draft';
import { fireGitTrigger, markGitTriggerFired } from '../lib/trigger-fire';
import { deleteTriggerWatchers, triggerWatcherOf, upsertTriggerWatcher } from '../lib/trigger-watchers';
import { validateWebhookSecretConfiguration } from '../lib/webhook-secret-policy';
import {
  authorizeReminderSession,
  createSessionAutomation,
  deleteReminderResponse,
  listVisibleProjectReminders,
  runReminderResponse,
  setReminderEnabledResponse,
} from './session-reminders';

const AutomationSchema = z.record(z.string(), z.any());
const idParams = z.object({ projectId: z.string(), id: z.string() });

/** True when the caller holds `action` on the project; a 403 reads as false, anything else throws. */
async function holds(c: Context<AppEnv>, loaded: NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>, action: string): Promise<boolean> {
  try {
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, loaded.row.projectId, action);
    return true;
  } catch (error) {
    if (error instanceof HTTPException && error.status === 403) return false;
    throw error;
  }
}

/** The source checks `POST /triggers` makes, for a runtime spec. Null when it may be stored. */
async function sourceProblem(c: Context<AppEnv>, projectId: string, metadata: unknown, spec: GitTriggerSpec) {
  if (spec.type === 'event') {
    const disabled = requireFeatureFlag(c, metadata, 'event_triggers');
    if (disabled) return disabled;
    const problem = spec.event ? await validateEventTrigger(projectId, spec.event) : 'event is required';
    if (problem) return c.json({ error: problem }, 400);
  }
  if (spec.type === 'app' && spec.app) {
    const problem = await validateAppTriggerTarget(projectId, spec.app);
    if (problem) return c.json({ error: problem }, 400);
  }
  if (spec.type === 'webhook' && spec.secretEnv) {
    const problem = await validateWebhookSecretConfiguration({ projectId, secretEnv: spec.secretEnv });
    if (problem) return c.json(problem, 409);
  }
  if (spec.type === 'change_request' && spec.changeRequest?.crId) {
    const cr = await getCrById(spec.changeRequest.crId, projectId);
    if (!cr) return c.json({ error: `Change request "${spec.changeRequest.crId}" was not found in this project.` }, 400);
    // Store the canonical id: a `#12` or `12` the caller sent must match the merge's cr_id.
    spec.changeRequest = { ...spec.changeRequest, crId: cr.crId };
  }
  return null;
}

/** Follow an agent-target automation's alerts, as a trigger's creator does (KRTX-1742). Best-effort. */
async function followAutomation(c: Context<AppEnv>, project: { accountId: string; metadata: unknown }, projectId: string, slug: string) {
  if (!notificationsEnabled(project.metadata)) return;
  const userId = triggerWatcherOf({
    authType: c.get('authType'),
    userId: c.get('userId'),
    sessionId: c.get('sessionId'),
    onBehalfOfUserId: getRequestOnBehalfOf(c),
  });
  if (!userId) return;
  await upsertTriggerWatcher({ accountId: project.accountId, projectId, slug, userId }).catch((err) =>
    logger.warn('[trigger-watchers] automation follow failed', { projectId, slug, error: err instanceof Error ? err.message : String(err) }));
}

const NOT_RUNTIME = 'Automation not found. A kortix.yaml automation changes through /triggers/{slug}.';

/** The runtime row `:id` names, and whether it targets a session. */
async function loadTarget(c: Context<AppEnv>) {
  const projectId = c.req.param('projectId') ?? '';
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return { response: c.json({ error: 'Not found' }, 404) } as const;
  const row = await loadRuntimeAutomation(projectId, c.req.param('id') ?? '');
  if (!row) return { response: c.json({ error: NOT_RUNTIME }, 404) } as const;
  const spec = row.scheduleSpec as unknown as GitTriggerSpec;
  return { response: null, projectId, loaded, row, spec } as const;
}

export function registerAutomationsRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/automations',
      tags: ['triggers'],
      summary: 'List the automations of a project',
      description:
        'kortix.yaml triggers (`origin: declared`) and runtime automations: loops and rows created through POST /automations (`origin: runtime`). Each row has a `source` and a `target`. Rows the caller may not read are left out: declared and agent-target rows need project.trigger.read, session-target rows a session the caller can open.',
      ...auth,
      request: { params: z.object({ projectId: z.string() }) },
      responses: {
        200: json(
          z.object({
            automations: z.array(AutomationSchema),
            triggers_paused: z.boolean(),
            account_automations_paused: z.boolean(),
            errors: z.array(z.any()),
          }),
          'Every automation the caller can see',
        ),
        ...errors(404),
      },
    }),
    async (c) => {
      const projectId = c.req.param('projectId');
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      const declared = (await holds(c, loaded, PROJECT_ACTIONS.PROJECT_TRIGGER_READ))
        ? await loadTriggersForResponse(projectId, loaded.row, { userId: loaded.userId, bound: callerKortixSessionId(c) })
        : null;
      const agentRows = declared ? await listRuntimeAgentAutomations(projectId) : [];
      const loops =
        resolveFeatureFlag(loaded.row.metadata, 'reminders') && (await holds(c, loaded, PROJECT_ACTIONS.PROJECT_SESSION_READ))
          ? await listVisibleProjectReminders(c, loaded)
          : { rows: [], names: new Map<string, string | null>() };
      return c.json(
        {
          automations: [
            ...(declared?.triggers ?? []).map((trigger) => serializeDeclaredAutomation(projectId, trigger)),
            ...agentRows.map((row) => serializeRuntimeAutomation(row)),
            ...loops.rows.map((row) => serializeRuntimeAutomation(row, loops.names.get(row.sessionId as string))),
          ],
          triggers_paused: declared?.triggers_paused ?? false,
          account_automations_paused: declared?.account_automations_paused ?? false,
          errors: declared?.errors ?? [],
        },
        200,
      );
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/automations',
      tags: ['triggers'],
      summary: 'Create a runtime automation',
      description:
        'Stored in the database, not kortix.yaml: no commit. `target.session_id` wakes that session on every fire (a loop); `target.agent` starts a new session of that agent. A schedule into a session keeps the loop rules (every at least 5m, at/in for a first fire).',
      ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: lenientBody({
          prompt: z.string().openapi({ description: 'Prompt each fire sends. `{{ body.x }}`, `{{ change_request.number }}` render against the payload.' }),
          name: z.string().optional().openapi({ description: 'Label.' }),
          source: z.record(z.string(), z.any()).openapi({
            description:
              '{ type: "schedule", every | cron | at | in, timezone? } · { type: "webhook", secret_env } · { type: "event", connector, event, config?, account? } · { type: "app", app } · { type: "change_request", cr_id?, base? }',
          }),
          target: z.record(z.string(), z.any()).openapi({ description: '{ session_id } wakes that session; { agent } starts a new session of that agent.' }),
        }) } } },
      },
      responses: {
        201: json(AutomationSchema, 'The created automation'),
        ...errors(400, 403, 404, 409),
      },
    }),
    async (c) => {
      const body = await readJsonObject(c);
      const projectId = c.req.param('projectId');
      const now = new Date();
      const parsed = parseRuntimeAutomationBody(body, now);
      if ('error' in parsed) return c.json({ error: parsed.error }, 400);
      const id = newAutomationId();

      if (parsed.target.kind === 'session') {
        const access = await authorizeReminderSession(c, parsed.target.session_id);
        if (access.response) return access.response;
        const { loaded, visible, agentCaller } = access;
        // Each fire prompts the session's own agent: the caller must be allowed to run it now.
        await resolveAndAuthorizeAgent(c, loaded, projectId, null, visible.row.agentName, undefined, visible.row.spaceId);
        const spec = runtimeAutomationSpec({
          id, body: parsed, agent: visible.row.agentName ?? 'default', now,
          // A person's automation is their deferred prompt: the fire acts as them.
          promptAuthorUserId: agentCaller ? null : loaded.userId,
        });
        if ('error' in spec) return c.json({ error: spec.error }, 400);
        const problem = await sourceProblem(c, projectId, loaded.row.metadata, spec);
        if (problem) return problem;
        const firstFireAt = parsed.reminderDraft?.firstFireAt ?? initialTriggerScheduleSlot(spec, now);
        const created = await createSessionAutomation(c, access, spec, firstFireAt, now);
        if (!('row' in created)) return created;
        if (spec.type === 'event') await reconcileEventSubscriptionsFromCatalog(projectId, loaded.row.accountId);
        return c.json(serializeRuntimeAutomation(created.row), 201);
      }

      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE);
      // ponytail: `default` resolves at fire time, as for a kortix.yaml trigger; a named agent is checked now.
      if (parsed.target.agent !== 'default') {
        await assertMayRunAgent(c, loaded.row.accountId, projectId, parsed.target.agent, PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE);
      }
      const spec = runtimeAutomationSpec({ id, body: parsed, agent: parsed.target.agent, now });
      if ('error' in spec) return c.json({ error: spec.error }, 400);
      const problem = await sourceProblem(c, projectId, loaded.row.metadata, spec);
      if (problem) return problem;
      const row = await insertRuntimeAgentAutomation({
        projectId,
        spec,
        createdBy: loaded.userId,
        // Jittered like a kortix.yaml cron (trigger-runtime-catalog.ts): the claim re-arms with the same key.
        firstFireAt: initialTriggerScheduleSlot(spec, now, { jitterKey: `${projectId}:${spec.slug}` }),
        now,
      });
      await followAutomation(c, loaded.row, projectId, spec.slug);
      if (spec.type === 'event') await reconcileEventSubscriptionsFromCatalog(projectId, loaded.row.accountId);
      return c.json(serializeRuntimeAutomation(row), 201);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'patch',
      path: '/{projectId}/automations/{id}',
      tags: ['triggers'],
      summary: 'Pause or resume a runtime automation',
      ...auth,
      request: {
        params: idParams,
        body: { content: { 'application/json': { schema: lenientBody({
          enabled: z.boolean().openapi({ description: 'true resumes it; false pauses it.' }),
        }) } } },
      },
      responses: {
        200: json(AutomationSchema, 'The updated automation'),
        ...errors(400, 403, 404, 409),
      },
    }),
    async (c) => {
      const body = await readJsonObject(c);
      if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled (boolean) is required' }, 400);
      const target = await loadTarget(c);
      if (target.response) return target.response;
      const { projectId, loaded, row, spec } = target;
      if (automationTargetOf(spec).kind === 'session') {
        const access = await authorizeReminderSession(c, row.sessionId ?? '');
        if (access.response) return access.response;
        return setReminderEnabledResponse(c, access, row.slug, body.enabled);
      }
      await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE);
      const updated = await setSessionReminderEnabled(row, body.enabled, new Date());
      if (spec.type === 'event') await reconcileEventSubscriptionsFromCatalog(projectId, loaded.row.accountId);
      return c.json(serializeRuntimeAutomation(updated), 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{projectId}/automations/{id}',
      tags: ['triggers'],
      summary: 'Delete a runtime automation',
      ...auth,
      request: { params: idParams },
      responses: {
        200: json(z.object({ ok: z.boolean() }), 'Deleted'),
        ...errors(400, 403, 404, 409),
      },
    }),
    async (c) => {
      const target = await loadTarget(c);
      if (target.response) return target.response;
      const { projectId, loaded, row, spec } = target;
      if (automationTargetOf(spec).kind === 'session') {
        const access = await authorizeReminderSession(c, row.sessionId ?? '');
        if (access.response) return access.response;
        return deleteReminderResponse(c, access, row.slug);
      }
      await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_TRIGGER_DELETE);
      await deleteRuntimeAutomation(projectId, row.slug);
      await deleteTriggerWatchers({ projectId, slug: row.slug }).catch(() => {});
      if (spec.type === 'event') await reconcileEventSubscriptionsFromCatalog(projectId, loaded.row.accountId);
      return c.json({ ok: true }, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/automations/{id}/run',
      tags: ['triggers'],
      summary: 'Run a runtime automation now',
      description: 'One fire with an empty payload. The schedule does not move.',
      ...auth,
      request: { params: idParams },
      responses: {
        202: json(AutomationSchema, 'The automation after the fire'),
        ...errors(400, 403, 404, 409),
      },
    }),
    async (c) => {
      const target = await loadTarget(c);
      if (target.response) return target.response;
      const { projectId, loaded, row, spec } = target;
      if (automationTargetOf(spec).kind === 'session') {
        const access = await authorizeReminderSession(c, row.sessionId ?? '');
        if (access.response) return access.response;
        return runReminderResponse(c, access, row.slug);
      }
      await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE);
      if (spec.agent !== 'default') {
        await assertMayRunAgent(c, loaded.row.accountId, projectId, spec.agent, PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE);
      }
      const now = new Date();
      const payload = { trigger: { slug: spec.slug, type: spec.type, kind: 'runtime' }, fired_at: now.toISOString() };
      const result = await fireGitTrigger({ spec, project: loaded.row, payload, renderedPrompt: spec.promptTemplate, source: 'manual', deliberate: true });
      await recordTriggerRun({ projectId, slug: spec.slug, source: 'manual', spec, payload, ...triggerRunFromFire(result), now });
      if (result.status !== 'queued' && result.status !== 'fired') {
        return c.json({ error: result.error ?? result.reason ?? 'The automation could not run' }, 409);
      }
      await markGitTriggerFired(projectId, spec.slug, now, 'fired', { endsAlert: result.status === 'fired' });
      const updated = await loadRuntimeAutomation(projectId, spec.slug);
      return c.json({ ...serializeRuntimeAutomation(updated ?? row), started_session_id: result.sessionId ?? null }, 202);
    },
  );
}
