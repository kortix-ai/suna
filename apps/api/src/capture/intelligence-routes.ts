/**
 * Capture Intelligence, account-scoped: `/v1/accounts/:accountId/capture/…`
 *
 *   GET  overview                                  admins, viewers (capture.account_view)
 *   GET  workflows · GET workflows/:id             admins, viewers (capture.account_view)
 *   POST workflows/:id/review                      admins
 *   POST workflows/:id/skill-draft                 admins
 *   POST workflows/:id/skill                       admins with write access to the project
 *   GET  episodes · GET episodes/:id               yours; anyone's for admins and viewers (audited)
 *   POST exports · GET exports · GET exports/:id   admins
 *   POST intelligence/run                          admins: run the pipelines now
 *
 * Every route answers 403 `capture_disabled` while Capture is off.
 */
import { createRoute, z } from '@hono/zod-openapi';
import * as C from '@kortix/api-contract';
import { accountsRouter } from '../accounts/core/app';
import { auth, errors, json } from '../openapi';
import { loadProjectForUser } from '../projects/surface';
import { auditRead, captureAccess, isResponse, refuse, type Access, type Ctx } from './account-routes';
import { enqueueExport, exportDownload } from './exports';
import {
  createExport,
  episodeInAccount,
  episodeSteps,
  episodeView,
  exportInAccount,
  exportView,
  listEpisodes,
  listExports,
  listWorkflows,
  overview,
  reviewWorkflow,
  workflowDetail,
  workflowInAccount,
} from './intelligence';
import { draftSkill, publishSkill, skillSlug } from './skills';
import { captureStoreConfigured } from './store';
import { runIntelligence } from './workers';

const params = z.object({ accountId: z.string().uuid() });
const ok = (description: string) => ({ 200: json(z.any(), description), ...errors(400, 403, 404) });
/** A 200 with its contract schema (packages/api-contract): the handler's body is type-checked against it. */
const typed = <S extends z.ZodTypeAny>(schema: S, description: string) => ({ 200: json(schema, description), ...errors(400, 403, 404) });
const tags = ['capture'];
const DAY = 86_400_000;

const adminOnly = (c: Ctx, access: Access) =>
  access.role === 'admin' ? null : refuse(c, 403, 'capture_forbidden', 'Only a Capture admin can do this');

function span(c: Ctx, defaultDays: number) {
  const to = c.req.query('to') ? new Date(c.req.query('to')!) : new Date();
  const from = c.req.query('from') ? new Date(c.req.query('from')!) : new Date(to.getTime() - defaultDays * DAY);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from || to.getTime() - from.getTime() > 366 * DAY) return null;
  return { from, to };
}

