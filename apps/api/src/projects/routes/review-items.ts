// ─── Review Center ──────────────────────────────────────────────────────────
// Per-project human-in-the-loop inbox. Agents submit outputs / decisions /
// batches for review; humans approve, reject, request changes, or answer. Native
// items only this pass — change requests and connector/tunnel approvals are folded
// in by adapters later.

import { createRoute, z } from '@hono/zod-openapi';
import { connectorCalls, projectSessions } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import { relayReviewCard } from '../../channels/turn-relay';
import { PROJECT_ACTIONS } from '../../iam';
import { assertAgentScope } from '../../iam/agent-scope';
import { auth, errors, json, lenientBody } from '../../openapi';
import { db } from '../../shared/db';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { approvalResolvers, mayResolveApproval } from '../lib/approval-authority';
import { approvalTargetOf } from '../lib/connector-approval-decision';
import { approvalCallerOf } from '../lib/http-approval-caller';
import { normalizeString } from '../lib/serializers';
import { readJsonObject } from '../../shared/http-body';
import { isAdaptedId } from '../review-adapters';
import {
  type ConnectorCallVerdict,
  type ReviewSegment,
  applyVerdict,
  bulkApplyVerdict,
  getReviewItemById,
  insertReviewItem,
  isReviewVerdict,
  isSubmittableKind,
  listInboxItems,
  serializeReviewItem,
} from '../review-items';

const KINDS = ['change', 'approval', 'output', 'decision', 'batch'] as const;
const RISKS = ['none', 'low', 'medium', 'high'] as const;
const SEGMENTS = ['needs_you', 'waiting', 'done'] as const;

