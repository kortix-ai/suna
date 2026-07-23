// Generic channel-connector HTTP surface.
//
// One set of handlers serves EVERY channel (Slack, Teams, Email, Meet) by
// dispatching through the descriptor registry (channels/registry). This
// replaces the ~24 bespoke `/channels/{slack,teams,email,meet}/*` routes: a new
// channel is a new descriptor, not a new route. Channels are `provider='channel'`
// connectors, so the surface lives under `/{projectId}/connectors/channels/*`.
//
//   GET    /{projectId}/connectors/channels                         list + status
//   GET    /{projectId}/connectors/channels/{platform}/mode         onboarding info
//   GET    /{projectId}/connectors/channels/{platform}/installation current install
//   POST   /{projectId}/connectors/channels/{platform}/connect      provision/attach
//   DELETE /{projectId}/connectors/channels/{platform}/installation tear down
//   */PUT/POST/GET/DELETE .../{platform}/actions/{action}           runtime capability
//
// The handlers own auth (membership floor + PROJECT_CONNECTOR_{READ,WRITE}) and
// ChannelError→status translation; descriptors own behavior only.
import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, inArray } from 'drizzle-orm';
import { sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { loadProjectForUser, assertProjectCapability } from '../lib/access';
import { projectsApp } from '../lib/app';
import {
  ChannelError,
  type ChannelContext,
  type ConnectorProviderDescriptor,
} from '../../channels/registry/descriptor';
import { descriptorForPlatform, listChannelDescriptors } from '../../channels/registry';

/** Resolve the project (membership floor) and build the descriptor context. */
export async function loadChannelContext(
  c: any,
  projectId: string,
): Promise<{ loaded: any; ctx: ChannelContext } | null> {
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return null;
  return {
    loaded,
    ctx: {
      projectId,
      accountId: loaded.row.accountId,
      userId: loaded.userId,
      projectName: loaded.row.name ?? null,
      metadata: loaded.row.metadata,
      requestUrl: c.req.url,
    },
  };
}

/** Translate a thrown ChannelError into its exact status + body; rethrow the rest. */
export function renderChannelError(c: any, err: unknown) {
  if (err instanceof ChannelError) return c.json(err.body, err.status as any);
  throw err;
}

export const defaultSlug = (d: ConnectorProviderDescriptor, c: any): string =>
  (c.req.query('connector_slug') || c.req.query('profile_slug') || d.defaultSlug).trim() ||
  d.defaultSlug;

// ── GET /{projectId}/connectors/channels — the unified channel list ──
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/connectors/channels',
    tags: ['connectors'],
    summary: 'GET /:projectId/connectors/channels',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: { 200: json(z.any(), 'OK'), ...errors(404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const resolved = await loadChannelContext(c, projectId);
    if (!resolved) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      resolved.loaded.userId,
      resolved.loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_READ,
    );
    const channels = listChannelDescriptors().map((d) => ({
      platform: d.platform,
      label: d.label,
      direction: d.direction,
      reservedSlug: d.reservedSlug,
      enabled: d.isEnabled(resolved.ctx.metadata),
      capabilities: Object.keys(d.capabilities),
    }));
    return c.json({ channels });
  },
);

// ── GET /{platform}/mode ──
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/connectors/channels/{platform}/mode',
    tags: ['connectors'],
    summary: 'GET /:projectId/connectors/channels/:platform/mode',
    ...auth,
    request: { params: z.object({ projectId: z.string(), platform: z.string() }) },
    responses: { 200: json(z.any(), 'OK'), ...errors(404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const platform = c.req.param('platform');
    const descriptor = descriptorForPlatform(platform);
    if (!descriptor) return c.json({ error: 'Unknown channel' }, 404);
    const resolved = await loadChannelContext(c, projectId);
    if (!resolved) return c.json({ error: 'Not found' }, 404);
    try {
      return c.json(await descriptor.getMode(resolved.ctx));
    } catch (err) {
      return renderChannelError(c, err);
    }
  },
);

