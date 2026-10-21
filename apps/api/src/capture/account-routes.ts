/**
 * Kortix Capture, account-scoped: `/v1/accounts/:accountId/capture/*`. The
 * Kortix account (organization) is Capture's tenant; there is no project in
 * Capture's model.
 *
 * Access is Kortix IAM. Every account member reads their own devices and
 * timeline. `capture.read_all` reads every member's (a read of another member
 * writes `capture.member_view`, an account-wide read `capture.account_view`);
 * `capture.manage` writes the switch and the policy and revokes any device.
 * Owner and admin hold both by default.
 *
 * Agents: the agent tool reads through `/v1/capture/me/{timeline,search,frames}`
 * (registerCaptureAgentRoutes), bound to the token's own account and to the
 * person its private session acts for (`capture.agent_read`). A credential that
 * acts for no person (trigger, service account, shared session) gets 403
 * `capture_no_human`. An agent never reads another person and never writes.
 *
 * Every route except the workspace switch answers 403 `capture_disabled` while
 * Capture is off for the account. The queries live in reads.ts.
 */
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import * as C from '@kortix/api-contract';
import { CAPTURE_LAYERS } from '@kortix/sdk/capture-rules';
import type { Context } from 'hono';
import { accountsRouter } from '../accounts/core/app';
import { ACCOUNT_ACTIONS } from '../iam/actions';
import { authorize } from '../iam/authorize';
import { actorOf } from '../middleware/actor';
import { auth, errors, json } from '../openapi';
import { callerKortixSessionId } from '../middleware/caller-session';
import { getRequestOnBehalfOf } from '../middleware/on-behalf-of';
import { supabaseAuth } from '../middleware/auth';
import { recordAuditEvent } from '../shared/audit';
import { annotateAuditEvent, bindAuditPrincipal } from '../shared/audit-scope';
import type { AppEnv } from '../types';
import { parseDisplay, PolicySchema } from './format';
import { readAccountPolicy, writeAccountPolicy } from './policy';
import {
  assetUrl,
  nearestScreenshot,
  chunkOf,
  deviceInAccount,
  deviceView,
  devicesView,
  frameOf,
  frameVideoOffsetMs,
  listDevices,
  mediaUrl,
  recordedDays,
  revokeDevice,
  searchTimeline,
  sessionVisibility,
  timelineChunksIn,
  timelineItems,
  displaysOf,
  timelineFocus,
  timelineRuns,
  linkDevice,
  whoUserId,
  type SearchKind,
  type Who,
} from './reads';
import { runCaptureHealthTick } from './health-alerts';
import { captureStoreConfigured } from './store';
import { latestCaptureVersion } from './update-manifest';
import { enqueueLink, pollDevice } from './workers';
import { isAccountMember, readWorkspace, setCaptureEnabled } from './workspace';

export type Ctx = Context<AppEnv>;

export interface Access {
  accountId: string;
  /** The human the caller is (or acts for). */
  viewer: string;
  /** Whose data this request reads: a person, an unlinked device, or null = the whole account (`capture.read_all`). */
  subject: Who | null;
  /** `capture.read_all`: reads other members. Never true for an agent. */
  readsAll: boolean;
  /** `capture.manage`: the switch, the policy, revoking any device. Never true for an agent. */
  manages: boolean;
  sessionId: string | null;
}

export const CAPTURE_DISABLED = { error: 'Capture is off for this account', code: 'capture_disabled' } as const;

export const refuse = <S extends 400 | 403 | 404 | 503>(c: Ctx, status: S, code: string, error: string) => c.json({ error, code }, status);

