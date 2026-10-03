/**
 * Kortix Capture, project-scoped: `/v1/projects/:projectId/capture/*`.
 *
 * Scoping (captureAccess):
 *   - a person sees their OWN devices and timeline;
 *   - a project manager may read another member (`user_id=`) or the whole
 *     project (devices `scope=project`, people summary); every such read writes
 *     a `capture.member_view` / `capture.project_view` audit row;
 *   - an agent session reads the timeline of the human it acts for (private
 *     session, `on_behalf_of`), never anyone else: `capture.agent_read`;
 *   - a credential that acts for no person (trigger, service account, shared
 *     session) gets 403 `capture_no_human`.
 * Every route needs the project's `capture` flag (403 `feature_disabled`).
 * The queries live in reads.ts.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { requireFeatureFlag } from '../feature-flags/gate';
import { auth, errors, json } from '../openapi';
import { roleAllows } from '../projects/access';
import { loadProjectForUser } from '../projects/lib/access';
import { projectsApp } from '../projects/lib/app';
import { callerKortixSessionId } from '../projects/lib/caller-session';
import { getRequestOnBehalfOf } from '../projects/lib/on-behalf-of';
import { recordAuditEvent } from '../shared/audit';
import type { AppEnv } from '../types';
import { PolicySchema } from './format';
import { readProjectPolicy, writeDevicePolicy, writeProjectPolicy } from './policy';
import {
  assetUrl,
  chunkOf,
  closeRangeForReprocess,
  deviceInProject,
  deviceView,
  frameOf,
  listDevices,
  mediaUrl,
  peopleSummary,
  rangeInProject,
  rangeOutputsOf,
  rangeView,
  rangesFor,
  revokeDevice,
  saveRange,
  searchTimeline,
  sessionVisibility,
  timelineChunksIn,
  timelineItems,
  timelineRuns,
  type SearchKind,
} from './reads';
import { captureStoreConfigured } from './store';
import { enqueueRangeProcessing, pollDevice } from './workers';

type Ctx = Context<AppEnv>;
type Loaded = NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>;

interface Access {
  loaded: Loaded;
  projectId: string;
  accountId: string;
  /** The human the caller is (or acts for). */
  viewer: string;
  /** Whose data this request reads; null = the whole project (managers). */
  subject: string | null;
  manager: boolean;
  sessionId: string | null;
}

const refuse = <S extends 400 | 403 | 404 | 503>(c: Ctx, status: S, code: string, error: string) => c.json({ error, code }, status);

function auditRead(c: Ctx, access: Pick<Access, 'accountId' | 'projectId' | 'viewer' | 'sessionId'>, action: string, resourceId: string | null) {
  return recordAuditEvent({
    accountId: access.accountId,
    projectId: access.projectId,
    sessionId: access.sessionId,
    actorUserId: access.viewer,
    actorType: access.sessionId ? 'agent' : 'human',
    onBehalfOfUserId: access.sessionId ? access.viewer : null,
    action,
    resourceType: 'capture_member',
    resourceId,
    outcome: 'success',
    metadata: { path: c.req.path },
  });
}

async function captureAccess(c: Ctx, opts: { userId?: string | null; projectWide?: boolean } = {}): Promise<Access | Response> {
  const projectId = c.req.param('projectId') ?? '';
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const gate = requireFeatureFlag(c, loaded.row.metadata, 'capture');
  if (gate) return gate;
  const sessionId = callerKortixSessionId(c);
  const authType = c.get('authType') as string | undefined;
  let viewer: string | null = null;
  if (sessionId) {
    // An agent session acts for the person who started it, only in a private session.
    const onBehalf = getRequestOnBehalfOf(c);
    if (onBehalf && (await sessionVisibility(sessionId, projectId)) === 'private') viewer = onBehalf;
  } else if (authType === 'supabase' || authType === 'pat' || authType === 'oauth') {
    viewer = loaded.userId;
  }
  if (!viewer) return refuse(c, 403, 'capture_no_human', 'This credential does not act for a person, so it has no capture timeline');
  const manager = !sessionId && roleAllows(loaded.effectiveRole, 'manage');
  const subject = opts.projectWide ? null : (opts.userId ?? viewer);
  const access: Access = { loaded, projectId, accountId: loaded.row.accountId, viewer, subject, manager, sessionId };
  if (subject !== viewer) {
    if (!manager) return refuse(c, 403, 'capture_forbidden', 'Only a project manager can read another member’s capture data');
    await auditRead(c, access, subject ? 'capture.member_view' : 'capture.project_view', subject);
  } else if (sessionId) {
    await auditRead(c, access, 'capture.agent_read', viewer);
  }
  return access;
}

