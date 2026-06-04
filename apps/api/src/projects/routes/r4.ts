import { deleteSlackInstall, loadSlackInstall, saveSlackInstall } from '../../channels/install-store';
import { buildSlackInstallUrl } from '../../channels/slack-oauth';
import { slackOauthMode } from '../../channels/slack-oauth-mode';
import { postQuestionAndWait, relayTurnAnswer, relayTurnStep, type QuestionInfo } from '../../channels/slack-webhook';
import { PROJECT_ACTIONS, assertAuthorized } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { extractApps } from '../apps';
import { extractTriggers, loadProjectTriggers, type ParsedManifest } from '../triggers';
import { createRoute, z } from '@hono/zod-openapi';
import { projectTriggerRuntime, sessionSandboxes } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import { loadProjectForUser } from '../lib/access';
import { AnyObject, AppSchema, TriggerSchema, projectsApp } from '../lib/app';
import { APPS_DISABLED_BODY, SlackAuthTest, draftToAppSpec, loadAppsForResponse, parseAppDraft, projectAppsEnabled, removeAppFromManifest, specToAppBody, upsertAppInManifest } from '../lib/apps-helpers';
import { withProjectGitAuth } from '../lib/git';
import { readBody, requestAuditContext } from '../lib/serializers';
import { commitManifest, draftToSpec, fireGitTrigger, loadManifestForEdit, loadTriggersForResponse, markGitTriggerFired, parseTriggerDraft, removeTriggerFromManifest, renderPromptTemplate, specToBody, upsertTriggerInManifest } from '../lib/triggers';

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
        ...errors(400, 404, 409),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Specific IAM gate so the audit trail records the precise action.
  await assertAuthorized(loaded.userId, loaded.row.accountId, PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE, { type: 'project', id: projectId });

  const draft = parseTriggerDraft(body, { existingSlug: null });
  if ('error' in draft) return c.json({ error: draft.error }, 400);

  let manifest: ParsedManifest;
  try {
    manifest = await loadManifestForEdit(loaded.row);
  } catch (err) {
    return c.json({ error: (err as Error).message || 'Failed to read manifest' }, 400);
  }

  if (extractTriggers(manifest).specs.some((s) => s.slug === draft.slug)) {
    return c.json({
      error: `A trigger with slug "${draft.slug}" already exists. Pick a different name.`,
    }, 409);
  }

  const next = upsertTriggerInManifest(manifest, draftToSpec(draft));
  const result = await commitManifest(loaded.row, next, `chore: add trigger ${draft.slug}`);
  if ('error' in result) {
    return c.json({ error: result.error }, result.status as 400 | 502);
  }

  return c.json(await loadTriggersForResponse(projectId, loaded.row), 201);
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
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const slug = c.req.param('slug');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertAuthorized(loaded.userId, loaded.row.accountId, PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE, { type: 'project', id: projectId });

  let manifest: ParsedManifest;
  try {
    manifest = await loadManifestForEdit(loaded.row);
  } catch (err) {
    return c.json({ error: (err as Error).message || 'Failed to read manifest' }, 400);
  }
  const current = extractTriggers(manifest).specs.find((s) => s.slug === slug);
  if (!current) return c.json({ error: 'Not found' }, 404);

  // Merge the patch onto the current spec so callers can send partial bodies
  // (e.g. just `{ enabled: false }`). The parsed result becomes the new entry.
  const draft = parseTriggerDraft(
    { ...specToBody(current), ...body, slug: slug },
    { existingSlug: slug },
  );
  if ('error' in draft) return c.json({ error: draft.error }, 400);

  const next = upsertTriggerInManifest(manifest, draftToSpec(draft));
  const result = await commitManifest(loaded.row, next, `chore: update trigger ${slug}`);
  if ('error' in result) {
    return c.json({ error: result.error }, result.status as 400 | 502);
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
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const slug = c.req.param('slug');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertAuthorized(loaded.userId, loaded.row.accountId, PROJECT_ACTIONS.PROJECT_TRIGGER_DELETE, { type: 'project', id: projectId });

  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug)) {
    return c.json({ error: 'Invalid slug' }, 400);
  }

  let manifest: ParsedManifest;
  try {
    manifest = await loadManifestForEdit(loaded.row);
  } catch (err) {
    return c.json({ error: (err as Error).message || 'Failed to read manifest' }, 400);
  }
  if (!extractTriggers(manifest).specs.some((s) => s.slug === slug)) {
    return c.json({ error: 'Not found' }, 404);
  }

  const next = removeTriggerFromManifest(manifest, slug);
  const result = await commitManifest(loaded.row, next, `chore: delete trigger ${slug}`);
  if ('error' in result) {
    return c.json({ error: result.error }, result.status as 400 | 502);
  }

  // Drop runtime state too — a re-created trigger of the same slug should
  // start with a clean last_fired_at.
  await db
    .delete(projectTriggerRuntime)
    .where(and(
      eq(projectTriggerRuntime.projectId, projectId),
      eq(projectTriggerRuntime.slug, slug),
    ));

  return c.json({ ok: true });
},
);