/** Overview, workflows (review, skill draft and publish) and the run-now trigger. */
function registerCaptureWorkflowRoutes() {
  accountsRouter.openapi(
    createRoute({
      method: 'get',
      path: '/{accountId}/capture/overview',
      tags,
      summary: 'Capture overview: hours recorded, people, devices, automatable hours a week, top workflows, new this week, trend',
      ...auth,
      request: { params, query: z.object({ from: z.string().optional(), to: z.string().optional() }) },
      responses: ok('The overview'),
    }),
    async (c) => {
      const access = await captureAccess(c, { accountWide: true });
      if (isResponse(access)) return access as never;
      const window = span(c, 30);
      if (!window) return refuse(c, 400, 'capture_bad_window', 'from < to, at most 366 days apart');
      return c.json(await overview(access.accountId, window), 200);
    },
  );

  accountsRouter.openapi(
    createRoute({
      method: 'get',
      path: '/{accountId}/capture/workflows',
      tags,
      summary: 'Workflows mined from the account’s episodes, by automatable hours a week (default), runs a week, or newest',
      ...auth,
      request: {
        params,
        query: z.object({
          status: z.enum(['detected', 'reviewed', 'exported']).optional(),
          q: z.string().max(200).optional(),
          app: z.string().max(200).optional(),
          user_id: z.string().uuid().optional(),
          sort: z.enum(['hours', 'runs', 'newest']).optional(),
          limit: z.string().optional(),
          offset: z.string().optional(),
        }),
      },
      responses: typed(C.CaptureWorkflowListSchema, 'The workflows and the count per status'),
    }),
    async (c) => {
      const access = await captureAccess(c, { accountWide: true });
      if (isResponse(access)) return access as never;
      const q = c.req.valid('query');
      const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
      const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
      return c.json(await listWorkflows(access.accountId, { status: q.status, q: q.q?.trim() || undefined, app: q.app, userId: q.user_id, sort: q.sort, limit, offset }), 200);
    },
  );

  accountsRouter.openapi(
    createRoute({
      method: 'get',
      path: '/{accountId}/capture/workflows/{workflowId}',
      tags,
      summary: 'One workflow: the canonical procedure, variants and decision points, who runs it, review and skill state',
      ...auth,
      request: { params: params.extend({ workflowId: z.string().uuid() }) },
      responses: typed(C.CaptureWorkflowDetailSchema, 'The workflow'),
    }),
    async (c) => {
      const access = await captureAccess(c, { accountWide: true });
      if (isResponse(access)) return access as never;
      const w = await workflowInAccount(access.accountId, c.req.valid('param').workflowId);
      if (!w) return c.json({ error: 'Not found' }, 404);
      return c.json(await workflowDetail(w), 200);
    },
  );

  accountsRouter.openapi(
    createRoute({
      method: 'post',
      path: '/{accountId}/capture/workflows/{workflowId}/review',
      tags,
      summary: 'Review a workflow (Capture admins): rename it, restate the goal, edit the steps; it reads as reviewed',
      ...auth,
      request: {
        params: params.extend({ workflowId: z.string().uuid() }),
        body: {
          content: {
            'application/json': {
              schema: z.object({
                name: z.string().min(1).max(200).optional(),
                goal: z.string().max(2000).optional(),
                outcome: z.string().max(2000).optional(),
                steps: z.array(z.record(z.string(), z.any())).max(200).optional(),
              }),
            },
          },
        },
      },
      responses: typed(C.CaptureWorkflowDetailSchema, 'The reviewed workflow'),
    }),
    async (c) => {
      const access = await captureAccess(c, { accountWide: true });
      if (isResponse(access)) return access as never;
      const denied = adminOnly(c, access);
      if (denied) return denied as never;
      const w = await workflowInAccount(access.accountId, c.req.valid('param').workflowId);
      if (!w) return c.json({ error: 'Not found' }, 404);
      return c.json(await workflowDetail(await reviewWorkflow(w, c.req.valid('json'), access.viewer)), 200);
    },
  );

  accountsRouter.openapi(
    createRoute({
      method: 'post',
      path: '/{accountId}/capture/intelligence/run',
      tags,
      summary: 'Run the pipelines now (Capture admins): queue episodes for every closed or failed range, then mining; or mining alone',
      ...auth,
      request: {
        params,
        body: { content: { 'application/json': { schema: z.object({ mining_only: z.boolean().optional() }) } }, required: false },
      },
      responses: { 202: json(z.object({ episodes_queued: z.number(), mining_queued: z.boolean() }), 'Queued'), ...errors(403, 404) },
    }),
    async (c) => {
      const access = await captureAccess(c, { accountWide: true });
      if (isResponse(access)) return access as never;
      const denied = adminOnly(c, access);
      if (denied) return denied as never;
      if (access.sessionId) return refuse(c, 403, 'capture_forbidden', 'An agent cannot start the pipelines') as never;
      const body = (await c.req.json().catch(() => ({}))) as { mining_only?: boolean };
      return c.json(await runIntelligence(access.accountId, { miningOnly: body?.mining_only === true }), 202);
    },
  );

  accountsRouter.openapi(
    createRoute({
      method: 'post',
      path: '/{accountId}/capture/workflows/{workflowId}/skill-draft',
      tags,
      summary: 'Draft a SKILL.md from a workflow (Capture admins): inputs, steps, variants, the apps it needs; checks before publishing',
      ...auth,
      request: {
        params: params.extend({ workflowId: z.string().uuid() }),
        body: { content: { 'application/json': { schema: z.object({ name: z.string().max(64).optional() }) } } },
      },
      responses: ok('The draft'),
    }),
    async (c) => {
      const access = await captureAccess(c, { accountWide: true });
      if (isResponse(access)) return access as never;
      const denied = adminOnly(c, access);
      if (denied) return denied as never;
      const w = await workflowInAccount(access.accountId, c.req.valid('param').workflowId);
      if (!w) return c.json({ error: 'Not found' }, 404);
      const name = c.req.valid('json').name;
      return c.json(draftSkill(w, name ? skillSlug(name) : undefined), 200);
    },
  );

  accountsRouter.openapi(
    createRoute({
      method: 'post',
      path: '/{accountId}/capture/workflows/{workflowId}/skill',
      tags,
      summary: 'Publish a skill into a project of the account (Capture admins with write access to it): commits skills/<name>/SKILL.md',
      ...auth,
      request: {
        params: params.extend({ workflowId: z.string().uuid() }),
        body: {
          content: {
            'application/json': {
              schema: z.object({
                project_id: z.string().uuid(),
                name: z.string().min(1).max(64),
                markdown: z.string().min(1).max(100_000),
              }),
            },
          },
        },
      },
      responses: { ...ok('The published skill'), ...errors(502) },
    }),
    async (c) => {
      const access = await captureAccess(c, { accountWide: true });
      if (isResponse(access)) return access as never;
      const denied = adminOnly(c, access);
      if (denied) return denied as never;
      const w = await workflowInAccount(access.accountId, c.req.valid('param').workflowId);
      if (!w) return c.json({ error: 'Not found' }, 404);
      const body = c.req.valid('json');
      const name = skillSlug(body.name);
      if (name !== body.name) return refuse(c, 400, 'capture_bad_skill_name', `Skill names are lower case, a–z, 0–9 and dashes: "${name}"`);
      const loaded = await loadProjectForUser(c, body.project_id, 'write');
      if (!loaded || loaded.row.accountId !== access.accountId) return c.json({ error: 'Project not found' }, 404);
      const published = await publishSkill({ workflow: w, project: loaded.row, name, markdown: body.markdown, by: access.viewer });
      if (!('ok' in published)) return c.json({ error: published.error, code: 'capture_skill_publish_failed' }, published.status === 502 ? 502 : 400);
      return c.json({ workflow_id: w.workflowId, status: 'exported', skill: published.skill }, 200);
    },
  );
}