export function registerReviewItemsRoutes(): void {
  // GET /v1/projects/:projectId/review/items?segment=&kind=
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/review/items',
      tags: ['review'],
      summary: 'List review items (approvals and change requests)',
      ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        query: z.object({}).passthrough(),
      },
      responses: {
        200: json(z.object({ review_items: z.array(AnyObject) }), 'Review items'),
        ...errors(400, 403, 404),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_REVIEW_READ,
      );

      const segment = normalizeString(c.req.query('segment'))?.toLowerCase();
      if (segment && !SEGMENTS.includes(segment as (typeof SEGMENTS)[number])) {
        return c.json({ error: 'Invalid segment' }, 400);
      }
      const kind = normalizeString(c.req.query('kind'))?.toLowerCase();
      if (kind && !KINDS.includes(kind as (typeof KINDS)[number])) {
        return c.json({ error: 'Invalid kind' }, 400);
      }

      // One verdict per pending connector call, the resolve route's own
      // (`approvalCallerOf` + `mayResolveApproval`). It decides what this
      // caller sees: `args_preview` (email bodies, recipients, URLs) only for a
      // human who may resolve the exact call — the broad `project.review.read`
      // leaf may list the row, no more — plus `can_resolve` and the status
      // (Needs you for a resolver, Waiting for everyone else; KRTX-1724). New
      // rows that race this query fail closed: their execution id is not in
      // this set.
      const pendingExecutions = await db
        .select({
          executionId: connectorCalls.executionId,
          sessionId: connectorCalls.sessionId,
          actingUserId: connectorCalls.actingUserId,
        })
        .from(connectorCalls)
        .where(
          and(
            eq(connectorCalls.projectId, projectId),
            eq(connectorCalls.status, 'pending_approval'),
          ),
        );
      const sessionIds = [
        ...new Set(
          pendingExecutions
            .map((execution) => execution.sessionId)
            .filter((sessionId): sessionId is string => Boolean(sessionId)),
        ),
      ];
      const sessions = sessionIds.length
        ? await db
            .select({
              sessionId: projectSessions.sessionId,
              createdBy: projectSessions.createdBy,
              origin: projectSessions.origin,
            })
            .from(projectSessions)
            .where(
              and(
                eq(projectSessions.projectId, projectId),
                inArray(projectSessions.sessionId, sessionIds),
              ),
            )
        : [];
      const sessionById = new Map(sessions.map((session) => [session.sessionId, session]));
      const verdicts = new Map<string, ConnectorCallVerdict>();
      // The caller probe runs only when something is pending.
      const caller = pendingExecutions.length ? await approvalCallerOf(c, loaded, projectId) : null;
      if (caller) {
        for (const execution of pendingExecutions) {
          const session = execution.sessionId
            ? sessionById.get(String(execution.sessionId))
            : undefined;
          const { origin, createdBy } = approvalTargetOf(execution, session);
          const target = { targetSessionOrigin: origin, targetSessionCreatedBy: createdBy };
          verdicts.set(execution.executionId, {
            canResolve: mayResolveApproval({ ...caller, ...target }).allowed,
            resolvers: approvalResolvers(target),
          });
        }
      }

      const items = await listInboxItems(projectId, {
        segment: segment as ReviewSegment | undefined,
        kind: kind as (typeof KINDS)[number] | undefined,
        connectorCallVerdict: (execution) => verdicts.get(execution.executionId),
      });
      return c.json({ review_items: items });
    },
  );

  // GET /v1/projects/:projectId/review/items/:reviewItemId
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/review/items/{reviewItemId}',
      tags: ['review'],
      summary: 'Get a review item',
      ...auth,
      request: {
        params: z.object({ projectId: z.string(), reviewItemId: z.string() }),
      },
      responses: {
        200: json(z.object({ review_item: AnyObject }), 'Review item'),
        ...errors(400, 403, 404),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_REVIEW_READ,
      );

      const item = await getReviewItemById(c.req.param('reviewItemId'), projectId);
      if (!item) return c.json({ error: 'Review item not found' }, 404);
      return c.json({ review_item: serializeReviewItem(item) });
    },
  );

  // POST /v1/projects/:projectId/review/items  (agent submits output|decision|batch)
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/review/items',
      tags: ['review'],
      summary: 'Create a review item',
      ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: lenientBody({
            kind: z.enum(['output', 'decision', 'batch']).openapi({ description: 'Review item kind.' }),
            title: z.string().openapi({ description: 'Title.' }),
            summary: z.string().optional().openapi({ description: 'Short summary.' }),
            risk: z.string().optional().openapi({ description: 'Risk level. Default none.' }),
            detail: z.record(z.string(), z.any()).optional().openapi({ description: 'Structured detail shown to the reviewer.' }),
            session_id: z.string().optional().openapi({ description: 'Originating session.' }),
            agent: z.string().optional().openapi({ description: 'Agent that raised it.' }),
          }) } } },
      },
      responses: {
        201: json(AnyObject, 'The created review item'),
        ...errors(400, 403, 404),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const body = await readJsonObject(c);
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      // Human gate: submitting a reviewable needs project.review.submit. Every
      // built-in role holds it; a custom role that unchecks it is denied here.
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_REVIEW_SUBMIT,
      );
      // Agent-side gate: submitting a reviewable is the agent's intended path.
      assertAgentScope(c, 'project.review.submit');

      const kind = normalizeString(body.kind);
      if (!isSubmittableKind(kind)) {
        return c.json({ error: 'kind must be one of output, decision, batch' }, 400);
      }
      const title = normalizeString(body.title);
      if (!title) return c.json({ error: 'title is required' }, 400);

      const risk = normalizeString(body.risk)?.toLowerCase() ?? 'none';
      if (!RISKS.includes(risk as (typeof RISKS)[number])) {
        return c.json({ error: 'Invalid risk' }, 400);
      }
      const detail =
        body.detail && typeof body.detail === 'object' && !Array.isArray(body.detail)
          ? (body.detail as Record<string, unknown>)
          : {};

      let originSessionId: string | null = normalizeString(body.session_id ?? body.sessionId);
      if (originSessionId) {
        const [sessionRow] = await db
          .select({ sessionId: projectSessions.sessionId })
          .from(projectSessions)
          .where(
            and(
              eq(projectSessions.sessionId, originSessionId),
              eq(projectSessions.projectId, projectId),
            ),
          )
          .limit(1);
        if (!sessionRow) originSessionId = null;
      }

      const row = await insertReviewItem({
        accountId: loaded.row.accountId,
        projectId,
        kind,
        title,
        summary: normalizeString(body.summary) ?? '',
        risk: risk as (typeof RISKS)[number],
        detail,
        agent: normalizeString(body.agent) ?? '',
        originSessionId,
        createdBy: loaded.userId,
      });
      // If this was submitted from a live Slack session, post an actionable card
      // into that thread so a human can approve/deny it right there. Best-effort and
      // a no-op for web sessions (postReviewCard returns early when there's no live
      // Slack turn). Fire-and-forget so a slow Slack API never delays the 201.
      if (row.originSessionId) {
        void relayReviewCard(row.originSessionId, {
          review_item_id: row.reviewItemId,
          kind: row.kind,
          risk: row.risk,
          title: row.title,
          summary: row.summary,
        }).catch(() => {});
      }
      return c.json(serializeReviewItem(row), 201);
    },
  );

  // POST /v1/projects/:projectId/review/items/:reviewItemId/act
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/review/items/{reviewItemId}/act',
      tags: ['review'],
      summary: 'Approve, reject or act on a review item',
      ...auth,
      request: {
        params: z.object({ projectId: z.string(), reviewItemId: z.string() }),
        body: { content: { 'application/json': { schema: lenientBody({
            verdict: z.enum(['approve', 'reject', 'changes', 'answer', 'dismiss']).openapi({ description: 'Decision on the item.' }),
            feedback: z.string().optional().openapi({ description: 'Comment or answer text.' }),
          }) } } },
      },
      responses: {
        200: json(AnyObject, 'The updated review item'),
        ...errors(400, 403, 404, 409),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const reviewItemId = c.req.param('reviewItemId');
      const body = await readJsonObject(c);
      const loaded = await loadProjectForUser(c, projectId, 'write');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_REVIEW_ACT,
      );

      const verdict = normalizeString(body.verdict);
      if (!isReviewVerdict(verdict)) {
        return c.json(
          { error: 'verdict must be one of approve, reject, changes, answer, dismiss' },
          400,
        );
      }
      // Adapted items (change requests, connector approvals) act through their own
      // source flow, not the review act endpoint.
      if (isAdaptedId(reviewItemId)) {
        return c.json({ error: 'Act on this item from its source view' }, 409);
      }
      const existing = await getReviewItemById(reviewItemId, projectId);
      if (!existing) return c.json({ error: 'Review item not found' }, 404);

      const row = await applyVerdict(reviewItemId, projectId, {
        verdict,
        feedback: normalizeString(body.feedback),
        actingUserId: loaded.userId,
      });
      if (!row) return c.json({ error: 'Review item not found' }, 404);
      return c.json(serializeReviewItem(row));
    },
  );

  // POST /v1/projects/:projectId/review/bulk  ({ ids, verdict })
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/review/bulk',
      tags: ['review'],
      summary: 'Act on several review items at once',
      ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: lenientBody({
            ids: z.array(z.string()).openapi({ description: 'Review item ids. review_item_ids is accepted as an alias.' }),
            verdict: z.enum(['approve', 'reject', 'changes', 'answer', 'dismiss']).openapi({ description: 'Decision applied to every item.' }),
          }) } } },
      },
      responses: {
        200: json(z.object({ updated: z.number(), review_items: z.array(AnyObject) }), 'Bulk result'),
        ...errors(400, 403, 404),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const body = await readJsonObject(c);
      const loaded = await loadProjectForUser(c, projectId, 'write');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_REVIEW_ACT,
      );

      const verdict = normalizeString(body.verdict);
      if (!isReviewVerdict(verdict)) {
        return c.json(
          { error: 'verdict must be one of approve, reject, changes, answer, dismiss' },
          400,
        );
      }
      const idsRaw = Array.isArray(body.ids)
        ? body.ids
        : Array.isArray(body.review_item_ids)
          ? body.review_item_ids
          : null;
      const ids = (idsRaw ?? []).filter((x: unknown): x is string => typeof x === 'string');
      if (ids.length === 0) return c.json({ error: 'ids must be a non-empty array' }, 400);

      const rows = await bulkApplyVerdict(ids, projectId, { verdict, actingUserId: loaded.userId });
      return c.json({ updated: rows.length, review_items: rows.map(serializeReviewItem) });
    },
  );
}