// ─── Slack install — per project, secrets live in project_secrets ────────


projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/channels/slack/installation',
    tags: ['channels'],
    summary: 'GET /:projectId/channels/slack/installation',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const install = await loadSlackInstall(projectId);
  return c.json(install ?? null);
},
);

// GET /v1/projects/:projectId/channels/slack/mode
// Tells the dashboard whether one-click "Add to Slack" is available (server
// has SLACK_CLIENT_ID + SECRET + SIGNING_SECRET set) and the pre-signed
// install URL to redirect the user to.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/channels/slack/mode',
    tags: ['channels'],
    summary: 'GET /:projectId/channels/slack/mode',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const mode = slackOauthMode();
  if (!mode.available) {
    return c.json({ oauth_available: false, install_url: null });
  }
  try {
    const installUrl = buildSlackInstallUrl(projectId, loaded.userId);
    return c.json({ oauth_available: true, install_url: installUrl });
  } catch {
    return c.json({ oauth_available: false, install_url: null });
  }
},
);

// POST /v1/projects/:projectId/channels/slack/connect

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/channels/slack/connect',
    tags: ['channels'],
    summary: 'POST /:projectId/channels/slack/connect',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404, 502),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  let body: { bot_token?: string; signing_secret?: string };
  try {
    body = (await c.req.json()) as { bot_token?: string; signing_secret?: string };
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const botToken = body.bot_token?.trim();
  const signingSecret = body.signing_secret?.trim();
  if (!botToken || !botToken.startsWith('xoxb-')) {
    return c.json({ error: 'bot_token is required and must start with xoxb-' }, 400);
  }
  if (!signingSecret) {
    return c.json({ error: 'signing_secret is required' }, 400);
  }

  let authTest: SlackAuthTest;
  try {
    const res = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${botToken}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
    });
    authTest = (await res.json()) as SlackAuthTest;
  } catch (err) {
    return c.json({ error: `Failed to reach Slack: ${(err as Error).message}` }, 502);
  }
  if (!authTest.ok || !authTest.team_id || !authTest.user_id) {
    return c.json({ error: `Slack rejected the token: ${authTest.error ?? 'unknown error'}` }, 400);
  }

  const summary = await saveSlackInstall({
    projectId,
    botToken,
    signingSecret,
    teamId: authTest.team_id,
    teamName: authTest.team ?? null,
    botUserId: authTest.user_id,
  });
  return c.json(summary);
},
);

// DELETE /v1/projects/:projectId/channels/slack/installation

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/channels/slack/installation',
    tags: ['channels'],
    summary: 'DELETE /:projectId/channels/slack/installation',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await deleteSlackInstall(projectId);
  return c.json({ status: 'disconnected' });
},
);

// POST /v1/projects/:projectId/turn-stream
// Agent-cli relay for the live Slack plan: kind=step appends a checkpoint,
// kind=answer finalizes the turn's streamed message with the agent's reply.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/turn-stream',
    tags: ['projects'],
    summary: 'POST /:projectId/turn-stream',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: { description: 'Event stream', content: { 'text/event-stream': { schema: z.any() } } },
        ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');

  // Two valid callers: a project-scoped PAT (dashboard or operator) and the
  // session sandbox's own KORTIX_TOKEN (so the in-sandbox agent CLI can relay
  // its plan steps without a second token). Each is scoped to one projectId.
  const authType = (c as any).get('authType') as string | undefined;
  if (authType === 'apiKey' && (c as any).get('apiKeyType') === 'sandbox') {
    const accountId = (c as any).get('accountId') as string | undefined;
    const sandboxId = (c as any).get('sandboxId') as string | undefined;
    if (!accountId || !sandboxId) {
      return c.json({ error: 'turn-stream requires a sandbox token' }, 403);
    }
    const [sandbox] = await db
      .select({ sandboxId: sessionSandboxes.sandboxId })
      .from(sessionSandboxes)
      .where(and(
        eq(sessionSandboxes.sandboxId, sandboxId),
        eq(sessionSandboxes.projectId, projectId),
        eq(sessionSandboxes.accountId, accountId),
        inArray(sessionSandboxes.status, ['provisioning', 'active']),
      ))
      .limit(1);
    if (!sandbox) {
      return c.json({ error: 'sandbox token is not scoped to this project' }, 403);
    }
  } else {
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
  }

  let body: {
    session_id?: string;
    kind?: string;
    text?: string;
    detail?: string;
    output?: string;
    sources?: Array<{ url?: string; text?: string }>;
    blocks?: unknown[];
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const sessionId = body.session_id?.trim();
  const text = (body.text ?? '').trim();
  if (!sessionId || !text) {
    return c.json({ error: 'session_id and text are required' }, 400);
  }

  const detail = body.detail?.trim() || undefined;
  const outputForPrev = body.output?.trim() || undefined;
  const sourcesForPrev = Array.isArray(body.sources)
    ? body.sources
        .filter((s): s is { url: string; text: string } => !!s?.url && !!s?.text)
        .map((s) => ({ url: s.url, text: s.text }))
    : undefined;
  const blocks = Array.isArray(body.blocks) && body.blocks.length > 0 ? body.blocks : undefined;

  const ok =
    body.kind === 'answer'
      ? await relayTurnAnswer(sessionId, text, blocks)
      : await relayTurnStep(sessionId, text, { detail, outputForPrev, sourcesForPrev });
  return c.json({ ok });
},
);

