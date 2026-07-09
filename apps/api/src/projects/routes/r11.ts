// ─── Review Center ──────────────────────────────────────────────────────────
// Per-project human-in-the-loop inbox. Agents submit outputs / decisions /
// batches for review; humans approve, reject, request changes, or answer. Native
// items only this pass — change requests and executor/tunnel approvals are folded
// in by adapters later. See docs/REVIEW_CENTER_DESIGN.md.

import { randomUUID } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import { projectSessions } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { postReviewCard } from '../../channels/slack-webhook';
import { PROJECT_ACTIONS } from '../../iam';
import { assertAgentScope } from '../../iam/agent-scope';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { resolveExperimentalFeature } from '../../experimental/features';
import { commitExistsOnRemote, createKeepRef, deleteKeepRef } from '../git';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { withProjectGitAuth } from '../lib/git';
import { normalizeString, readBody } from '../lib/serializers';
import { buildSubmissionTrace } from '../lib/submission-trace';
import { isAdaptedId } from '../review-adapters';
import { parseOutputSubmissionDetail, submissionKeepRef } from '../submission-detail';
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
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_REVIEW_READ);

    const segment = normalizeString(c.req.query('segment'))?.toLowerCase();
    if (segment && !SEGMENTS.includes(segment as (typeof SEGMENTS)[number])) {
      return c.json({ error: 'Invalid segment' }, 400);
    }
    const kind = normalizeString(c.req.query('kind'))?.toLowerCase();
    if (kind && !KINDS.includes(kind as (typeof KINDS)[number])) {
      return c.json({ error: 'Invalid kind' }, 400);
    }

    const items = await listInboxItems(projectId, {
      segment: segment as ReviewSegment | undefined,
      kind: kind as (typeof KINDS)[number] | undefined,
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
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_REVIEW_READ);

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
      ...errors(400, 403, 404, 502),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const body = await readBody(c);
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Human gate: submitting a reviewable needs project.review.submit. Every
    // built-in role holds it; a custom role that unchecks it is denied here.
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_REVIEW_SUBMIT);
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

    // Structured work submissions (the `kortix submit` path — a
    // `submission_version` payload) are gated behind the per-project
    // `work_submission` experimental flag. Plain output/decision/batch review
    // items are unaffected (they belong to the Review Center's own surface).
    if (kind === 'output' && detail.submission_version !== undefined) {
      if (!resolveExperimentalFeature(loaded.row.metadata, 'work_submission')) {
        return c.json(
          {
            error:
              'Work submission is not enabled for this project. Enable it in Customize → Settings → Experimental (Work Submission).',
          },
          403,
        );
      }
    }

    // Session binding: the token's own session id (set on session executor
    // tokens by the auth middleware) is authoritative — a submission can't
    // claim a session it doesn't run in. The body's session_id is only a
    // fallback for non-session callers; both must resolve to a real session
    // in THIS project or they're dropped.
    const sessionCandidates = [
      normalizeString(c.get('sessionId')),
      normalizeString(body.session_id ?? body.sessionId),
    ].filter((v): v is string => Boolean(v));
    let originSessionId: string | null = null;
    for (const candidate of sessionCandidates) {
      const [sessionRow] = await db
        .select({ sessionId: projectSessions.sessionId })
        .from(projectSessions)
        .where(
          and(
            eq(projectSessions.sessionId, candidate),
            eq(projectSessions.projectId, projectId),
          ),
        )
        .limit(1);
      if (sessionRow) {
        originSessionId = sessionRow.sessionId;
        break;
      }
    }

    // Structured work submissions (kind: output) — validated payload, git
    // keep-ref pinning, and the server-stapled trace. Legacy free-form output
    // details pass through unchanged (minus the server-owned trace key).
    let finalDetail: Record<string, unknown> = detail;
    let reviewItemId: string | undefined;
    let keepRefCreated: string | null = null;
    if (kind === 'output') {
      const parsed = parseOutputSubmissionDetail(detail);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      if (parsed.structured && parsed.value.storage === 'git' && parsed.value.git) {
        const gitProject = await withProjectGitAuth(loaded.row);
        const sha = parsed.value.git.commit_sha;
        const exists = await commitExistsOnRemote(gitProject, sha).catch(() => false);
        if (!exists) {
          return c.json(
            { error: 'git.commit_sha not found on the project remote — push the commit before submitting' },
            400,
          );
        }
        reviewItemId = randomUUID();
        const keepRef = submissionKeepRef(reviewItemId);
        try {
          await createKeepRef(gitProject, sha, keepRef);
        } catch (error) {
          console.error('[review] keep-ref creation failed', {
            projectId,
            sha,
            keepRef,
            error: error instanceof Error ? error.message : String(error),
          });
          return c.json({ error: 'Could not pin the submission artifacts on the project remote' }, 502);
        }
        keepRefCreated = keepRef;
        parsed.value.git.keep_ref = keepRef;
      }
      finalDetail = { ...parsed.value };
      if (originSessionId) {
        const trace = await buildSubmissionTrace(projectId, originSessionId);
        if (trace) finalDetail.trace = trace;
      }
    }

    let row: Awaited<ReturnType<typeof insertReviewItem>>;
    try {
      row = await insertReviewItem({
        reviewItemId,
        accountId: loaded.row.accountId,
        projectId,
        kind,
        title,
        summary: normalizeString(body.summary) ?? '',
        risk: risk as (typeof RISKS)[number],
        detail: finalDetail,
        agent: normalizeString(body.agent) ?? '',
        originSessionId,
        createdBy: loaded.userId,
      });
    } catch (error) {
      // Don't strand a remote ref pointing at a submission that never existed.
      const strandedRef = keepRefCreated;
      if (strandedRef) {
        void withProjectGitAuth(loaded.row)
          .then((p) => deleteKeepRef(p, strandedRef))
          .catch(() => {});
      }
      throw error;
    }
    // If this was submitted from a live Slack session, post an actionable card
    // into that thread so a human can approve/deny it right there. Best-effort and
    // a no-op for web sessions (postReviewCard returns early when there's no live
    // Slack turn). Fire-and-forget so a slow Slack API never delays the 201.
    if (row.originSessionId) {
      void postReviewCard(row.originSessionId, {
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
      ...errors(400, 404, 409),
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

    const verdict = normalizeString(body.verdict);
    if (!isReviewVerdict(verdict)) {
      return c.json(
        { error: 'verdict must be one of approve, reject, changes, answer, dismiss' },
        400,
      );
    }
    // Adapted items (change requests, executor approvals) act through their own
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
      ...errors(400, 404),
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
