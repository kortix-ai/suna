// DEPRECATED `/channels/*` compatibility aliases.
//
// The channel surface moved to `/connectors/channels/*` (see connectors-channels.ts).
// These aliases keep the OLD paths answering, because two client families are
// pinned to them and cannot be updated in lockstep with an API deploy:
//
//   1. The in-sandbox `slack-cli` — BAKED INTO SANDBOX IMAGES (see
//      snapshots/build-context.ts: "runtime layer ... + slack-cli + ..."). Already
//      running sandboxes, and any image not yet rebaked, call the old paths
//      (`slack send --file`, `slack download`, `meet speak`, thread binding).
//   2. The published `kortix` CLI (apps/cli) — installed on user machines; those
//      binaries only move on `kortix update`.
//
// Every alias delegates to the SAME descriptor handlers the new routes use
// (invokeChannelCapability / descriptor lifecycle methods), so behavior, status
// codes, and authorization are identical by construction — an old client and a
// new client cannot diverge.
//
// REMOVAL: safe to delete once (a) every sandbox image has been rebaked with a
// slack-cli that targets `/connectors/channels/*`, and (b) the minimum supported
// `kortix` CLI ships the new paths. Until then, deleting these breaks live agents.
import { createRoute, z } from '@hono/zod-openapi';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { assertProjectCapability } from '../lib/access';
import { projectsApp } from '../lib/app';
import { descriptorForPlatform } from '../../channels/registry';
import {
  defaultSlug,
  invokeChannelCapability,
  loadChannelContext,
  readCapabilityInput,
  renderChannelError,
} from './connectors-channels';

const AnyBody = { content: { 'application/json': { schema: z.any() } } };
const params = z.object({ projectId: z.string() });

/** Register a deprecated capability alias at an old path. */
function aliasCapability(opts: {
  method: 'get' | 'post' | 'put' | 'delete' | 'patch';
  path: string;
  platform: string;
  action: string;
  /** Build the capability input; defaults to query (GET) / JSON body (others). */
  input?: (c: any) => Promise<unknown> | unknown;
  /** Extra path params beyond projectId (e.g. the legacy `voiceId` segment). */
  extraParams?: Record<string, z.ZodTypeAny>;
}) {
  projectsApp.openapi(
    createRoute({
      method: opts.method,
      path: opts.path,
      tags: ['channels'],
      summary: `DEPRECATED ${opts.method.toUpperCase()} ${opts.path} → /connectors/channels/${opts.platform}/actions/${opts.action}`,
      deprecated: true,
      ...auth,
      request: {
        params: opts.extraParams
          ? z.object({ projectId: z.string(), ...opts.extraParams })
          : params,
        ...(opts.method === 'get' || opts.method === 'delete' ? {} : { body: AnyBody }),
      },
      responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 403, 404, 405, 409, 502, 503, 504),
      },
    }),
    async (c: any) => {
      const input = opts.input
        ? await opts.input(c)
        : await readCapabilityInput(c, opts.method === 'get' ? 'get' : 'post');
      return invokeChannelCapability(c, opts.platform, opts.action, input);
    },
  );
}