const isResponse = (value: unknown): value is Response => value instanceof Response;

/** `[from, to)` from `day=YYYY-MM-DD` (UTC) or `from`/`to` ISO instants; default today. */
function window(c: Ctx): { from: Date; to: Date } | null {
  const day = c.req.query('day');
  if (day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    const from = new Date(`${day}T00:00:00.000Z`);
    return Number.isNaN(from.getTime()) ? null : { from, to: new Date(from.getTime() + 86_400_000) };
  }
  const fromRaw = c.req.query('from');
  const toRaw = c.req.query('to');
  const from = fromRaw ? new Date(fromRaw) : new Date(new Date().setUTCHours(0, 0, 0, 0));
  const to = toRaw ? new Date(toRaw) : new Date(from.getTime() + 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return null;
  if (to.getTime() - from.getTime() > 31 * 86_400_000) return null;
  return { from, to };
}
const BAD_WINDOW = 'Give day=YYYY-MM-DD, or from/to ISO instants at most 31 days apart';

/** A device of this project the caller may act on. Someone else's device is "not found" to a member. */
async function loadDevice(access: Access, deviceId: string) {
  const device = await deviceInProject(access.projectId, deviceId);
  if (!device || (device.userId !== access.viewer && !access.manager)) return null;
  return device;
}

const params = z.object({ projectId: z.string().uuid() });
const ok = (description: string) => ({ 200: json(z.any(), description), ...errors(400, 403, 404) });
const tags = ['capture'];
const subjectQuery = z.object({
  user_id: z.string().uuid().optional(),
  device_id: z.string().uuid().optional(),
  day: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

// ─── Devices ─────────────────────────────────────────────────────────────────

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/capture/devices',
    tags,
    summary: 'Capture devices with live status: yours, a member’s (managers), or the project’s (managers, scope=project)',
    ...auth,
    request: { params, query: z.object({ user_id: z.string().uuid().optional(), scope: z.enum(['mine', 'project']).optional() }) },
    responses: ok('The devices'),
  }),
  async (c) => {
    const query = c.req.valid('query');
    const access = await captureAccess(c, { userId: query.user_id, projectWide: query.scope === 'project' });
    if (isResponse(access)) return access as never;
    return c.json({ devices: (await listDevices(access.projectId, access.subject)).map((d) => deviceView(d)) }, 200);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/capture/devices/{deviceId}',
    tags,
    summary: 'Revoke a capture device: its token stops working and it can no longer get credentials',
    ...auth,
    request: { params: params.extend({ deviceId: z.string().uuid() }) },
    responses: ok('The revoked device'),
  }),
  async (c) => {
    const access = await captureAccess(c);
    if (isResponse(access)) return access as never;
    if (access.sessionId) return refuse(c, 403, 'capture_forbidden', 'An agent cannot revoke a capture device');
    const device = await loadDevice(access, c.req.valid('param').deviceId);
    if (!device) return c.json({ error: 'Not found' }, 404);
    return c.json(deviceView(await revokeDevice(device.deviceId, access.viewer)), 200);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/capture/devices/{deviceId}/sync',
    tags,
    summary: 'Read a device’s status, description and index now, queue every new item for indexing, and retract every item the device deleted',
    ...auth,
    request: { params: params.extend({ deviceId: z.string().uuid() }) },
    responses: { ...ok('The number of items queued and the number retracted'), ...errors(503) },
  }),
  async (c) => {
    const access = await captureAccess(c);
    if (isResponse(access)) return access as never;
    if (!captureStoreConfigured()) return refuse(c, 503, 'capture_store_unavailable', 'No capture store is configured');
    const device = await loadDevice(access, c.req.valid('param').deviceId);
    if (!device || device.revokedAt) return c.json({ error: 'Not found' }, 404);
    const { enqueued, forgotten } = await pollDevice(device);
    return c.json({ device_id: device.deviceId, enqueued, forgotten }, 200);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/capture/devices/{deviceId}/assets/{name}',
    tags,
    summary: 'A signed, short-lived URL of one content-addressed asset (action screenshot, icon)',
    ...auth,
    request: { params: params.extend({ deviceId: z.string().uuid(), name: z.string() }) },
    responses: { ...ok('The URL'), ...errors(503) },
  }),
  async (c) => {
    const { deviceId, name } = c.req.valid('param');
    if (!/^(sha256-)?[0-9a-f]{64}\.[a-z0-9]{1,8}$/.test(name)) return refuse(c, 400, 'capture_bad_asset', 'Asset names are sha256-<hex>.<ext>');
    const access = await captureAccess(c);
    if (isResponse(access)) return access as never;
    const device = await loadDevice(access, deviceId);
    if (!device) return c.json({ error: 'Not found' }, 404);
    if (device.userId !== access.viewer) await auditRead(c, access, 'capture.member_view', device.userId);
    if (!captureStoreConfigured()) return refuse(c, 503, 'capture_store_unavailable', 'No capture store is configured');
    return c.json(await assetUrl(access.accountId, access.projectId, device.deviceId, name), 200);
  },
);