/** Episodes (L1) with their steps (L2). */
function registerCaptureEpisodeRoutes() {
  accountsRouter.openapi(
    createRoute({
      method: 'get',
      path: '/{accountId}/capture/episodes',
      tags,
      summary: 'Episodes (one task of one person): yours; a member’s (`user_id`) or the account’s (`scope=account`) for admins and viewers',
      ...auth,
      request: {
        params,
        query: z.object({
          user_id: z.string().uuid().optional(),
          scope: z.enum(['mine', 'account']).optional(),
          device_id: z.string().uuid().optional(),
          workflow_id: z.string().uuid().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          before: z.string().optional().describe('Keyset cursor: `next_before` of the previous page'),
          limit: z.string().optional(),
        }),
      },
      responses: typed(C.CaptureEpisodeListSchema, 'Episodes, newest first, and the cursor of the next page'),
    }),
    async (c) => {
      const q = c.req.valid('query');
      const access = await captureAccess(c, { userId: q.user_id, accountWide: q.scope === 'account' });
      if (isResponse(access)) return access as never;
      const date = (v?: string) => (v ? new Date(v) : undefined);
      const [from, to, before] = [date(q.from), date(q.to), date(q.before)];
      if ([from, to, before].some((d) => d && Number.isNaN(d.getTime()))) return refuse(c, 400, 'capture_bad_window', 'from, to and before are ISO instants');
      const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
      return c.json(await listEpisodes(access.accountId, { userId: access.subject, deviceId: q.device_id, workflowId: q.workflow_id, from, to, before, limit }), 200);
    },
  );

  accountsRouter.openapi(
    createRoute({
      method: 'get',
      path: '/{accountId}/capture/episodes/{episodeId}',
      tags,
      summary: 'One episode with its step trace (verb, app, object, variables, keyframe)',
      ...auth,
      request: { params: params.extend({ episodeId: z.string().uuid() }) },
      responses: typed(C.CaptureEpisodeDetailSchema, 'The episode with its steps'),
    }),
    async (c) => {
      const access = await captureAccess(c);
      if (isResponse(access)) return access as never;
      const e = await episodeInAccount(access.accountId, c.req.valid('param').episodeId);
      if (!e) return c.json({ error: 'Not found' }, 404);
      if (e.userId !== access.viewer) {
        if (!access.readsAll) return c.json({ error: 'Not found' }, 404);
        await auditRead(c, access, 'capture.member_view', e.userId);
      }
      return c.json({ ...episodeView(e), steps: await episodeSteps(e.episodeId) }, 200);
    },
  );
}

