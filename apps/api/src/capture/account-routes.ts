/**
 * Kortix Capture, account-scoped: `/v1/accounts/:accountId/capture/*`. The
 * Kortix account (organization) is Capture's tenant; there is no project in
 * Capture's model.
 *
 * Roles (workspace.ts): `admin` reads every member's devices and timeline and
 * writes the policy, the members and the switch; `viewer` reads everyone and
 * writes nothing; `member` reads only their own. A read of another member's
 * data writes `capture.member_view`; an account-wide read (devices
 * `scope=account`, people) writes `capture.account_view`.
 *
 * Agents: the agent tool reads through `/v1/capture/me/{timeline,search,frames}`
 * (registerCaptureAgentRoutes), bound to the token's own account and to the
 * person its private session acts for (`capture.agent_read`). A credential that
 * acts for no person (trigger, service account, shared session) gets 403
 * `capture_no_human`.
 *
 * Every route except the workspace switch answers 403 `capture_disabled` while
 * Capture is off for the account. The queries live in reads.ts.
 */
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { accountsRouter } from '../accounts/core/app';
import { accountRoleFor } from '../iam/read-models';
import { auth, errors, json } from '../openapi';
import { callerKortixSessionId } from '../projects/lib/caller-session';
import { getRequestOnBehalfOf } from '../projects/lib/on-behalf-of';
import { supabaseAuth } from '../middleware/auth';
import { recordAuditEvent } from '../shared/audit';
import type { AppEnv } from '../types';
import { PolicySchema } from './format';
import { readAccountPolicy, writeAccountPolicy, writeDevicePolicy } from './policy';
import {
  assetUrl,
  chunkOf,
  closeRangeForReprocess,
  deviceInAccount,
  deviceView,
  frameOf,
  frameVideoOffsetMs,
  listDevices,
  mediaUrl,
  peopleSummary,
  rangeInAccount,
  rangeOutputsOf,
  rangeView,
  rangesFor,
  recordedDays,
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
import {
  CAPTURE_ROLES,
  captureRole,
  listCaptureMembers,
  readWorkspace,
  readsEveryone,
  setCaptureEnabled,
  setCaptureMemberRole,
  type CaptureRole,
} from './workspace';

export type Ctx = Context<AppEnv>;

export interface Access {
  accountId: string;
  /** The human the caller is (or acts for). */
  viewer: string;
  /** Whose data this request reads; null = the whole account (admins, viewers). */
  subject: string | null;
  role: CaptureRole;
  /** True for a role that reads other members (admin, viewer); never for an agent. */
  readsAll: boolean;
  sessionId: string | null;
}

export const CAPTURE_DISABLED = { error: 'Capture is off for this account', code: 'capture_disabled' } as const;

export const refuse = <S extends 400 | 403 | 404 | 503>(c: Ctx, status: S, code: string, error: string) => c.json({ error, code }, status);

export function auditRead(c: Ctx, access: Pick<Access, 'accountId' | 'viewer' | 'sessionId'>, action: string, resourceId: string | null) {
  return recordAuditEvent({
    accountId: access.accountId,
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

/** The person the caller is or acts for, or null (an agent without a person, a service account). */
async function viewerOf(c: Ctx, accountId: string): Promise<{ viewer: string | null; sessionId: string | null } | 'wrong_account'> {
  const sessionId = callerKortixSessionId(c);
  const authType = c.get('authType') as string | undefined;
  if (sessionId) {
    // An agent session reads only inside its own account, for the person it acts for, in a private session.
    if (c.get('accountId') !== accountId) return 'wrong_account';
    const onBehalf = getRequestOnBehalfOf(c);
    const viewer = onBehalf && (await sessionVisibility(sessionId)) === 'private' ? onBehalf : null;
    return { viewer, sessionId };
  }
  if (authType === 'supabase' || authType === 'pat' || authType === 'oauth') {
    return { viewer: (c.get('userId') as string | undefined) ?? null, sessionId: null };
  }
  return { viewer: null, sessionId: null };
}

export async function captureAccessFor(
  c: Ctx,
  accountId: string,
  opts: { userId?: string | null; accountWide?: boolean } = {},
): Promise<Access | Response> {
  const who = await viewerOf(c, accountId);
  if (who === 'wrong_account') return c.json({ error: 'Not found' }, 404);
  const { viewer, sessionId } = who;
  if (!viewer) return refuse(c, 403, 'capture_no_human', 'This credential does not act for a person, so it has no capture timeline');
  const role = await captureRole(accountId, viewer);
  if (!role) return c.json({ error: 'Not found' }, 404);
  if (!(await readWorkspace(accountId)).enabled) return c.json(CAPTURE_DISABLED, 403);
  const readsAll = !sessionId && readsEveryone(role);
  const subject = opts.accountWide ? null : (opts.userId ?? viewer);
  const access: Access = { accountId, viewer, subject, role, readsAll, sessionId };
  if (subject !== viewer) {
    if (!readsAll) return refuse(c, 403, 'capture_forbidden', 'Only a Capture admin or viewer can read another member’s capture data');
    await auditRead(c, access, subject ? 'capture.member_view' : 'capture.account_view', subject);
  } else if (sessionId) {
    await auditRead(c, access, 'capture.agent_read', viewer);
  }
  return access;
}

/** Access for an account route: the account is the `:accountId` path segment. */
export function captureAccess(c: Ctx, opts: { userId?: string | null; accountWide?: boolean } = {}) {
  return captureAccessFor(c, c.req.param('accountId') ?? '', opts);
}

export const isResponse = (value: unknown): value is Response => value instanceof Response;

/** `[from, to)` from `day=YYYY-MM-DD` (UTC) or `from`/`to` ISO instants; default today. */
export function window(c: Ctx): { from: Date; to: Date } | null {
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
export const BAD_WINDOW = 'Give day=YYYY-MM-DD, or from/to ISO instants at most 31 days apart';

/**
 * A device of this account the caller may act on. Someone else's device is
 * "not found" to a member; `write` (revoke) also needs the admin role for
 * another person's device.
 */
async function loadDevice(access: Access, deviceId: string, opts: { write?: boolean } = {}) {
  const device = await deviceInAccount(access.accountId, deviceId);
  if (!device) return null;
  if (device.userId !== access.viewer && (!access.readsAll || (opts.write && access.role !== 'admin'))) return null;
  return device;
}

const params = z.object({ accountId: z.string().uuid() });
const ok = (description: string) => ({ 200: json(z.any(), description), ...errors(400, 403, 404) });
const tags = ['capture'];
const subjectQuery = z.object({
  user_id: z.string().uuid().optional(),
  device_id: z.string().uuid().optional(),
  day: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
const searchQuery = subjectQuery.extend({
  q: z.string().min(1),
  kinds: z.string().optional().describe('Comma list of screen, actions, audio (default all)'),
  app: z.string().optional(),
  limit: z.string().optional(),
});

// ─── Shared read handlers (the account routes and the agent's /v1/capture/me) ─

async function timelineResponse(c: Ctx, access: Access, deviceId?: string) {
    const span = window(c);
    if (!span) return refuse(c, 400, 'capture_bad_window', BAD_WINDOW);
    const subject = access.subject!;
    const [runs, chunks, ranges] = await Promise.all([
      timelineRuns(access.accountId, subject, span, deviceId),
      timelineChunksIn(access.accountId, subject, span, deviceId),
      rangesFor(access.accountId, subject, span),
    ]);
    return c.json({ user_id: subject, from: span.from.toISOString(), to: span.to.toISOString(), runs, chunks, ranges }, 200);
}

interface SearchQuery {
  q: string;
  kinds?: string;
  app?: string;
  limit?: string;
  from?: string;
  to?: string;
  device_id?: string;
}

async function searchResponse(c: Ctx, access: Access, query: SearchQuery) {
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
    const hits = await searchTimeline(access.accountId, access.subject!, { q, from, to, kinds, app: query.app, deviceId: query.device_id, limit });
    return c.json({ user_id: access.subject, q, hits }, 200);
}

async function frameResponse(c: Ctx, access: Access, frameId: string) {
    const found = await frameOf(access.accountId, access.subject!, frameId);
    if (!found) return c.json({ error: 'Not found' }, 404);
    const video = found.chunk ? await mediaUrl(found.chunk, 'video') : null;
    const offset = await frameVideoOffsetMs(found.frame);
    return c.json({ frame: found.frame, video: video && { ...video, offset_ms: offset } }, 200);
}

// ─── Workspace: the account switch, your role, the members ──────────────────

export function registerCaptureRoutes() {
accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/capture',
    tags,
    summary: 'The account’s Capture workspace: on or off, your Capture role, and whether you may turn it on',
    ...auth,
    request: { params },
    responses: ok('The workspace'),
  }),
  async (c) => {
    const { accountId } = c.req.valid('param');
    const who = await viewerOf(c, accountId);
    if (who === 'wrong_account' || !who.viewer) return c.json({ error: 'Not found' }, 404);
    const role = await captureRole(accountId, who.viewer);
    if (!role) return c.json({ error: 'Not found' }, 404);
    const accountRole = await accountRoleFor(accountId, who.viewer);
    const workspace = await readWorkspace(accountId);
    return c.json(
      {
        account_id: accountId,
        enabled: workspace.enabled,
        role,
        can_manage: !who.sessionId && (accountRole === 'owner' || accountRole === 'admin'),
        updated_at: workspace.updatedAt?.toISOString() ?? null,
      },
      200,
    );
  },
);

accountsRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/{accountId}/capture',
    tags,
    summary: 'Turn Capture on or off for the account (account owners and admins)',
    ...auth,
    request: { params, body: { content: { 'application/json': { schema: z.object({ enabled: z.boolean() }) } } } },
    responses: ok('The workspace'),
  }),
  async (c) => {
    const { accountId } = c.req.valid('param');
    const who = await viewerOf(c, accountId);
    if (who === 'wrong_account' || !who.viewer) return c.json({ error: 'Not found' }, 404);
    if (who.sessionId) return refuse(c, 403, 'capture_forbidden', 'An agent cannot turn Capture on or off');
    const accountRole = await accountRoleFor(accountId, who.viewer);
    if (!accountRole) return c.json({ error: 'Not found' }, 404);
    if (accountRole !== 'owner' && accountRole !== 'admin') {
      return refuse(c, 403, 'capture_forbidden', 'Only an account owner or admin can turn Capture on or off');
    }
    const { enabled } = c.req.valid('json');
    const workspace = await setCaptureEnabled(accountId, enabled, who.viewer);
    await recordAuditEvent({
      accountId,
      actorUserId: who.viewer,
      actorType: 'human',
      action: enabled ? 'capture.enable' : 'capture.disable',
      resourceType: 'capture_workspace',
      resourceId: accountId,
      outcome: 'success',
      metadata: { path: c.req.path },
    });
    return c.json(
      {
        account_id: accountId,
        enabled: workspace.enabled,
        role: (await captureRole(accountId, who.viewer))!,
        can_manage: true,
        updated_at: workspace.updatedAt?.toISOString() ?? null,
      },
      200,
    );
  },
);

accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/capture/members',
    tags,
    summary: 'Every account member with their Capture role (Capture admins)',
    ...auth,
    request: { params },
    responses: ok('The members'),
  }),
  async (c) => {
    const access = await captureAccess(c, { accountWide: true });
    if (isResponse(access)) return access as never;
    if (access.role !== 'admin') return refuse(c, 403, 'capture_forbidden', 'Only a Capture admin can list the Capture roles');
    return c.json({ members: await listCaptureMembers(access.accountId) }, 200);
  },
);