// ─── Policy ──────────────────────────────────────────────────────────────────

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/capture/policy',
    tags,
    summary: 'The project capture policy (layers, privacy, retention, pause, notice)',
    ...auth,
    request: { params },
    responses: ok('The policy'),
  }),
  async (c) => {
    const access = await captureAccess(c);
    if (isResponse(access)) return access as never;
    return c.json(await readProjectPolicy(access.projectId), 200);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/capture/policy',
    tags,
    summary: 'Set the project capture policy (managers); publishes <prefix>/policy.json',
    ...auth,
    request: { params, body: { content: { 'application/json': { schema: z.object({ policy: z.record(z.string(), z.any()) }) } } } },
    responses: { ...ok('The stored policy'), ...errors(503) },
  }),
  async (c) => {
    const access = await captureAccess(c);
    if (isResponse(access)) return access as never;
    if (!access.manager) return refuse(c, 403, 'capture_forbidden', 'Only a project manager can change the capture policy');
    if (!captureStoreConfigured()) return refuse(c, 503, 'capture_store_unavailable', 'No capture store is configured');
    const parsed = PolicySchema.safeParse(c.req.valid('json').policy);
    if (!parsed.success) return refuse(c, 400, 'capture_policy_invalid', parsed.error.issues[0]?.message ?? 'Invalid policy');
    return c.json(await writeProjectPolicy(access, parsed.data, access.viewer), 200);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/capture/devices/{deviceId}/policy',
    tags,
    summary: 'Set or clear (null) one device’s policy override (managers); publishes <prefix>/<device_id>/policy.json',
    ...auth,
    request: {
      params: params.extend({ deviceId: z.string().uuid() }),
      body: { content: { 'application/json': { schema: z.object({ policy: z.record(z.string(), z.any()).nullable() }) } } },
    },
    responses: { ...ok('The device'), ...errors(503) },
  }),
  async (c) => {
    const access = await captureAccess(c);
    if (isResponse(access)) return access as never;
    if (!access.manager) return refuse(c, 403, 'capture_forbidden', 'Only a project manager can change a device policy');
    if (!captureStoreConfigured()) return refuse(c, 503, 'capture_store_unavailable', 'No capture store is configured');
    const device = await loadDevice(access, c.req.valid('param').deviceId);
    if (!device) return c.json({ error: 'Not found' }, 404);
    const raw = c.req.valid('json').policy;
    const parsed = raw === null ? null : PolicySchema.safeParse(raw);
    if (parsed && !parsed.success) return refuse(c, 400, 'capture_policy_invalid', parsed.error.issues[0]?.message ?? 'Invalid policy');
    await writeDevicePolicy(access, device.deviceId, parsed ? parsed.data : null);
    return c.json(deviceView((await deviceInProject(access.projectId, device.deviceId))!), 200);
  },
);

