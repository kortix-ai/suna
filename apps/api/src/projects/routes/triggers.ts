/** Project triggers: list, create, update, activate, delete, and manual fire. */
import { createRoute, z } from '@hono/zod-openapi';
import { projectTriggerRuntime, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { mutateManifestWithRetry } from '../../connectors/manifest-mutation';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { assertMayRunAgent } from '../lib/agent-access';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { AnyObject, TriggerSchema, projectsApp } from '../lib/app';
import { guardSession } from '../lib/session-access';
import { withProjectGitAuth } from '../lib/git';
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
import { validateWebhookSecretConfiguration } from '../lib/webhook-secret-policy';
import { reconcileProjectTriggerRuntime } from '../trigger-runtime-catalog';
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
] as const;

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
    summary: 'GET /:projectId/triggers',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(z.array(TriggerSchema), 'Triggers'),
      ...errors(404),
    },
  }),
  async (c: any) => {
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

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/triggers',
    tags: ['triggers'],
    summary: 'POST /:projectId/triggers',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      201: json(TriggerSchema, 'The created trigger'),
      ...errors(400, 404, 409, 502),
    },
  }),
  async (c: any) => {
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
    await reconcileProjectTriggerRuntime(projectId, extractTriggers(committedManifest).specs);
    await setTriggerSessionAccess({
      projectId,
      accountId: loaded.row.accountId,
      slug: draft.slug,
      access: parsedAccess.access,
      pinnedSessionId: draft.pinnedSessionId,
    });

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
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(AnyObject, 'Updated triggers (includes triggers_paused)'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
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
    summary: 'PATCH /:projectId/triggers/:slug',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), slug: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(400, 404, 409, 502),
    },
  }),
  async (c: any) => {
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
        const draft = parseTriggerDraft({ ...base, ...body, slug: slug }, { existingSlug: slug });
        if ('error' in draft) return { ok: false, error: draft.error, status: 400 };
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
      await reconcileProjectTriggerRuntime(projectId, extractTriggers(committedManifest).specs);
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

    return c.json(await loadTriggersForResponse(projectId, loaded.row));
  },
);

// DELETE /v1/projects/:projectId/triggers/:slug

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/triggers/{slug}',
    tags: ['triggers'],
    summary: 'DELETE /:projectId/triggers/:slug',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), slug: z.string() }),
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(400, 404, 409, 502),
    },
  }),
  async (c: any) => {
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

    const result = await mutateManifestWithRetry(
      loaded.row,
      `trigger ${slug} was being deleted`,
      (manifest) => {
        if (!extractTriggers(manifest).specs.some((s) => s.slug === slug)) {
          return { ok: false, error: 'Not found', status: 404 };
        }
        const next = removeTriggerFromManifest(manifest, slug);
        manifest.raw = next.raw;
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

    return c.json({ ok: true });
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
    summary: 'POST /:projectId/triggers/:slug/fire',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), slug: z.string() }),
    },
    responses: {
      202: json(z.any(), 'OK'),
      ...errors(404, 500),
    },
  }),
  async (c: any) => {
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

    const spec = await findProjectTriggerBySlug(await withProjectGitAuth(loaded.row), slug);
    if (!spec) return c.json({ error: 'Not found' }, 404);
    // Agents as principals (spec 2026-09-22 §2.2, closes V2): the fired run
    // acts as the trigger's agent, so the FIRER must be allowed to run that
    // agent. Under the legacy model (flag off) the fire keeps today's gate.
    if (resolveFeatureFlag(loaded.row.metadata, 'agent_principal')) {
      // `default` selects the project's default agent; ask about that agent.
      const mirroredDefault = (loaded.row.metadata as Record<string, unknown> | null)?.default_agent;
      const firedAgent =
        spec.agent === 'default' && typeof mirroredDefault === 'string' && mirroredDefault.trim()
          ? mirroredDefault.trim()
          : spec.agent;
      await assertMayRunAgent(
        c,
        loaded.row.accountId,
        projectId,
        firedAgent,
        PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE,
      );
    }

    const now = new Date();
    const payload = {
      trigger: { slug: spec.slug, type: spec.type, kind: 'git' },
      fired_at: now.toISOString(),
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
      await markGitTriggerFired(projectId, slug, now);
      return c.json(
        {
          status: 'queued',
          command_id: result.commandId ?? null,
          session_id: result.sessionId ?? null,
          reason: result.reason ?? null,
          deduped: result.deduped ?? false,
        },
        202,
      );
    }
    if (result.status === 'failed') {
      return c.json({ error: result.error ?? 'Failed to fire trigger' }, 500);
    }
    await markGitTriggerFired(projectId, slug, now);
    return c.json(
      {
        status: result.deduped ? 'deduped' : 'fired',
        command_id: result.commandId ?? null,
        session_id: result.sessionId ?? null,
        deduped: result.deduped ?? false,
      },
      202,
    );
  },
);
