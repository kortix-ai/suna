import { createRoute, z } from '@hono/zod-openapi';
import {
  OAuth2ApplicationInputSchema,
  OAuth2ApplicationViewSchema,
  OAuth2AuthorizationStartInputSchema,
  OAuth2AuthorizationStartResultSchema,
  OAuth2ClientRegistrationInputSchema,
  OAuth2ConnectionStatusSchema,
  OAuth2DeviceAuthorizationStartInputSchema,
  OAuth2DeviceAuthorizationStartResultSchema,
  OAuth2DiscoveryInputSchema,
  OAuth2ResourceDiscoveryInputSchema,
  OAuth2ResourceDiscoverySchema,
} from '@kortix/api-contract';
import { connectors } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { config } from '../../lib/config';
import { ensureDefaultConnection } from '../../services/connectors/credentials';
import { nativeOAuth2CallbackUrl } from '../../services/connectors/oauth2-callback-url';
import {
  createAuthorizationCodeSession,
  createDeviceAuthorizationSession,
  discoverConfiguredOAuth2Application,
  discoverConnectionOAuth2Resource,
  loadOAuth2Application,
  oauth2ConnectionStatus,
  pollDeviceAuthorizationSession,
  redactOAuth2Application,
  registerConnectionOAuth2Client,
  saveOAuth2Application,
} from '../../services/connectors/oauth2-store';
import { PROJECT_ACTIONS } from '../../services/iam';
import { db } from '../../lib/db';
import { loadProjectForUser, projectCapabilityAllowed } from '../lib/project-access';
import { projectsApp } from './app';
import { loadMutableConnection } from '../lib/connection-mutation';
import { readJsonObject } from '../lib/http-body';
import { auth, errors, json, lenientBody } from '../openapi';
import { OkSchema } from './app';

// Bodies are documented with `lenientBody` and parsed by each handler, so a bad
// body still answers its own 400 message, and only after the 404/403 checks.
const ConnectionParams = z.object({ projectId: z.string(), connectionId: z.string() });
const body = (schema: z.AnyZodObject) => ({
  body: { content: { 'application/json': { schema: lenientBody(schema.shape) } } },
});
const ApplicationResponse = z.object({ application: OAuth2ApplicationViewSchema });
/** `POST .../oauth2/device/:sessionId`: one poll of a device authorization. */
const DevicePollSchema = z.object({
  status: z.enum(['pending', 'active', 'expired', 'error']),
  expires_at: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  error_code: z.string().optional(),
});

function callbackUrl(requestUrl: string): string {
  return nativeOAuth2CallbackUrl(requestUrl, config.KORTIX_URL);
}