// ── GET /{platform}/installation ──
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/connectors/channels/{platform}/installation',
    tags: ['connectors'],
    summary: 'GET /:projectId/connectors/channels/:platform/installation',
    ...auth,
    request: { params: z.object({ projectId: z.string(), platform: z.string() }) },
    responses: { 200: json(z.any(), 'OK'), ...errors(404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const platform = c.req.param('platform');
    const descriptor = descriptorForPlatform(platform);
    if (!descriptor) return c.json({ error: 'Unknown channel' }, 404);
    const resolved = await loadChannelContext(c, projectId);
    if (!resolved) return c.json({ error: 'Not found' }, 404);
    try {
      return c.json(await descriptor.getInstallation(resolved.ctx, defaultSlug(descriptor, c)));
    } catch (err) {
      return renderChannelError(c, err);
    }
  },
);

// ── POST /{platform}/connect (write) ──
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/connectors/channels/{platform}/connect',
    tags: ['connectors'],
    summary: 'POST /:projectId/connectors/channels/:platform/connect',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), platform: z.string() }),
      body: { content: { 'application/json': { schema: z.any() } } },
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(400, 403, 404, 409, 502, 503, 504),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const platform = c.req.param('platform');
    const descriptor = descriptorForPlatform(platform);
    if (!descriptor) return c.json({ error: 'Unknown channel' }, 404);
    const resolved = await loadChannelContext(c, projectId);
    if (!resolved) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      resolved.loaded.userId,
      resolved.loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    try {
      return c.json(await descriptor.connect(resolved.ctx, defaultSlug(descriptor, c), body));
    } catch (err) {
      return renderChannelError(c, err);
    }
  },
);

// ── DELETE /{platform}/installation (write) ──
projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/connectors/channels/{platform}/installation',
    tags: ['connectors'],
    summary: 'DELETE /:projectId/connectors/channels/:platform/installation',
    ...auth,
    request: { params: z.object({ projectId: z.string(), platform: z.string() }) },
    responses: { 200: json(z.any(), 'OK'), ...errors(403, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const platform = c.req.param('platform');
    const descriptor = descriptorForPlatform(platform);
    if (!descriptor) return c.json({ error: 'Unknown channel' }, 404);
    const resolved = await loadChannelContext(c, projectId);
    if (!resolved) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      resolved.loaded.userId,
      resolved.loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );
    try {
      await descriptor.disconnect(resolved.ctx, defaultSlug(descriptor, c));
      return c.json({ status: 'disconnected' });
    } catch (err) {
      return renderChannelError(c, err);
    }
  },
);

// ── Runtime capability dispatch: .../{platform}/actions/{action} ──
// One handler per HTTP method, all routing through the same dispatcher so a
// capability's declared `method` is what's enforced.
/**
 * Authorize + build context for a 'session'-lane capability (bind-thread): a
 * project-scoped sandbox token (the in-sandbox agent) OR a project member.
 * Mirrors the old bind-thread / turn-stream dual auth exactly.
 */
async function authorizeSessionLane(
  c: any,
  projectId: string,
): Promise<{ ok: true; ctx: ChannelContext } | { ok: false; status: number; error: string }> {
  const authType = c.get('authType') as string | undefined;
  if (authType === 'apiKey' && c.get('apiKeyType') === 'sandbox') {
    const accountId = c.get('accountId') as string | undefined;
    const sandboxId = c.get('sandboxId') as string | undefined;
    if (!accountId || !sandboxId) {
      return { ok: false, status: 403, error: 'this action requires a sandbox token' };
    }
    const [sandbox] = await db
      .select({ sandboxId: sessionSandboxes.sandboxId })
      .from(sessionSandboxes)
      .where(
        and(
          eq(sessionSandboxes.sandboxId, sandboxId),
          eq(sessionSandboxes.projectId, projectId),
          eq(sessionSandboxes.accountId, accountId),
          inArray(sessionSandboxes.status, ['provisioning', 'active']),
        ),
      )
      .limit(1);
    if (!sandbox) return { ok: false, status: 403, error: 'sandbox token is not scoped to this project' };
    // A sandbox-token caller isn't a user; build a minimal ctx. 'session'
    // capabilities (bind-thread) key off projectId and do their own
    // session→project ownership check — they don't read userId/metadata.
    return {
      ok: true,
      ctx: { projectId, accountId, userId: '', projectName: null, metadata: {}, requestUrl: c.req.url },
    };
  }
  const resolved = await loadChannelContext(c, projectId);
  if (!resolved) return { ok: false, status: 404, error: 'Not found' };
  return { ok: true, ctx: resolved.ctx };
}