export function auditRead(
  c: Ctx,
  access: Pick<Access, 'accountId' | 'viewer' | 'sessionId'>,
  action: string,
  resourceId: string | null,
  resourceType = 'capture_member',
) {
  return recordAuditEvent({
    accountId: access.accountId,
    sessionId: access.sessionId,
    actorUserId: access.viewer,
    actorType: access.sessionId ? 'agent' : 'human',
    onBehalfOfUserId: access.sessionId ? access.viewer : null,
    action,
    resourceType,
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

/** What IAM lets this human (not an agent) do with other people's capture. */
async function capturePowers(c: Ctx, accountId: string, sessionId: string | null) {
  if (sessionId) return { readsAll: false, manages: false };
  const actor = await actorOf(c, accountId);
  const [readAll, manage] = await Promise.all([
    authorize(actor, ACCOUNT_ACTIONS.CAPTURE_READ_ALL),
    authorize(actor, ACCOUNT_ACTIONS.CAPTURE_MANAGE),
  ]);
  return { readsAll: readAll.allowed, manages: manage.allowed };
}

export async function captureAccessFor(
  c: Ctx,
  accountId: string,
  opts: { userId?: string | null; accountWide?: boolean; deviceId?: string | null } = {},
): Promise<Access | Response> {
  const who = await viewerOf(c, accountId);
  if (who === 'wrong_account') return c.json({ error: 'Not found', code: 'capture_not_found' }, 404);
  const { viewer, sessionId } = who;
  if (!viewer) return refuse(c, 403, 'capture_no_human', 'This credential does not act for a person, so it has no capture timeline');
  if (!(await isAccountMember(accountId, viewer))) return c.json({ error: 'Not found', code: 'capture_not_found' }, 404);
  // The request's audit row belongs to this account's log. Without this a
  // browser session's row lands in the caller's own account (its token's).
  bindAuditPrincipal({ accountId });
  if (!(await readWorkspace(accountId)).enabled) return c.json(CAPTURE_DISABLED, 403);
  let subject: Who | null = opts.accountWide ? null : (opts.userId ?? viewer);
  let powers = subject === viewer ? { readsAll: false, manages: false } : await capturePowers(c, accountId, sessionId);
  // A device linked to no person (an IT rollout) is read as itself by capture.read_all;
  // anyone else asking for it reads their own rows of it.
  if (!opts.accountWide && !opts.userId && opts.deviceId) {
    const device = await deviceInAccount(accountId, opts.deviceId);
    if (device && device.userId === null) {
      powers = await capturePowers(c, accountId, sessionId);
      if (powers.readsAll) subject = { unlinkedDevice: device.deviceId };
    }
  }
  const access: Access = { accountId, viewer, subject, ...powers, sessionId };
  if (subject !== viewer) {
    if (!access.readsAll) {
      return refuse(
        c,
        403,
        'capture_forbidden',
        'Reading another member’s capture needs the capture.read_all permission',
      );
    }
    if (typeof subject === 'object' && subject) await auditRead(c, access, 'capture.device_view', subject.unlinkedDevice, 'capture_device');
    else await auditRead(c, access, subject ? 'capture.member_view' : 'capture.account_view', subject);
  } else if (sessionId) {
    await auditRead(c, access, 'capture.agent_read', viewer);
  }
  return access;
}

/** Access plus the caller's IAM powers, for a route that names a device or writes (assets, revoke, policy). */
export async function captureAccessWithPowers(c: Ctx): Promise<Access | Response> {
  const access = await captureAccess(c);
  if (isResponse(access)) return access;
  return { ...access, ...(await capturePowers(c, access.accountId, access.sessionId)) };
}

/** Access for an account route: the account is the `:accountId` path segment. */
export function captureAccess(c: Ctx, opts: { userId?: string | null; accountWide?: boolean; deviceId?: string | null } = {}) {
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
 * "not found" without `capture.read_all`; revoking it needs `capture.manage`.
 */
async function loadDevice(access: Access, deviceId: string, opts: { write?: boolean } = {}) {
  const device = await deviceInAccount(access.accountId, deviceId);
  if (!device) return null;
  if (device.userId !== access.viewer && !(opts.write ? access.manages : access.readsAll)) return null;
  return device;
}

const params = z.object({ accountId: z.string().uuid() });
const ok = (description: string) => ({ 200: json(z.any(), description), ...errors(400, 403, 404) });
const tags = ['capture'];
const subjectQuery = z.object({
  user_id: z.string().uuid().optional(),
  device_id: z.string().uuid().optional(),
  display_id: z
    .string()
    .regex(/^(\d+|all)$/)
    .optional()
    .describe('One display; default: the display that held the focused window. `all` (items only): every display'),
  day: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
// Search does not filter by display, so it does not declare `display_id`.
const searchQuery = subjectQuery.omit({ display_id: true }).extend({
  q: z.string().min(1),
  scope: z.enum(['mine', 'account']).optional().describe('account: every member (capture.read_all; audited as capture.account_view)'),
  kinds: z.string().optional().describe('Comma list of screen, actions, audio (default all)'),
  app: z.string().optional(),
  limit: z.string().optional(),
});

// ─── Shared read handlers (the account routes and the agent's /v1/capture/me) ─

/** `display_id` as a display id; `all` and absent are undefined. */
const displayParam = (value: string | undefined) => (value && value !== 'all' ? Number(value) : undefined);

async function timelineResponse(c: Ctx, access: Access, query: { device_id?: string; display_id?: string }) {
    const span = window(c);
    if (!span) return refuse(c, 400, 'capture_bad_window', BAD_WINDOW);
    const subject = access.subject!;
    const displayId = displayParam(query.display_id);
    const [runs, chunks, allChunks, focus] = await Promise.all([
      timelineRuns(access.accountId, subject, span, query.device_id, displayId),
      timelineChunksIn(access.accountId, subject, span, query.device_id, displayId),
      // The displays of the window, whatever display was asked for.
      displayId === undefined ? null : timelineChunksIn(access.accountId, subject, span, query.device_id),
      timelineFocus(access.accountId, subject, span, query.device_id),
    ]);
    return c.json(
      { user_id: whoUserId(subject), from: span.from.toISOString(), to: span.to.toISOString(), displays: displaysOf(allChunks ?? chunks), focus, runs, chunks },
      200,
    );
}

interface SearchQuery {
  q: string;
  kinds?: string;
  app?: string;
  limit?: string;
  day?: string;
  from?: string;
  to?: string;
  device_id?: string;
}

/** The search window: one UTC day when `day` is given (it wins over from/to,
 * as on the timeline), else from/to with all of time as the default (KRTX-2983). */
function searchWindow(query: SearchQuery): { from: Date; to: Date } | null {
  if (query.day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(query.day)) return null;
    const from = new Date(`${query.day}T00:00:00.000Z`);
    return Number.isNaN(from.getTime()) ? null : { from, to: new Date(from.getTime() + 86_400_000) };
  }
  const from = query.from ? new Date(query.from) : new Date(0);
  const to = query.to ? new Date(query.to) : new Date(Date.now() + 86_400_000);
  return Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) ? null : { from, to };
}

async function searchResponse(c: Ctx, access: Access, query: SearchQuery) {
    const q = query.q.trim().slice(0, 500);
    if (!q) return refuse(c, 400, 'capture_bad_query', 'q is required');
    const span = searchWindow(query);
    if (!span) return refuse(c, 400, 'capture_bad_window', 'Give day=YYYY-MM-DD, or from/to as ISO instants');
    const { from, to } = span;
    const kinds = new Set((query.kinds ?? CAPTURE_LAYERS.join(',')).split(',').map((k) => k.trim())) as Set<SearchKind>;
    if (!CAPTURE_LAYERS.some((k) => kinds.has(k))) {
      return refuse(c, 400, 'capture_bad_query', 'kinds must name screen, actions or audio');
    }
    const limit = Math.min(Math.max(Number(query.limit ?? 20) || 20, 1), 100);
    const hits = await searchTimeline(access.accountId, access.subject!, { q, from, to, kinds, app: query.app, deviceId: query.device_id, limit });
    return c.json({ user_id: whoUserId(access.subject), q, hits }, 200);
}

async function frameResponse(c: Ctx, access: Access, frameId: string) {
    const found = await frameOf(access.accountId, access.subject!, frameId);
    if (!found) return c.json({ error: 'Not found', code: 'capture_not_found' }, 404);
    const video = found.chunk ? await mediaUrl(found.chunk, 'video') : null;
    const offset = await frameVideoOffsetMs(found.frame);
    // A still of the moment: the action screenshot nearest the frame on its device (within 30 s).
    const shot = await nearestScreenshot(access.accountId, access.subject!, String(found.frame.device_id), new Date(String(found.frame.ts)));
    const screenshot = shot ? { ...shot, ...(await assetUrl(access.accountId, String(found.frame.device_id), shot.name)) } : null;
    const display = found.chunk ? parseDisplay(found.chunk.display) : null;
    return c.json({ frame: found.frame, display, video: video && { ...video, offset_ms: offset }, screenshot }, 200);
}

// ─── Workspace: the account switch and what you may do ──────────────────────

/** The workspace as a person sees it. */
async function workspaceView(c: Ctx, accountId: string, sessionId: string | null) {
  const [workspace, powers] = await Promise.all([readWorkspace(accountId), capturePowers(c, accountId, sessionId)]);
  return {
    account_id: accountId,
    enabled: workspace.enabled,
    can_read_all: powers.readsAll,
    can_manage: powers.manages,
    updated_at: workspace.updatedAt?.toISOString() ?? null,
  };
}

function registerCaptureWorkspaceRoutes() {
accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/capture',
    tags,
    summary: 'The account’s Capture workspace: on or off, and whether you may read everyone (capture.read_all) and manage it (capture.manage)',
    ...auth,
    request: { params },
    responses: { 200: json(C.CaptureWorkspaceSchema, 'The workspace'), ...errors(400, 403, 404) },
  }),
  async (c) => {
    const { accountId } = c.req.valid('param');
    const who = await viewerOf(c, accountId);
    if (who === 'wrong_account' || !who.viewer) return c.json({ error: 'Not found', code: 'capture_not_found' }, 404);
    if (!(await isAccountMember(accountId, who.viewer))) return c.json({ error: 'Not found', code: 'capture_not_found' }, 404);
    return c.json(await workspaceView(c, accountId, who.sessionId), 200);
  },
);

accountsRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/{accountId}/capture',
    tags,
    summary: 'Turn Capture on or off for the account (capture.manage)',
    ...auth,
    request: { params, body: { content: { 'application/json': { schema: z.object({ enabled: z.boolean() }) } } } },
    responses: { 200: json(C.CaptureWorkspaceSchema, 'The workspace'), ...errors(400, 403, 404) },
  }),
  async (c) => {
    const { accountId } = c.req.valid('param');
    const who = await viewerOf(c, accountId);
    if (who === 'wrong_account' || !who.viewer) return c.json({ error: 'Not found', code: 'capture_not_found' }, 404);
    if (who.sessionId) return refuse(c, 403, 'capture_forbidden', 'An agent cannot turn Capture on or off');
    if (!(await isAccountMember(accountId, who.viewer))) return c.json({ error: 'Not found', code: 'capture_not_found' }, 404);
    bindAuditPrincipal({ accountId });
    if (!(await capturePowers(c, accountId, null)).manages) {
      return refuse(c, 403, 'capture_forbidden', 'Turning Capture on or off needs the capture.manage permission');
    }
    const { enabled } = c.req.valid('json');
    await setCaptureEnabled(accountId, enabled, who.viewer);
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
    return c.json(await workspaceView(c, accountId, null), 200);
  },
);
}