accountsRouter.openapi(
  createRoute({
    method: 'put',
    path: '/{accountId}/capture/members/{userId}',
    tags,
    summary: 'Set a member’s Capture role (admin, viewer, member), or clear it (null) back to the account-role default (Capture admins)',
    ...auth,
    request: {
      params: params.extend({ userId: z.string().uuid() }),
      body: { content: { 'application/json': { schema: z.object({ role: z.enum(['admin', 'viewer', 'member']).nullable() }) } } },
    },
    responses: ok('The member'),
  }),
  async (c) => {
    const access = await captureAccess(c, { accountWide: true });
    if (isResponse(access)) return access as never;
    if (access.role !== 'admin') return refuse(c, 403, 'capture_forbidden', 'Only a Capture admin can change a Capture role');
    const { userId } = c.req.valid('param');
    if (!(await accountRoleFor(access.accountId, userId))) return c.json({ error: 'Not found' }, 404);
    const { role } = c.req.valid('json');
    if (role !== null && !CAPTURE_ROLES.includes(role)) return refuse(c, 400, 'capture_bad_role', 'role is admin, viewer, member or null');
    if (userId === access.viewer && role !== null && role !== 'admin') {
      return refuse(c, 400, 'capture_bad_role', 'You cannot take your own admin role; ask another Capture admin');
    }
    await setCaptureMemberRole(access.accountId, userId, role, access.viewer);
    await recordAuditEvent({
      accountId: access.accountId,
      actorUserId: access.viewer,
      actorType: 'human',
      action: 'capture.member_role',
      resourceType: 'capture_member',
      resourceId: userId,
      outcome: 'success',
      metadata: { path: c.req.path, role },
    });
    const member = (await listCaptureMembers(access.accountId)).find((m) => m.user_id === userId)!;
    return c.json(member, 200);
  },
);