/** Bulk exports (JSONL, Parquet). */
function registerCaptureExportRoutes() {
  accountsRouter.openapi(
    createRoute({
      method: 'post',
      path: '/{accountId}/capture/exports',
      tags,
      summary: 'Start a bulk export of episodes, steps and workflows (Capture admins): JSONL (any tables) or Parquet (one table); poll it, then download by signed URL',
      ...auth,
      request: {
        params,
        body: {
          content: {
            'application/json': {
              schema: z.object({
                format: z.enum(['jsonl', 'parquet']).default('jsonl'),
                from: z.string().optional(),
                to: z.string().optional(),
                include: z.array(z.enum(['episodes', 'steps', 'workflows'])).optional(),
              }),
            },
          },
        },
      },
      responses: { 202: json(C.CaptureExportSchema, 'The export, queued'), ...errors(400, 403, 404, 503) },
    }),
    async (c) => {
      const access = await captureAccess(c, { accountWide: true });
      if (isResponse(access)) return access as never;
      const denied = adminOnly(c, access);
      if (denied) return denied as never;
      if (!captureStoreConfigured()) return refuse(c, 503, 'capture_store_unavailable', 'No capture store is configured');
      const body = c.req.valid('json');
      if (body.format === 'parquet' && (body.include?.length ?? 0) > 1) {
        return refuse(c, 400, 'capture_export_one_table', 'A Parquet export holds one table: include one of episodes, steps or workflows');
      }
      const row = await createExport({
        accountId: access.accountId,
        requestedBy: access.viewer,
        format: body.format,
        params: { from: body.from, to: body.to, include: body.include },
      });
      await enqueueExport(row.exportId);
      return c.json(exportView(row), 202);
    },
  );

  accountsRouter.openapi(
    createRoute({
      method: 'get',
      path: '/{accountId}/capture/exports',
      tags,
      summary: 'The account’s last 50 exports (Capture admins)',
      ...auth,
      request: { params },
      responses: typed(C.CaptureExportListSchema, 'The exports, newest first (50)'),
    }),
    async (c) => {
      const access = await captureAccess(c, { accountWide: true });
      if (isResponse(access)) return access as never;
      const denied = adminOnly(c, access);
      if (denied) return denied as never;
      return c.json({ exports: (await listExports(access.accountId)).map((e) => exportView(e)) }, 200);
    },
  );

  accountsRouter.openapi(
    createRoute({
      method: 'get',
      path: '/{accountId}/capture/exports/{exportId}',
      tags,
      summary: 'One export; when done, a signed download URL valid for 1 hour (Capture admins)',
      ...auth,
      request: { params: params.extend({ exportId: z.string().uuid() }) },
      responses: typed(C.CaptureExportSchema, 'The export; `download` once done'),
    }),
    async (c) => {
      const access = await captureAccess(c, { accountWide: true });
      if (isResponse(access)) return access as never;
      const denied = adminOnly(c, access);
      if (denied) return denied as never;
      const e = await exportInAccount(access.accountId, c.req.valid('param').exportId);
      if (!e) return c.json({ error: 'Not found' }, 404);
      return c.json(exportView(e, e.status === 'done' ? await exportDownload(e.objectKey) : null), 200);
    },
  );
}

export function registerCaptureIntelligenceRoutes() {
  registerCaptureWorkflowRoutes();
  registerCaptureEpisodeRoutes();
  registerCaptureExportRoutes();
}