// ─── Timeline ────────────────────────────────────────────────────────────────

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/capture/timeline',
    tags,
    summary: 'One person’s timeline for a day or window: activity runs (app + window), indexed items, and ranges',
    ...auth,
    request: { params, query: subjectQuery },
    responses: ok('The timeline'),
  }),
  async (c) => {
    const query = c.req.valid('query');
    const access = await captureAccess(c, { userId: query.user_id });
    if (isResponse(access)) return access as never;
    const span = window(c);
    if (!span) return refuse(c, 400, 'capture_bad_window', BAD_WINDOW);
    const subject = access.subject!;
    const [runs, chunks, ranges] = await Promise.all([
      timelineRuns(access.projectId, subject, span, query.device_id),
      timelineChunksIn(access.projectId, subject, span, query.device_id),
      rangesFor(access.projectId, subject, span),
    ]);
    return c.json({ user_id: subject, from: span.from.toISOString(), to: span.to.toISOString(), runs, chunks, ranges }, 200);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/capture/timeline/items',
    tags,
    summary: 'Frames, actions and audio lines of one person in a window (at most 500 of each, oldest first)',
    ...auth,
    request: { params, query: subjectQuery },
    responses: ok('The items'),
  }),
  async (c) => {
    const query = c.req.valid('query');
    const access = await captureAccess(c, { userId: query.user_id });
    if (isResponse(access)) return access as never;
    const span = window(c);
    if (!span) return refuse(c, 400, 'capture_bad_window', BAD_WINDOW);
    const items = await timelineItems(access.projectId, access.subject!, span, query.device_id);
    return c.json({ user_id: access.subject, from: span.from.toISOString(), to: span.to.toISOString(), ...items }, 200);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/capture/search',
    tags,
    summary: 'Full-text search of one person’s timeline: screen (app, window, URL, on-screen text; one hit per chunk and window), actions and audio',
    ...auth,
    request: {
      params,
      query: subjectQuery.extend({
        q: z.string().min(1),
        kinds: z.string().optional().describe('Comma list of screen, actions, audio (default all)'),
        app: z.string().optional(),
        limit: z.string().optional(),
      }),
    },
    responses: ok('Hits, newest first'),
  }),
  async (c) => {
    const query = c.req.valid('query');
    const access = await captureAccess(c, { userId: query.user_id });
    if (isResponse(access)) return access as never;
    const q = query.q.trim().slice(0, 500);
    if (!q) return refuse(c, 400, 'capture_bad_query', 'q is required');
    const from = query.from ? new Date(query.from) : new Date(0);
    const to = query.to ? new Date(query.to) : new Date(Date.now() + 86_400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return refuse(c, 400, 'capture_bad_window', 'from/to must be ISO instants');
    const kinds = new Set((query.kinds ?? 'screen,actions,audio').split(',').map((k) => k.trim())) as Set<SearchKind>;
    if (!(['screen', 'actions', 'audio'] as const).some((k) => kinds.has(k))) {
      return refuse(c, 400, 'capture_bad_query', 'kinds must name screen, actions or audio');
    }
    const limit = Math.min(Math.max(Number(query.limit ?? 20) || 20, 1), 100);
    const hits = await searchTimeline(access.projectId, access.subject!, { q, from, to, kinds, app: query.app, deviceId: query.device_id, limit });
    return c.json({ user_id: access.subject, q, hits }, 200);
  },
);

// ─── Media ───────────────────────────────────────────────────────────────────

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/capture/frames/{frameId}',
    tags,
    summary: 'One frame with its full on-screen text and a signed, short-lived URL of its video chunk',
    ...auth,
    request: { params: params.extend({ frameId: z.string().uuid() }), query: z.object({ user_id: z.string().uuid().optional() }) },
    responses: ok('The frame'),
  }),
  async (c) => {
    const access = await captureAccess(c, { userId: c.req.valid('query').user_id });
    if (isResponse(access)) return access as never;
    const found = await frameOf(access.projectId, access.subject!, c.req.valid('param').frameId);
    if (!found) return c.json({ error: 'Not found' }, 404);
    const video = found.chunk ? await mediaUrl(found.chunk, 'video') : null;
    const offset = found.chunk ? new Date(found.frame.ts as string).getTime() - found.chunk.startAt.getTime() : 0;
    return c.json({ frame: found.frame, video: video && { ...video, offset_ms: offset } }, 200);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/capture/chunks/{chunkId}/media',
    tags,
    summary: 'Signed, short-lived URLs of an indexed item’s media (video or audio)',
    ...auth,
    request: { params: params.extend({ chunkId: z.string().uuid() }), query: z.object({ user_id: z.string().uuid().optional() }) },
    responses: ok('The URLs'),
  }),
  async (c) => {
    const access = await captureAccess(c, { userId: c.req.valid('query').user_id });
    if (isResponse(access)) return access as never;
    const chunk = await chunkOf(access.projectId, access.subject!, c.req.valid('param').chunkId);
    if (!chunk) return c.json({ error: 'Not found' }, 404);
    return c.json({ chunk_id: chunk.chunkId, kind: chunk.kind, video: await mediaUrl(chunk, 'video'), audio: await mediaUrl(chunk, 'audio') }, 200);
  },
);

// ─── Ranges ──────────────────────────────────────────────────────────────────