// ─── Devices ─────────────────────────────────────────────────────────────────

accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/capture/devices',
    tags,
    summary: 'Capture devices with live status: yours, a member’s (admins, viewers), or the account’s (admins, viewers, scope=account)',
    ...auth,
    request: { params, query: z.object({ user_id: z.string().uuid().optional(), scope: z.enum(['mine', 'account']).optional() }) },
    responses: ok('The devices'),
  }),
  async (c) => {
    const query = c.req.valid('query');
    const access = await captureAccess(c, { userId: query.user_id, accountWide: query.scope === 'account' });
    if (isResponse(access)) return access as never;
    return c.json({ devices: (await listDevices(access.accountId, access.subject)).map((d) => deviceView(d)) }, 200);
  },
);

accountsRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/{accountId}/capture/devices/{deviceId}',
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
    const device = await loadDevice(access, c.req.valid('param').deviceId, { write: true });
    if (!device) return c.json({ error: 'Not found' }, 404);
    return c.json(deviceView(await revokeDevice(device.deviceId, access.viewer)), 200);
  },
);

accountsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/capture/devices/{deviceId}/sync',
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

accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/capture/devices/{deviceId}/assets/{name}',
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
    return c.json(await assetUrl(access.accountId, device.deviceId, name), 200);
  },
);