// ─── Devices ─────────────────────────────────────────────────────────────────
function registerCaptureDevicesRoutes() {
accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/capture/devices',
    tags,
    summary: 'Capture devices with live status: yours, a member’s, or the account’s (`scope=account`); another person’s need capture.read_all',
    ...auth,
    request: { params, query: z.object({ user_id: z.string().uuid().optional(), scope: z.enum(['mine', 'account']).optional() }) },
    responses: ok('The devices'),
  }),
  async (c) => {
    const query = c.req.valid('query');
    const access = await captureAccess(c, { userId: query.user_id, accountWide: query.scope === 'account' });
    if (isResponse(access)) return access as never;
    return c.json(devicesView(await listDevices(access.accountId, whoUserId(access.subject)), await latestCaptureVersion()), 200);
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
    const access = await captureAccessWithPowers(c);
    if (isResponse(access)) return access as never;
    if (access.sessionId) return refuse(c, 403, 'capture_forbidden', 'An agent cannot revoke a capture device');
    const device = await loadDevice(access, c.req.valid('param').deviceId, { write: true });
    if (!device) return c.json({ error: 'Not found', code: 'capture_not_found' }, 404);
    return c.json(deviceView(await revokeDevice(device.deviceId, access.viewer), Date.now(), await latestCaptureVersion()), 200);
  },
);

