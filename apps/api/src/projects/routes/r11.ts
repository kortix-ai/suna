// ─── Review Center ──────────────────────────────────────────────────────────
// Per-project human-in-the-loop inbox. Agents submit outputs / decisions /
// batches for review; humans approve, reject, request changes, or answer. Native
// items only this pass — change requests and connector/tunnel approvals are folded
// in by adapters later. See docs/REVIEW_CENTER_DESIGN.md.

import { createRoute, z } from '@hono/zod-openapi';
import { connectorCalls, projectSessions } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import { relayReviewCard } from '../../channels/turn-relay';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { PROJECT_ACTIONS } from '../../iam';
import { assertAgentScope } from '../../iam/agent-scope';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { mayResolveApproval } from '../lib/approval-authority';
import { callerKortixSessionId } from '../lib/caller-session';
import { normalizeString, readBody } from '../lib/serializers';
import { isAdaptedId } from '../review-adapters';
import {
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

// GET /v1/projects/:projectId/review/items?segment=&kind=
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/review/items',
    tags: ['review'],
    summary: 'GET /:projectId/review/items',
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
    const gate = requireFeatureFlag(c, loaded.row.metadata, 'review_center');
    if (gate) return gate;

    const segment = normalizeString(c.req.query('segment'))?.toLowerCase();
    if (segment && !SEGMENTS.includes(segment as (typeof SEGMENTS)[number])) {
      return c.json({ error: 'Invalid segment' }, 400);
    }
    const kind = normalizeString(c.req.query('kind'))?.toLowerCase();
    if (kind && !KINDS.includes(kind as (typeof KINDS)[number])) {
      return c.json({ error: 'Invalid kind' }, 400);
    }

    // `args_preview` can contain email bodies, recipients, URLs, and other
    // sensitive values. The broad `project.review.read` leaf may list the row,
    // but only the same human authority that can resolve the exact approval may
    // receive its parameters. New rows that race this query fail closed because
    // their execution id will not be present in this set.
    let isManager = false;
    try {
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
      );
      isManager = true;
    } catch {
      isManager = false;
    }
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
    const previewExecutionIds = new Set(
      pendingExecutions
        .filter((execution) => {
          const session = execution.sessionId
            ? sessionById.get(String(execution.sessionId))
            : undefined;
          return mayResolveApproval({
            isManager,
            targetSessionOrigin: session?.origin ?? (execution.sessionId ? null : 'user'),
            targetSessionCreatedBy:
              session?.createdBy ?? (execution.sessionId ? null : execution.actingUserId),
            callerUserId: loaded.userId,
            callerAuthType: (c.get('authType') as string | undefined) ?? null,
            callerSessionId: callerKortixSessionId(c),
          }).allowed;
        })
        .map((execution) => execution.executionId),
    );

    const items = await listInboxItems(projectId, {
      segment: segment as ReviewSegment | undefined,
      kind: kind as (typeof KINDS)[number] | undefined,
      canExposeConnectorCallPreview: (execution) => previewExecutionIds.has(execution.executionId),
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
    summary: 'GET /:projectId/review/items/:reviewItemId',
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
    const gate = requireFeatureFlag(c, loaded.row.metadata, 'review_center');
    if (gate) return gate;

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
    summary: 'POST /:projectId/review/items',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      201: json(AnyObject, 'The created review item'),
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const body = await readBody(c);
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
    const gate = requireFeatureFlag(c, loaded.row.metadata, 'review_center');
    if (gate) return gate;

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
    summary: 'POST /:projectId/review/items/:reviewItemId/act',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), reviewItemId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(AnyObject, 'The updated review item'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const reviewItemId = c.req.param('reviewItemId');
    const body = await readBody(c);
    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_REVIEW_ACT,
    );
    const gate = requireFeatureFlag(c, loaded.row.metadata, 'review_center');
    if (gate) return gate;

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
    summary: 'POST /:projectId/review/bulk',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.object({ updated: z.number(), review_items: z.array(AnyObject) }), 'Bulk result'),
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const body = await readBody(c);
    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_REVIEW_ACT,
    );
    const gate = requireFeatureFlag(c, loaded.row.metadata, 'review_center');
    if (gate) return gate;

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