// ─── Policy ──────────────────────────────────────────────────────────────────

accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/capture/policy',
    tags,
    summary: 'The account capture policy (layers, privacy, retention, pause, notice)',
    ...auth,
    request: { params },
    responses: ok('The policy'),
  }),
  async (c) => {
    const access = await captureAccess(c);
    if (isResponse(access)) return access as never;
    return c.json(await readAccountPolicy(access.accountId), 200);
  },
);

accountsRouter.openapi(
  createRoute({
    method: 'put',
    path: '/{accountId}/capture/policy',
    tags,
    summary: 'Set the account capture policy (Capture admins); publishes orgs/<account_id>/policy.json',
    ...auth,
    request: { params, body: { content: { 'application/json': { schema: z.object({ policy: z.record(z.string(), z.any()) }) } } } },
    responses: { ...ok('The stored policy'), ...errors(503) },
  }),
  async (c) => {
    const access = await captureAccess(c);
    if (isResponse(access)) return access as never;
    if (access.role !== 'admin') return refuse(c, 403, 'capture_forbidden', 'Only a Capture admin can change the capture policy');
    if (!captureStoreConfigured()) return refuse(c, 503, 'capture_store_unavailable', 'No capture store is configured');
    const parsed = PolicySchema.safeParse(c.req.valid('json').policy);
    if (!parsed.success) return refuse(c, 400, 'capture_policy_invalid', parsed.error.issues[0]?.message ?? 'Invalid policy');
    return c.json(await writeAccountPolicy(access.accountId, parsed.data, access.viewer), 200);
  },
);