/** Register the deprecated lifecycle aliases (installation/mode/connect/disconnect). */
function aliasLifecycle(platform: string) {
  const base = `/{projectId}/channels/${platform}`;

  // GET installation — membership only (matches the old route).
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: `${base}/installation`,
      tags: ['channels'],
      summary: `DEPRECATED GET ${base}/installation → /connectors/channels/${platform}/installation`,
      deprecated: true,
      ...auth,
      request: { params },
      responses: { 200: json(z.any(), 'OK'), ...errors(404) },
    }),
    async (c: any) => {
      const descriptor = descriptorForPlatform(platform);
      if (!descriptor) return c.json({ error: 'Unknown channel' }, 404);
      const resolved = await loadChannelContext(c, c.req.param('projectId'));
      if (!resolved) return c.json({ error: 'Not found' }, 404);
      try {
        return c.json(await descriptor.getInstallation(resolved.ctx, defaultSlug(descriptor, c)));
      } catch (err) {
        return renderChannelError(c, err);
      }
    },
  );

  // GET mode — membership only.
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: `${base}/mode`,
      tags: ['channels'],
      summary: `DEPRECATED GET ${base}/mode → /connectors/channels/${platform}/mode`,
      deprecated: true,
      ...auth,
      request: { params },
      responses: { 200: json(z.any(), 'OK'), ...errors(404) },
    }),
    async (c: any) => {
      const descriptor = descriptorForPlatform(platform);
      if (!descriptor) return c.json({ error: 'Unknown channel' }, 404);
      const resolved = await loadChannelContext(c, c.req.param('projectId'));
      if (!resolved) return c.json({ error: 'Not found' }, 404);
      try {
        return c.json(await descriptor.getMode(resolved.ctx));
      } catch (err) {
        return renderChannelError(c, err);
      }
    },
  );

  // POST connect — membership + connector.write.
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: `${base}/connect`,
      tags: ['channels'],
      summary: `DEPRECATED POST ${base}/connect → /connectors/channels/${platform}/connect`,
      deprecated: true,
      ...auth,
      request: { params, body: AnyBody },
      responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 403, 404, 409, 502, 503, 504),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
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

  // DELETE installation — membership + connector.write.
  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: `${base}/installation`,
      tags: ['channels'],
      summary: `DEPRECATED DELETE ${base}/installation → /connectors/channels/${platform}/installation`,
      deprecated: true,
      ...auth,
      request: { params },
      responses: { 200: json(z.any(), 'OK'), ...errors(403, 404) },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
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
}

// ── Lifecycle aliases: slack / teams / email had these routes; meet never did. ──
for (const platform of ['slack', 'teams', 'email'] as const) {
  aliasLifecycle(platform);
}

// ── Capability aliases ──────────────────────────────────────────────────────
// Slack (in-sandbox slack-cli: `slack download`, `slack send --file`, thread bind)
aliasCapability({ method: 'get', path: '/{projectId}/channels/slack/file', platform: 'slack', action: 'getFile' });
aliasCapability({ method: 'post', path: '/{projectId}/channels/slack/file/upload', platform: 'slack', action: 'uploadFile' });
aliasCapability({ method: 'post', path: '/{projectId}/channels/slack/bind-thread', platform: 'slack', action: 'bindThread' });

// Teams (in-sandbox teams file proxy)
aliasCapability({ method: 'get', path: '/{projectId}/channels/teams/manifest', platform: 'teams', action: 'manifest' });
aliasCapability({ method: 'get', path: '/{projectId}/channels/teams/file', platform: 'teams', action: 'getFile' });
aliasCapability({ method: 'post', path: '/{projectId}/channels/teams/file/upload', platform: 'teams', action: 'uploadFile' });

// Email — the old sender-policy edit was PATCH on the installation path.
aliasCapability({
  method: 'patch',
  path: '/{projectId}/channels/email/installation',
  platform: 'email',
  action: 'updatePolicy',
});

// Meet (in-sandbox `meet speak`, plus the voice/name config surface)
aliasCapability({ method: 'get', path: '/{projectId}/channels/meet/voices', platform: 'meet', action: 'voices' });
aliasCapability({ method: 'put', path: '/{projectId}/channels/meet/name', platform: 'meet', action: 'setName' });
aliasCapability({ method: 'put', path: '/{projectId}/channels/meet/voice', platform: 'meet', action: 'setVoice' });
aliasCapability({ method: 'post', path: '/{projectId}/channels/meet/speak', platform: 'meet', action: 'speak' });
// voiceId moved from the URL path into the body on the new route — translate it
// back here so old callers keep working unchanged.
aliasCapability({
  method: 'post',
  path: '/{projectId}/channels/meet/voices/{voiceId}/preview',
  platform: 'meet',
  action: 'previewVoice',
  input: (c: any) => ({ voiceId: c.req.param('voiceId') }),
  extraParams: { voiceId: z.string() },
});
