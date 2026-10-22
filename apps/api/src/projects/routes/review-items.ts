// ─── Review Center ──────────────────────────────────────────────────────────
// Per-project human-in-the-loop inbox. Agents submit outputs / decisions /
// batches for review; humans approve, reject, request changes, or answer. Native
// items only this pass — change requests and connector/tunnel approvals are folded
// in by adapters later.

import { createRoute, z } from '@hono/zod-openapi';
import { relayReviewCard } from '../../channels/turn-relay';
import { PROJECT_ACTIONS } from '../../iam';
import { assertAgentScope } from '../../iam/agent-scope';
import { auth, errors, json, lenientBody } from '../../openapi';
import { isUuid } from '../../shared/validate';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { approvalCallerOf } from '../lib/http-approval-caller';
import { loadVisibleSession } from '../lib/access';
import { projectReadView } from '../lib/project-read-view';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { normalizeString } from '../lib/serializers';
import { readJsonObject } from '../../shared/http-body';
import { inferAuditSource } from '../../shared/audit';
import { markApprovalCardDecided } from '../../channels/approval-card-relay';
import { isAdaptedId } from '../review-adapters';
import {
  REVIEW_PAGE_DEFAULT_LIMIT,
  REVIEW_PAGE_MAX_LIMIT,
  type ReviewSegment,
  BULK_MAX_IDS,
  applyVerdict,
  BULK_RESULT_CODES,
  bulkActReview,
  decodeInboxCursor,
  getInboxItem,
  getReviewItemById,
  insertReviewItem,
  isReviewVerdict,
  isSubmittableKind,
  listInboxItems,
  reviewSummary,
  serializeReviewItem,
} from '../review-items';

const KINDS = ['change', 'approval', 'output', 'decision', 'batch'] as const;
const RISKS = ['none', 'low', 'medium', 'high'] as const;
const SEGMENTS = ['needs_you', 'waiting', 'done'] as const;

export function registerReviewItemsRoutes(): void {
  // GET /v1/projects/:projectId/review/summary
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/review/summary',
      tags: ['review'],
      summary: 'Count the review items that need you',
      description:
        'How many review items wait on the caller (the Needs you segment of `GET /review/items`), in total and by originating session. Counts only: the always-mounted badges poll this, not the list.',
      ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
      responses: {
        200: json(
          z.object({
            needs_you_total: z.number().int(),
            needs_you_by_session: z.record(z.string(), z.number().int()),
          }),
          'Needs-you counts',
        ),
        ...errors(403, 404),
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
        PROJECT_ACTIONS.PROJECT_REVIEW_READ,
      );
      return c.json(
        await reviewSummary(
          projectId,
          () => approvalCallerOf(c, loaded, projectId),
          await projectReadView(c, loaded),
        ),
        200,
      );
    },
  );

  // GET /v1/projects/:projectId/review/items?segment=&kind=&session_id=&limit=&cursor=
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/review/items',
      tags: ['review'],
      summary: 'List review items (approvals and change requests)',
      description:
        'One page of the inbox: Needs you, then Waiting, then Done, newest first within each. `limit` defaults to 50; above 200 answers 400. Pass `next_cursor` back as `cursor` for the next page; `null` means the last page. A walk is not a snapshot: an item whose status changes between two pages can come back on a later page or be missed.',
      ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        query: z.object({}).passthrough(),
      },
      responses: {
        200: json(
          z.object({ review_items: z.array(AnyObject), next_cursor: z.string().nullable() }),
          'Review items',
        ),
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
      const sessionId = normalizeString(c.req.query('session_id'));
      if (sessionId && !isUuid(sessionId)) return c.json({ error: 'Invalid session_id' }, 400);
      // normalizeString answers null for an absent param: test nullish, or
      // Number(null) is 0 and every plain list is refused.
      const rawLimit = normalizeString(c.req.query('limit'));
      const limit = rawLimit == null ? REVIEW_PAGE_DEFAULT_LIMIT : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > REVIEW_PAGE_MAX_LIMIT) {
        return c.json({ error: `limit must be an integer from 1 to ${REVIEW_PAGE_MAX_LIMIT}` }, 400);
      }
      const rawCursor = normalizeString(c.req.query('cursor'));
      const after = rawCursor ? decodeInboxCursor(rawCursor) : null;
      if (rawCursor && !after) return c.json({ error: 'Invalid cursor' }, 400);

      const page = await listInboxItems(
        projectId,
        {
          segment: segment as ReviewSegment | undefined,
          kind: kind as (typeof KINDS)[number] | undefined,
          sessionId: sessionId ?? undefined,
          limit,
          after,
        },
        () => approvalCallerOf(c, loaded, projectId),
        await projectReadView(c, loaded),
      );
      return c.json({ review_items: page.items, next_cursor: page.nextCursor });
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

      // A native id, `cr:<cr_id>` or a pending `call:<execution_id>`, in the
      // list's shape: a link to an item does not depend on its page.
      const item = await getInboxItem(
        projectId,
        c.req.param('reviewItemId'),
        () => approvalCallerOf(c, loaded, projectId),
        await projectReadView(c, loaded),
      );
      if (!item) return c.json({ error: 'Review item not found' }, 404);
      return c.json({ review_item: item });
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

      // The origin session must be one the caller may open: an item raised
      // against another member's private session would surface there.
      const originSessionId: string | null = normalizeString(body.session_id ?? body.sessionId);
      if (
        originSessionId &&
        !(await loadVisibleSession(loaded, originSessionId, c.get('sessionId') ?? null, callerKortixSessionId(c)))
      ) {
        return c.json({ error: 'Session not found' }, 404);
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
      const loaded = await loadProjectForUser(c, projectId, 'read');
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
            ids: z.array(z.string()).openapi({ description: 'Review item ids (native, call:<execution_id>), at most 50. review_item_ids is accepted as an alias.' }),
            verdict: z.enum(['approve', 'reject', 'changes', 'answer', 'dismiss']).openapi({ description: 'Decision applied to every item.' }),
          }) } } },
      },
      responses: {
        200: json(
          z.object({
            updated: z.number(),
            review_items: z.array(AnyObject),
            results: z
              .array(z.object({ id: z.string(), ok: z.boolean(), code: z.enum(BULK_RESULT_CODES).optional() }))
              .openapi({ description: 'One entry per requested id, in request order.' }),
          }),
          'Bulk result',
        ),
        ...errors(400, 403, 404),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const body = await readJsonObject(c);
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);

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
      if (ids.length > BULK_MAX_IDS) {
        return c.json({ error: `ids may hold at most ${BULK_MAX_IDS} items` }, 400);
      }
      // Each source keeps its single-item authorization: native items need
      // project.review.act (as the act route); a connector call needs the
      // resolve rule (manager or launcher), checked per id.
      if (ids.some((id: string) => !isAdaptedId(id))) {
        await assertProjectCapability(
          c,
          loaded.userId,
          loaded.row.accountId,
          projectId,
          PROJECT_ACTIONS.PROJECT_REVIEW_ACT,
        );
      }

      const { rows, results } = await bulkActReview(ids, projectId, {
        verdict,
        accountId: loaded.row.accountId,
        caller: await approvalCallerOf(c, loaded, projectId),
        auditSource: inferAuditSource(c.get('authType'), 'human'),
        updateStaleCard: (row, decision) =>
          markApprovalCardDecided({ projectId, row, decision, note: '', actorUserId: loaded.userId }),
      });
      return c.json({ updated: rows.length, review_items: rows.map(serializeReviewItem), results });
    },
  );
}