/** A range of this project the caller may read. Another member's is audited for managers, "not found" otherwise. */
async function loadRange(c: Ctx, access: Access, rangeId: string) {
  const range = await rangeInProject(access.projectId, rangeId);
  if (!range) return null;
  if (range.userId !== access.viewer) {
    if (!access.manager) return null;
    await auditRead(c, access, 'capture.member_view', range.userId);
  }
  return range;
}

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/capture/ranges',
    tags,
    summary: 'One person’s ranges (detected activity sessions and saved spans) in a window',
    ...auth,
    request: { params, query: subjectQuery },
    responses: ok('The ranges'),
  }),
  async (c) => {
    const access = await captureAccess(c, { userId: c.req.valid('query').user_id });
    if (isResponse(access)) return access as never;
    const span = window(c);
    if (!span) return refuse(c, 400, 'capture_bad_window', BAD_WINDOW);
    return c.json({ ranges: await rangesFor(access.projectId, access.subject!, span) }, 200);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/capture/ranges',
    tags,
    summary: 'Save a span of your own timeline as a range and process it',
    ...auth,
    request: {
      params,
      body: {
        content: {
          'application/json': {
            schema: z.object({ start_at: z.string(), end_at: z.string(), title: z.string().max(200).optional(), device_id: z.string().uuid().optional() }),
          },
        },
      },
    },
    responses: { 201: json(z.any(), 'The saved range'), ...errors(400, 403, 404) },
  }),
  async (c) => {
    const access = await captureAccess(c);
    if (isResponse(access)) return access as never;
    const body = c.req.valid('json');
    const startAt = new Date(body.start_at);
    const endAt = new Date(body.end_at);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || endAt <= startAt || endAt.getTime() - startAt.getTime() > 24 * 3_600_000) {
      return refuse(c, 400, 'capture_bad_window', 'start_at < end_at, at most 24 hours apart');
    }
    if (body.device_id) {
      const device = await loadDevice(access, body.device_id);
      if (!device || device.userId !== access.viewer) return c.json({ error: 'Not found' }, 404);
    }
    const range = await saveRange({
      accountId: access.accountId,
      projectId: access.projectId,
      userId: access.viewer,
      deviceId: body.device_id ?? null,
      title: body.title?.trim() || null,
      startAt,
      endAt,
    });
    await enqueueRangeProcessing(range);
    return c.json(rangeView(range), 201);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/capture/ranges/{rangeId}',
    tags,
    summary: 'One range with its processing outputs (segmentation, transcript, annotation)',
    ...auth,
    request: { params: params.extend({ rangeId: z.string().uuid() }) },
    responses: ok('The range'),
  }),
  async (c) => {
    const access = await captureAccess(c);
    if (isResponse(access)) return access as never;
    const range = await loadRange(c, access, c.req.valid('param').rangeId);
    if (!range) return c.json({ error: 'Not found' }, 404);
    return c.json({ ...rangeView(range), outputs: await rangeOutputsOf(range.rangeId) }, 200);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/capture/ranges/{rangeId}/process',
    tags,
    summary: 'Run the range pipelines again',
    ...auth,
    request: { params: params.extend({ rangeId: z.string().uuid() }) },
    responses: { 202: json(z.any(), 'Queued'), ...errors(403, 404) },
  }),
  async (c) => {
    const access = await captureAccess(c);
    if (isResponse(access)) return access as never;
    if (access.sessionId) return refuse(c, 403, 'capture_forbidden', 'An agent cannot start range processing');
    const range = await loadRange(c, access, c.req.valid('param').rangeId);
    if (!range) return c.json({ error: 'Not found' }, 404);
    await closeRangeForReprocess(range.rangeId);
    const queued = await enqueueRangeProcessing(range, `:rerun-${Date.now()}`);
    return c.json({ range_id: range.rangeId, queued }, 202);
  },
);

// ─── People (managers) ───────────────────────────────────────────────────────

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/capture/people',
    tags,
    summary: 'Per member: active time, time per app, ranges and devices in a window (project managers)',
    ...auth,
    request: { params, query: z.object({ day: z.string().optional(), from: z.string().optional(), to: z.string().optional() }) },
    responses: ok('The summary'),
  }),
  async (c) => {
    const access = await captureAccess(c, { projectWide: true });
    if (isResponse(access)) return access as never;
    const span = window(c);
    if (!span) return refuse(c, 400, 'capture_bad_window', BAD_WINDOW);
    return c.json({ from: span.from.toISOString(), to: span.to.toISOString(), people: await peopleSummary(access.projectId, span) }, 200);
  },
);