accountsRouter.openapi(
  createRoute({
    method: 'put',
    path: '/{accountId}/capture/devices/{deviceId}/link',
    tags,
    summary: 'Link a device to a member, or unlink it (`user_id: null`) (capture.manage)',
    description:
      'From then on the device records for that member. What it recorded while linked to no person moves to the member within minutes; what it recorded for an earlier member stays theirs.',
    ...auth,
    request: {
      params: params.extend({ deviceId: z.string().uuid() }),
      body: { content: { 'application/json': { schema: z.object({ user_id: z.string().uuid().nullable() }) } } },
    },
    responses: { ...ok('The device'), ...errors(409) },
  }),
  async (c) => {
    const access = await captureAccessWithPowers(c);
    if (isResponse(access)) return access as never;
    if (access.sessionId || !access.manages) {
      return refuse(c, 403, 'capture_forbidden', 'Linking a device to a person needs the capture.manage permission');
    }
    const device = await deviceInAccount(access.accountId, c.req.valid('param').deviceId);
    if (!device) return c.json({ error: 'Not found', code: 'capture_not_found' }, 404);
    const userId = c.req.valid('json').user_id;
    if (userId && !(await isAccountMember(access.accountId, userId))) {
      return refuse(c, 400, 'capture_link_invalid', 'user_id must be a member of the account');
    }
    const outcome = await linkDevice(device, userId);
    if (outcome.kind === 'conflict') {
      return c.json(
        { error: 'This member already has another device for this computer; revoke one first', code: 'capture_link_conflict', device_id: outcome.deviceId },
        409,
      );
    }
    if (userId) await enqueueLink(access.accountId, device.deviceId, userId);
    annotateAuditEvent({ resourceType: 'capture_device', resourceId: device.deviceId, metadata: { member_user_id: userId, previous_user_id: device.userId } });
    return c.json(deviceView(outcome.device, Date.now(), await latestCaptureVersion()), 200);
  },
);

accountsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/capture/devices/{deviceId}/sync',
    tags,
    summary: 'Read a device’s status, description and index now, queue every new item for indexing, retract every item the device deleted, and raise or clear its not-recording alert',
    ...auth,
    request: { params: params.extend({ deviceId: z.string().uuid() }) },
    responses: { ...ok('The number of items queued and the number retracted'), ...errors(503) },
  }),
  async (c) => {
    const access = await captureAccessWithPowers(c);
    if (isResponse(access)) return access as never;
    if (!captureStoreConfigured()) return refuse(c, 503, 'capture_store_unavailable', 'No capture store is configured');
    const device = await loadDevice(access, c.req.valid('param').deviceId);
    if (!device || device.revokedAt) return c.json({ error: 'Not found', code: 'capture_not_found' }, 404);
    const { enqueued, forgotten } = await pollDevice(device);
    // The status just read may open or close a not-recording alert: raise it now, as the leader's health tick would.
    const alerts = await runCaptureHealthTick(Date.now(), device.accountId);
    return c.json({ device_id: device.deviceId, enqueued, forgotten, alerts }, 200);
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
    const access = await captureAccessWithPowers(c);
    if (isResponse(access)) return access as never;
    const device = await loadDevice(access, deviceId);
    if (!device) return c.json({ error: 'Not found', code: 'capture_not_found' }, 404);
    if (device.userId === null) await auditRead(c, access, 'capture.device_view', device.deviceId, 'capture_device');
    else if (device.userId !== access.viewer) await auditRead(c, access, 'capture.member_view', device.userId);
    if (!captureStoreConfigured()) return refuse(c, 503, 'capture_store_unavailable', 'No capture store is configured');
    return c.json(await assetUrl(access.accountId, device.deviceId, name), 200);
  },
);
}

// ─── Policy ──────────────────────────────────────────────────────────────────
function registerCapturePolicyRoutes() {
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
    summary: 'Set the account capture policy (capture.manage); publishes orgs/<account_id>/policy.json',
    ...auth,
    request: { params, body: { content: { 'application/json': { schema: z.object({ policy: z.record(z.string(), z.any()) }) } } } },
    responses: { ...ok('The stored policy'), ...errors(503) },
  }),
  async (c) => {
    const access = await captureAccessWithPowers(c);
    if (isResponse(access)) return access as never;
    if (!access.manages) return refuse(c, 403, 'capture_forbidden', 'Changing the capture policy needs the capture.manage permission');
    if (!captureStoreConfigured()) return refuse(c, 503, 'capture_store_unavailable', 'No capture store is configured');
    const parsed = PolicySchema.safeParse(c.req.valid('json').policy);
    if (!parsed.success) return refuse(c, 400, 'capture_policy_invalid', parsed.error.issues[0]?.message ?? 'Invalid policy');
    return c.json(await writeAccountPolicy(access.accountId, parsed.data, access.viewer), 200);
  },
);
}