/**
 * Look up a capability, gate it on its declared auth lane, and invoke it.
 * Exported so the DEPRECATED `/channels/*` compat routes (compat.ts) run the
 * exact same lookup/auth/handler path — there is one implementation, so an old
 * client and a new client can never diverge in behavior or authorization.
 */
// Returns `any` (not Response) to match the loosely-typed `c: any` handler
// convention these OpenAPI routes are registered with.
export async function invokeChannelCapability(
  c: any,
  platform: string,
  action: string,
  input: unknown,
): Promise<any> {
  const projectId = c.req.param('projectId');
  const descriptor = descriptorForPlatform(platform);
  if (!descriptor) return c.json({ error: 'Unknown channel' }, 404);
  const capability = descriptor.capabilities[action];
  if (!capability) return c.json({ error: 'Unknown action' }, 404);

  // Authorize per the capability's lane (preserves each old route's exact gate).
  let ctx: ChannelContext;
  if (capability.access === 'session') {
    const authz = await authorizeSessionLane(c, projectId);
    if (!authz.ok) return c.json({ error: authz.error }, authz.status as any);
    ctx = authz.ctx;
  } else {
    const resolved = await loadChannelContext(c, projectId);
    if (!resolved) return c.json({ error: 'Not found' }, 404);
    if (capability.access === 'write') {
      await assertProjectCapability(
        c,
        resolved.loaded.userId,
        resolved.loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
      );
    } else if (capability.access === 'customize') {
      await assertProjectCapability(
        c,
        resolved.loaded.userId,
        resolved.loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
      );
    }
    // 'member' → project membership (already established) is the whole gate.
    ctx = resolved.ctx;
  }

  try {
    const result = await capability.handler(ctx, input, c);
    return result instanceof Response ? result : c.json(result);
  } catch (err) {
    return renderChannelError(c, err);
  }
}

/** Read a capability's input: query map for GET, JSON body otherwise. */
export async function readCapabilityInput(c: any, method: string): Promise<unknown> {
  if (method === 'get') return c.req.query();
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

async function dispatchCapability(c: any) {
  const platform = c.req.param('platform');
  const action = c.req.param('action');
  const descriptor = descriptorForPlatform(platform);
  if (!descriptor) return c.json({ error: 'Unknown channel' }, 404);
  const capability = descriptor.capabilities[action];
  if (!capability) return c.json({ error: 'Unknown action' }, 404);
  if (capability.method !== c.req.method.toLowerCase()) {
    return c.json({ error: 'Method not allowed for this action' }, 405);
  }
  const input = await readCapabilityInput(c, capability.method);
  return invokeChannelCapability(c, platform, action, input);
}

for (const method of ['get', 'post', 'put', 'delete'] as const) {
  projectsApp.openapi(
    createRoute({
      method,
      path: '/{projectId}/connectors/channels/{platform}/actions/{action}',
      tags: ['connectors'],
      summary: `${method.toUpperCase()} /:projectId/connectors/channels/:platform/actions/:action`,
      ...auth,
      request: {
        params: z.object({ projectId: z.string(), platform: z.string(), action: z.string() }),
        ...(method === 'get'
          ? {}
          : { body: { content: { 'application/json': { schema: z.any() } } } }),
      },
      responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 403, 404, 405, 409, 502, 503, 504),
      },
    }),
    dispatchCapability,
  );
}