// POST /v1/projects/:projectId/turn-question
// Sandbox-to-apps/api relay for opencode's `question.asked` event. The
// sandbox subscribes to opencode's SSE stream; when the agent calls the
// built-in `question` tool, the sandbox relays the QuestionInfo[] here.
// We post a Block Kit form, block on Submit, return `answers: string[][]`,
// and the sandbox POSTs the same payload to opencode's
// /question/{requestID}/reply so the tool resumes.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/turn-question',
    tags: ['projects'],
    summary: 'POST /:projectId/turn-question',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');

  const authType = (c as any).get('authType') as string | undefined;
  if (authType === 'apiKey' && (c as any).get('apiKeyType') === 'sandbox') {
    const accountId = (c as any).get('accountId') as string | undefined;
    const sandboxId = (c as any).get('sandboxId') as string | undefined;
    if (!accountId || !sandboxId) {
      return c.json({ error: 'turn-question requires a sandbox token' }, 403);
    }
    const [sandbox] = await db
      .select({ sandboxId: sessionSandboxes.sandboxId })
      .from(sessionSandboxes)
      .where(and(
        eq(sessionSandboxes.sandboxId, sandboxId),
        eq(sessionSandboxes.projectId, projectId),
        eq(sessionSandboxes.accountId, accountId),
        inArray(sessionSandboxes.status, ['provisioning', 'active']),
      ))
      .limit(1);
    if (!sandbox) {
      return c.json({ error: 'sandbox token is not scoped to this project' }, 403);
    }
  } else {
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
  }

  let body: {
    session_id?: string;
    request_id?: string;
    questions?: unknown[];
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const sessionId = body.session_id?.trim();
  if (!sessionId) {
    return c.json({ error: 'session_id is required' }, 400);
  }
  if (!Array.isArray(body.questions) || body.questions.length === 0) {
    return c.json({ error: 'at least one question is required' }, 400);
  }

  // Validate + coerce to QuestionInfo[]. Tolerate the v2 SDK schema variants.
  const questions: QuestionInfo[] = [];
  for (const q of body.questions) {
    if (!q || typeof q !== 'object') continue;
    const obj = q as Record<string, unknown>;
    const question = String(obj.question ?? '').trim();
    if (!question) continue;
    const optionsRaw = Array.isArray(obj.options) ? obj.options : [];
    const options = optionsRaw
      .map((o) => (o && typeof o === 'object' ? (o as Record<string, unknown>) : null))
      .filter((o): o is Record<string, unknown> => !!o && typeof o.label === 'string')
      .map((o) => ({
        label: String(o.label),
        description: typeof o.description === 'string' ? String(o.description) : undefined,
      }));
    questions.push({
      question,
      header: obj.header ? String(obj.header) : undefined,
      options,
      multiple: !!obj.multiple,
      custom: obj.custom === false ? false : true,
    });
  }
  if (questions.length === 0) {
    return c.json({ error: 'no valid questions provided' }, 400);
  }

  const result = await postQuestionAndWait(sessionId, questions);
  if (!result.ok) return c.json({ ok: false, error: result.error }, 409);
  return c.json({ ok: true, ask_id: result.ask_id, answers: result.answers });
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
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const { specs } = await loadProjectTriggers(await withProjectGitAuth(loaded.row));
  const spec = specs.find((s) => s.slug === slug);
  if (!spec) return c.json({ error: 'Not found' }, 404);

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
    return c.json({ status: 'queued', reason: result.reason ?? null }, 202);
  }
  if (result.status === 'failed') {
    return c.json({ error: result.error ?? 'Failed to fire trigger' }, 500);
  }
  await markGitTriggerFired(projectId, slug, now);
  return c.json({ status: 'fired', session_id: result.sessionId ?? null }, 202);
},
);