// ─── Timeline ────────────────────────────────────────────────────────────────
function registerCaptureTimelineRoutes() {
accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/capture/timeline',
    tags,
    summary: 'One person’s timeline for a day or window: activity runs (app + window) and indexed items',
    ...auth,
    request: { params, query: subjectQuery },
    responses: ok('The timeline'),
  }),
  async (c) => {
    const query = c.req.valid('query');
    const access = await captureAccess(c, { userId: query.user_id, deviceId: query.device_id });
    if (isResponse(access)) return access as never;
    return timelineResponse(c, access, query);
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
    const access = await captureAccess(c, { userId: query.user_id, deviceId: query.device_id });
    if (isResponse(access)) return access as never;
    const tz = query.tz || 'UTC';
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
    } catch {
      return refuse(c, 400, 'capture_bad_query', 'tz must be an IANA time zone, for example Europe/Berlin');
    }
    const days = await recordedDays(access.accountId, access.subject!, { tz, deviceId: query.device_id });
    return c.json({ user_id: whoUserId(access.subject), tz, days }, 200);
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
    const access = await captureAccess(c, { userId: query.user_id, deviceId: query.device_id });
    if (isResponse(access)) return access as never;
    const span = window(c);
    if (!span) return refuse(c, 400, 'capture_bad_window', BAD_WINDOW);
    const items = await timelineItems(access.accountId, access.subject!, span, query.device_id, {
      displayId: displayParam(query.display_id),
      allDisplays: query.display_id === 'all',
    });
    return c.json({ user_id: whoUserId(access.subject), from: span.from.toISOString(), to: span.to.toISOString(), ...items }, 200);
  },
);

accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/capture/search',
    tags,
    summary: 'Full-text search of one person’s timeline, or the account’s (`scope=account`, capture.read_all): screen (app, window, URL, on-screen text; one hit per chunk and window), actions and audio',
    ...auth,
    request: {
      params,
      query: searchQuery,
    },
    responses: { 200: json(C.CaptureSearchResultSchema, 'Hits, newest first'), ...errors(400, 403, 404) },
  }),
  async (c) => {
    const query = c.req.valid('query');
    const access = await captureAccess(c, query.scope === 'account' && !query.user_id ? { accountWide: true } : { userId: query.user_id, deviceId: query.device_id });
    if (isResponse(access)) return access as never;
    return searchResponse(c, access, query);
  },
);
}

// ─── Media ───────────────────────────────────────────────────────────────────
function registerCaptureMediaRoutes() {
accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/capture/frames/{frameId}',
    tags,
    summary: 'One frame with its full on-screen text and a signed, short-lived URL of its video chunk',
    ...auth,
    request: { params: params.extend({ frameId: z.string().uuid() }), query: z.object({ user_id: z.string().uuid().optional(), device_id: z.string().uuid().optional().describe('A device linked to no person: read it as itself (capture.read_all)') }) },
    responses: ok('The frame'),
  }),
  async (c) => {
    const access = await captureAccess(c, { userId: c.req.valid('query').user_id, deviceId: c.req.valid('query').device_id });
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
    request: { params: params.extend({ chunkId: z.string().uuid() }), query: z.object({ user_id: z.string().uuid().optional(), device_id: z.string().uuid().optional().describe('A device linked to no person: read it as itself (capture.read_all)') }) },
    responses: ok('The URLs'),
  }),
  async (c) => {
    const access = await captureAccess(c, { userId: c.req.valid('query').user_id, deviceId: c.req.valid('query').device_id });
    if (isResponse(access)) return access as never;
    const chunk = await chunkOf(access.accountId, access.subject!, c.req.valid('param').chunkId);
    if (!chunk) return c.json({ error: 'Not found', code: 'capture_not_found' }, 404);
    return c.json({ chunk_id: chunk.chunkId, kind: chunk.kind, video: await mediaUrl(chunk, 'video'), audio: await mediaUrl(chunk, 'audio') }, 200);
  },
);
}

/** Every account-scoped Capture route, in dispatch order. */
export function registerCaptureRoutes() {
  registerCaptureWorkspaceRoutes();
  registerCaptureDevicesRoutes();
  registerCapturePolicyRoutes();
  registerCaptureTimelineRoutes();
  registerCaptureMediaRoutes();
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
      return timelineResponse(c, access, c.req.valid('query'));
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
      request: { query: searchQuery.omit({ user_id: true, scope: true }) },
      responses: { 200: json(C.CaptureSearchResultSchema, 'Hits, newest first'), ...errors(400, 403, 404) },
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