accountsRouter.openapi(
  createRoute({
    method: 'put',
    path: '/{accountId}/capture/devices/{deviceId}/policy',
    tags,
    summary: 'Set or clear (null) one device’s policy override (Capture admins); publishes orgs/<account_id>/<device_id>/policy.json',
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
    if (access.role !== 'admin') return refuse(c, 403, 'capture_forbidden', 'Only a Capture admin can change a device policy');
    if (!captureStoreConfigured()) return refuse(c, 503, 'capture_store_unavailable', 'No capture store is configured');
    const device = await loadDevice(access, c.req.valid('param').deviceId);
    if (!device) return c.json({ error: 'Not found' }, 404);
    const raw = c.req.valid('json').policy;
    const parsed = raw === null ? null : PolicySchema.safeParse(raw);
    if (parsed && !parsed.success) return refuse(c, 400, 'capture_policy_invalid', parsed.error.issues[0]?.message ?? 'Invalid policy');
    await writeDevicePolicy(access.accountId, device.deviceId, parsed ? parsed.data : null);
    return c.json(deviceView((await deviceInAccount(access.accountId, device.deviceId))!), 200);
  },
);

// ─── Timeline ────────────────────────────────────────────────────────────────

accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/capture/timeline',
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
    return timelineResponse(c, access, query.device_id);
  },
);

accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/capture/days',
    tags,
    summary: 'The days of one person’s timeline with recorded items, newest first, grouped in a time zone',
    ...auth,
    request: {
      params,
      query: z.object({
        user_id: z.string().uuid().optional(),
        device_id: z.string().uuid().optional(),
        tz: z.string().max(64).optional().describe('IANA time zone of the days (default UTC)'),
      }),
    },
    responses: ok('The days'),
  }),
  async (c) => {
    const query = c.req.valid('query');
    const access = await captureAccess(c, { userId: query.user_id });
    if (isResponse(access)) return access as never;
    const tz = query.tz || 'UTC';
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
    } catch {
      return refuse(c, 400, 'capture_bad_window', 'tz must be an IANA time zone, for example Europe/Berlin');
    }
    const days = await recordedDays(access.accountId, access.subject!, { tz, deviceId: query.device_id });
    return c.json({ user_id: access.subject, tz, days }, 200);
  },
);

accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/capture/timeline/items',
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
    const items = await timelineItems(access.accountId, access.subject!, span, query.device_id);
    return c.json({ user_id: access.subject, from: span.from.toISOString(), to: span.to.toISOString(), ...items }, 200);
  },
);

accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/capture/search',
    tags,
    summary: 'Full-text search of one person’s timeline: screen (app, window, URL, on-screen text; one hit per chunk and window), actions and audio',
    ...auth,
    request: {
      params,
      query: searchQuery,
    },
    responses: ok('Hits, newest first'),
  }),
  async (c) => {
    const query = c.req.valid('query');
    const access = await captureAccess(c, { userId: query.user_id });
    if (isResponse(access)) return access as never;
    return searchResponse(c, access, query);
  },
);

// ─── Media ───────────────────────────────────────────────────────────────────

accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/capture/frames/{frameId}',
    tags,
    summary: 'One frame with its full on-screen text and a signed, short-lived URL of its video chunk',
    ...auth,
    request: { params: params.extend({ frameId: z.string().uuid() }), query: z.object({ user_id: z.string().uuid().optional() }) },
    responses: ok('The frame'),
  }),
  async (c) => {
    const access = await captureAccess(c, { userId: c.req.valid('query').user_id });
    if (isResponse(access)) return access as never;
    return frameResponse(c, access, c.req.valid('param').frameId);
  },
);

accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/capture/chunks/{chunkId}/media',
    tags,
    summary: 'Signed, short-lived URLs of an indexed item’s media (video or audio)',
    ...auth,
    request: { params: params.extend({ chunkId: z.string().uuid() }), query: z.object({ user_id: z.string().uuid().optional() }) },
    responses: ok('The URLs'),
  }),
  async (c) => {
    const access = await captureAccess(c, { userId: c.req.valid('query').user_id });
    if (isResponse(access)) return access as never;
    const chunk = await chunkOf(access.accountId, access.subject!, c.req.valid('param').chunkId);
    if (!chunk) return c.json({ error: 'Not found' }, 404);
    return c.json({ chunk_id: chunk.chunkId, kind: chunk.kind, video: await mediaUrl(chunk, 'video'), audio: await mediaUrl(chunk, 'audio') }, 200);
  },
);

// ─── Ranges ──────────────────────────────────────────────────────────────────

/** A range of this account the caller may read. Another member's is audited for admins and viewers, "not found" otherwise. */
async function loadRange(c: Ctx, access: Access, rangeId: string) {
  const range = await rangeInAccount(access.accountId, rangeId);
  if (!range) return null;
  if (range.userId !== access.viewer) {
    if (!access.readsAll) return null;
    await auditRead(c, access, 'capture.member_view', range.userId);
  }
  return range;
}

accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/capture/ranges',
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
    return c.json({ ranges: await rangesFor(access.accountId, access.subject!, span) }, 200);
  },
);

accountsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/capture/ranges',
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

accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/capture/ranges/{rangeId}',
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

accountsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/capture/ranges/{rangeId}/process',
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

accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/capture/people',
    tags,
    summary: 'Per member: active time, time per app, ranges and devices in a window (Capture admins and viewers)',
    ...auth,
    request: { params, query: z.object({ day: z.string().optional(), from: z.string().optional(), to: z.string().optional() }) },
    responses: ok('The summary'),
  }),
  async (c) => {
    const access = await captureAccess(c, { accountWide: true });
    if (isResponse(access)) return access as never;
    const span = window(c);
    if (!span) return refuse(c, 400, 'capture_bad_window', BAD_WINDOW);
    return c.json({ from: span.from.toISOString(), to: span.to.toISOString(), people: await peopleSummary(access.accountId, span) }, 200);
  },
);

}

// ─── The agent tool: /v1/capture/me/* (account from the token) ──────────────

/**
 * The three reads `kortix capture` makes from a session. The account is the
 * token's own (`c.get('accountId')`); the person is the one the private
 * session acts for. Mounted on the `/v1/capture` router.
 */
export function registerCaptureAgentRoutes(app: OpenAPIHono<AppEnv>) {
  const meAccess = (c: Ctx) => {
    const accountId = c.get('accountId') as string | undefined;
    if (!accountId) return Promise.resolve(refuse(c, 400, 'capture_no_account', 'Use an account token, or /v1/accounts/:accountId/capture'));
    return captureAccessFor(c, accountId);
  };
  const meTags = ['capture'];
  app.openapi(
    createRoute({
      method: 'get',
      path: '/me/timeline',
      tags: meTags,
      summary: 'Your timeline (or the person your session acts for) in your token’s account',
      ...auth,
      middleware: [supabaseAuth] as const,
      request: { query: subjectQuery.omit({ user_id: true }) },
      responses: ok('The timeline'),
    }),
    async (c) => {
      const access = await meAccess(c);
      if (isResponse(access)) return access as never;
      return timelineResponse(c, access, c.req.valid('query').device_id);
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/me/search',
      tags: meTags,
      summary: 'Search your timeline (or the person your session acts for) in your token’s account',
      ...auth,
      middleware: [supabaseAuth] as const,
      request: { query: searchQuery.omit({ user_id: true }) },
      responses: ok('Hits, newest first'),
    }),
    async (c) => {
      const access = await meAccess(c);
      if (isResponse(access)) return access as never;
      return searchResponse(c, access, c.req.valid('query'));
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/me/frames/{frameId}',
      tags: meTags,
      summary: 'One of your frames with its on-screen text and a signed video URL',
      ...auth,
      middleware: [supabaseAuth] as const,
      request: { params: z.object({ frameId: z.string().uuid() }) },
      responses: ok('The frame'),
    }),
    async (c) => {
      const access = await meAccess(c);
      if (isResponse(access)) return access as never;
      return frameResponse(c, access, c.req.valid('param').frameId);
    },
  );
}