// ── [[apps]] CRUD + deploy ──────────────────────────────────────────────────
//
// Apps are declared in `[[apps]]` blocks inside kortix.toml. The manifest
// is the source of truth; the `deployments` table stores deploy attempts
// (one row per version per app). The sweep loop in ./app-sweep.ts auto-
// deploys on manifest drift; the routes below give the UI and CLI a
// manual path.
//
// EXPERIMENTAL. The entire surface is gated PER PROJECT
// (projects.metadata.apps_enabled, defaulting to KORTIX_APPS_EXPERIMENTAL).
// When off for a project, every /apps route returns 404 and the sweep skips
// it. This middleware loads the project's gate and short-circuits before any
// of the handlers below run.


projectsApp.use('/:projectId/apps/*', async (c, next) => {
  if (!(await projectAppsEnabled(c.req.param('projectId')))) {
    return c.json(APPS_DISABLED_BODY, 404);
  }
  await next();
});

projectsApp.use('/:projectId/apps', async (c, next) => {
  if (!(await projectAppsEnabled(c.req.param('projectId')))) {
    return c.json(APPS_DISABLED_BODY, 404);
  }
  await next();
});


projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/apps',
    tags: ['apps'],
    summary: 'GET /:projectId/apps',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(z.array(AppSchema), 'Apps'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  return c.json(await loadAppsForResponse(projectId, loaded.row));
},
);

// POST /v1/projects/:projectId/apps — add a new app to kortix.toml

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/apps',
    tags: ['apps'],
    summary: 'POST /:projectId/apps',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        201: json(AppSchema, 'The created app'),
        ...errors(400, 404, 409),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const draft = parseAppDraft(body, { existingSlug: null });
  if ('error' in draft) return c.json({ error: draft.error }, 400);

  let manifest: ParsedManifest;
  try {
    manifest = await loadManifestForEdit(loaded.row);
  } catch (err) {
    return c.json({ error: (err as Error).message || 'Failed to read manifest' }, 400);
  }

  if (extractApps(manifest).specs.some((s) => s.slug === draft.slug)) {
    return c.json({
      error: `An app with slug "${draft.slug}" already exists. Pick a different name.`,
    }, 409);
  }

  const next = upsertAppInManifest(manifest, draftToAppSpec(draft));
  const result = await commitManifest(loaded.row, next, `chore: add app ${draft.slug}`);
  if ('error' in result) {
    return c.json({ error: result.error }, result.status as 400 | 502);
  }

  return c.json(await loadAppsForResponse(projectId, loaded.row), 201);
},
);

// PATCH /v1/projects/:projectId/apps/:slug — partial update merged onto current

projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/apps/{slug}',
    tags: ['apps'],
    summary: 'PATCH /:projectId/apps/:slug',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), slug: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const slug = c.req.param('slug');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  let manifest: ParsedManifest;
  try {
    manifest = await loadManifestForEdit(loaded.row);
  } catch (err) {
    return c.json({ error: (err as Error).message || 'Failed to read manifest' }, 400);
  }
  const current = extractApps(manifest).specs.find((s) => s.slug === slug);
  if (!current) return c.json({ error: 'Not found' }, 404);

  const draft = parseAppDraft(
    { ...specToAppBody(current), ...body, slug },
    { existingSlug: slug },
  );
  if ('error' in draft) return c.json({ error: draft.error }, 400);

  const next = upsertAppInManifest(manifest, draftToAppSpec(draft));
  const result = await commitManifest(loaded.row, next, `chore: update app ${slug}`);
  if ('error' in result) {
    return c.json({ error: result.error }, result.status as 400 | 502);
  }

  return c.json(await loadAppsForResponse(projectId, loaded.row));
},
);

// DELETE /v1/projects/:projectId/apps/:slug — remove from manifest. Does
// NOT auto-stop existing deployments; call /apps/:slug/stop first if needed.

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/apps/{slug}',
    tags: ['apps'],
    summary: 'DELETE /:projectId/apps/:slug',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), slug: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const slug = c.req.param('slug');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug)) {
    return c.json({ error: 'Invalid slug' }, 400);
  }

  let manifest: ParsedManifest;
  try {
    manifest = await loadManifestForEdit(loaded.row);
  } catch (err) {
    return c.json({ error: (err as Error).message || 'Failed to read manifest' }, 400);
  }
  if (!extractApps(manifest).specs.some((s) => s.slug === slug)) {
    return c.json({ error: 'Not found' }, 404);
  }

  const next = removeAppFromManifest(manifest, slug);
  const result = await commitManifest(loaded.row, next, `chore: delete app ${slug}`);
  if ('error' in result) {
    return c.json({ error: result.error }, result.status as 400 | 502);
  }
  return c.json({ ok: true });
},
);

// POST /v1/projects/:projectId/apps/:slug/deploy — manual deploy. Mirrors
// what the sweep does on drift but bypasses the hash-equality skip.