function allowedRedirectUri(value: string | undefined, projectId: string): string | undefined {
  if (!value) return undefined;
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    throw new Error('redirect URI is invalid');
  }
  const configuredOrigin = new URL(config.FRONTEND_URL).origin;
  const allowedOrigins = new Set([
    configuredOrigin,
    'https://kortix.com',
    'https://www.kortix.com',
    'https://dev.kortix.com',
    'https://staging.kortix.com',
  ]);
  if (!allowedOrigins.has(uri.origin)) throw new Error('redirect URI origin is not allowed');
  if (!uri.pathname.startsWith(`/projects/${projectId}`) && uri.origin !== configuredOrigin) {
    throw new Error('redirect URI path is not allowed');
  }
  return uri.href;
}
export function registerOauth2ConnectorsRoutes(): void {
  projectsApp.openapi(
    createRoute({
      tags: ['connectors'],
      ...auth,
      method: 'post',
      path: '/{projectId}/connectors/{slug}/oauth2/connection',
      summary: "Get or create a connector's shared OAuth2 connection",
      request: { params: z.object({ projectId: z.string(), slug: z.string() }) },
      responses: {
        200: json(z.object({ connection_id: z.string() }), 'The connection id'),
        ...errors(403, 404),
      },
    }),
    async (c) => {
    const projectId = c.req.param('projectId');
    const slug = c.req.param('slug');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const mayManage = await projectCapabilityAllowed(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE,
    );
    if (!mayManage) return c.json({ error: 'Forbidden' }, 403);
    const [connector] = await db
      .select({
        connectorId: connectors.connectorId,
      })
      .from(connectors)
      .where(
        and(
          eq(connectors.accountId, loaded.row.accountId),
          eq(connectors.projectId, projectId),
          eq(connectors.slug, slug),
        ),
      )
      .limit(1);
    if (!connector) return c.json({ error: 'Connector not found' }, 404);
    // No connector-level gate: every connector may hold a shared project account.
    // The connections-manage capability asserted above is the whole check.
    const connectionId = await ensureDefaultConnection({
      projectId,
      connectorId: connector.connectorId,
      createdBy: loaded.userId,
    });
    return c.json({ connection_id: connectionId });
  });

  projectsApp.openapi(
    createRoute({
      tags: ['connectors'],
      ...auth,
      method: 'put',
      path: '/{projectId}/connections/{connectionId}/oauth2/application',
      summary: "Save a connection's OAuth2 application",
      request: { params: ConnectionParams, ...body(OAuth2ApplicationInputSchema.innerType()) },
      responses: { 200: json(OkSchema, 'Saved'), ...errors(400, 403, 404) },
    }),
    async (c) => {
    const projectId = c.req.param('projectId');
    const connectionId = c.req.param('connectionId');
    const mutable = await loadMutableConnection(c, projectId, connectionId);
    if (!mutable) return c.json({ error: 'Not found' }, 404);
    const parsed = OAuth2ApplicationInputSchema.safeParse(await readJsonObject(c));
    if (!parsed.success) {
      return c.json(
        {
          error: parsed.error.issues[0]?.message ?? 'invalid OAuth2 application',
        },
        400,
      );
    }
    await saveOAuth2Application(mutable.connection, parsed.data, mutable.loaded.userId);
    return c.json({ ok: true as const });
  });

  projectsApp.openapi(
    createRoute({
      tags: ['connectors'],
      ...auth,
      method: 'get',
      path: '/{projectId}/connections/{connectionId}/oauth2/application',
      summary: "Read a connection's OAuth2 application, secrets redacted",
      request: { params: ConnectionParams },
      responses: { 200: json(ApplicationResponse, 'The application'), ...errors(403, 404) },
    }),
    async (c) => {
    const projectId = c.req.param('projectId');
    const connectionId = c.req.param('connectionId');
    const mutable = await loadMutableConnection(c, projectId, connectionId);
    if (!mutable) return c.json({ error: 'Not found' }, 404);
    const loaded = await loadOAuth2Application(connectionId);
    if (!loaded) return c.json({ error: 'OAuth2 application is not configured' }, 404);
    return c.json({ application: redactOAuth2Application(loaded.application) });
  });

  projectsApp.openapi(
    createRoute({
      tags: ['connectors'],
      ...auth,
      method: 'post',
      path: '/{projectId}/connections/{connectionId}/oauth2/discover',
      summary: 'Read OAuth2 endpoints from a discovery document',
      request: { params: ConnectionParams, ...body(OAuth2DiscoveryInputSchema) },
      responses: {
        200: json(z.object({ metadata: OAuth2ResourceDiscoverySchema.shape.metadata.unwrap() }), 'The endpoints'),
        ...errors(400, 403, 404),
      },
    }),
    async (c) => {
    const projectId = c.req.param('projectId');
    const connectionId = c.req.param('connectionId');
    if (!(await loadMutableConnection(c, projectId, connectionId))) {
      return c.json({ error: 'Not found' }, 404);
    }
    const parsed = OAuth2DiscoveryInputSchema.safeParse(await readJsonObject(c));
    if (!parsed.success) return c.json({ error: 'invalid discovery URL' }, 400);
    try {
      return c.json({
        metadata: await discoverConfiguredOAuth2Application(parsed.data.discovery_url),
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  /**
   * MCP authorization discovery: probe the connector's server, follow
   * `WWW-Authenticate resource_metadata` → RFC 9728 → RFC 8414/OIDC, and return
   * the endpoints plus the dynamic-registration endpoint when one exists.
   */
  projectsApp.openapi(
    createRoute({
      tags: ['connectors'],
      ...auth,
      method: 'post',
      path: '/{projectId}/connections/{connectionId}/oauth2/discover-resource',
      summary: "Discover the authorization server of a connector's resource",
      request: { params: ConnectionParams, ...body(OAuth2ResourceDiscoveryInputSchema) },
      responses: {
        200: json(z.object({ discovery: OAuth2ResourceDiscoverySchema }), 'What the resource advertises'),
        ...errors(400, 403, 404),
      },
    }),
    async (c) => {
      const projectId = c.req.param('projectId');
      const connectionId = c.req.param('connectionId');
      if (!(await loadMutableConnection(c, projectId, connectionId))) {
        return c.json({ error: 'Not found' }, 404);
      }
      const parsed = OAuth2ResourceDiscoveryInputSchema.safeParse(await readJsonObject(c));
      if (!parsed.success) return c.json({ error: 'invalid resource URL' }, 400);
      try {
        return c.json({
          discovery: await discoverConnectionOAuth2Resource({
            connectionId,
            resourceUrl: parsed.data.resource_url,
          }),
        });
      } catch (error) {
        return c.json({ error: (error as Error).message }, 400);
      }
    },
  );

  /** RFC 7591: register Kortix with the authorization server and save the
   * issued client as this connection's OAuth2 application. */
  projectsApp.openapi(
    createRoute({
      tags: ['connectors'],
      ...auth,
      method: 'post',
      path: '/{projectId}/connections/{connectionId}/oauth2/register',
      summary: 'Register Kortix as an OAuth2 client (RFC 7591)',
      request: { params: ConnectionParams, ...body(OAuth2ClientRegistrationInputSchema.innerType()) },
      responses: { 200: json(ApplicationResponse, 'The registered application'), ...errors(400, 403, 404) },
    }),
    async (c) => {
    const projectId = c.req.param('projectId');
    const connectionId = c.req.param('connectionId');
    const mutable = await loadMutableConnection(c, projectId, connectionId);
    if (!mutable) return c.json({ error: 'Not found' }, 404);
    const parsed = OAuth2ClientRegistrationInputSchema.safeParse(await readJsonObject(c));
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? 'invalid client registration input' },
        400,
      );
    }
    try {
      const application = await registerConnectionOAuth2Client({
        identity: mutable.connection,
        registration: parsed.data,
        callbackUrl: callbackUrl(c.req.url),
        createdBy: mutable.loaded.userId,
      });
      return c.json({ application: redactOAuth2Application(application) });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  projectsApp.openapi(
    createRoute({
      tags: ['connectors'],
      ...auth,
      method: 'post',
      path: '/{projectId}/connections/{connectionId}/oauth2/authorize',
      summary: 'Start an OAuth2 authorization-code flow',
      request: { params: ConnectionParams, ...body(OAuth2AuthorizationStartInputSchema) },
      responses: {
        200: json(OAuth2AuthorizationStartResultSchema, 'The URL to send the user to'),
        ...errors(400, 403, 404),
      },
    }),
    async (c) => {
    const projectId = c.req.param('projectId');
    const connectionId = c.req.param('connectionId');
    const mutable = await loadMutableConnection(c, projectId, connectionId);
    if (!mutable) return c.json({ error: 'Not found' }, 404);
    const parsed = OAuth2AuthorizationStartInputSchema.safeParse(await readJsonObject(c));
    if (!parsed.success) return c.json({ error: 'invalid authorization input' }, 400);
    try {
      const successRedirectUri = allowedRedirectUri(parsed.data.success_redirect_uri, projectId);
      const errorRedirectUri = allowedRedirectUri(parsed.data.error_redirect_uri, projectId);
      const started = await createAuthorizationCodeSession({
        connectionId,
        initiatedBy: mutable.loaded.userId,
        callbackUrl: callbackUrl(c.req.url),
        scopes: parsed.data.scopes,
        successRedirectUri,
        errorRedirectUri,
      });
      return c.json({
        authorization_url: started.authorizationUrl,
        expires_at: new Date(started.expiresAt).toISOString(),
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  projectsApp.openapi(
    createRoute({
      tags: ['connectors'],
      ...auth,
      method: 'post',
      path: '/{projectId}/connections/{connectionId}/oauth2/device',
      summary: 'Start an OAuth2 device authorization',
      request: { params: ConnectionParams, ...body(OAuth2DeviceAuthorizationStartInputSchema) },
      responses: {
        200: json(OAuth2DeviceAuthorizationStartResultSchema, 'The code to show the user'),
        ...errors(400, 403, 404),
      },
    }),
    async (c) => {
    const projectId = c.req.param('projectId');
    const connectionId = c.req.param('connectionId');
    const mutable = await loadMutableConnection(c, projectId, connectionId);
    if (!mutable) return c.json({ error: 'Not found' }, 404);
    const parsed = OAuth2DeviceAuthorizationStartInputSchema.safeParse(await readJsonObject(c));
    if (!parsed.success) return c.json({ error: 'invalid device authorization input' }, 400);
    try {
      const started = await createDeviceAuthorizationSession({
        connectionId,
        initiatedBy: mutable.loaded.userId,
        scopes: parsed.data.scopes,
      });
      return c.json({
        session_id: started.sessionId,
        user_code: started.userCode,
        verification_uri: started.verificationUri,
        ...(started.verificationUriComplete
          ? { verification_uri_complete: started.verificationUriComplete }
          : {}),
        expires_at: new Date(started.expiresAt).toISOString(),
        interval_seconds: started.intervalSeconds,
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  projectsApp.openapi(
    createRoute({
      tags: ['connectors'],
      ...auth,
      method: 'post',
      path: '/{projectId}/connections/{connectionId}/oauth2/device/{sessionId}',
      summary: 'Poll an OAuth2 device authorization',
      request: { params: ConnectionParams.extend({ sessionId: z.string() }) },
      responses: { 200: json(DevicePollSchema, 'The poll result'), ...errors(400, 403, 404) },
    }),
    async (c) => {
      const projectId = c.req.param('projectId');
      const connectionId = c.req.param('connectionId');
      const mutable = await loadMutableConnection(c, projectId, connectionId);
      if (!mutable) return c.json({ error: 'Not found' }, 404);
      try {
        return c.json(
          await pollDeviceAuthorizationSession({
            connectionId,
            sessionId: c.req.param('sessionId'),
            initiatedBy: mutable.loaded.userId,
          }),
        );
      } catch (error) {
        return c.json({ error: (error as Error).message }, 400);
      }
    },
  );

  projectsApp.openapi(
    createRoute({
      tags: ['connectors'],
      ...auth,
      method: 'get',
      path: '/{projectId}/connections/{connectionId}/oauth2/status',
      summary: "Read a connection's OAuth2 token status",
      request: { params: ConnectionParams },
      responses: { 200: json(OAuth2ConnectionStatusSchema, 'The token status'), ...errors(403, 404) },
    }),
    async (c) => {
    const projectId = c.req.param('projectId');
    const connectionId = c.req.param('connectionId');
    if (!(await loadMutableConnection(c, projectId, connectionId))) {
      return c.json({ error: 'Not found' }, 404);
    }
    return c.json(await oauth2ConnectionStatus(connectionId));
  });
}
