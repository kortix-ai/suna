/** Admin routes: list, create, delete a connector and set or bind its credential. */
import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { OAuth2ClientCredentialsSchema, UpdateConnectionCredentialInputSchema } from '@kortix/api-contract';
import type { Context } from 'hono';
import { INVALID_SOURCE_ADDRESS_CODE, isAllowedSourceValidationError } from '../../marketplace/catalog';
import { auth, errors, json, lenientBody } from '../../openapi';
import { UnsafeEgressError } from '../../shared/ssrf-guard';
import type { ConnectorAuthDiscovery } from '../auth-discovery';
import { discoverProtectedResourceOAuth2, mcpSignInCheck } from '../oauth2-resource-discovery';
import type { ConnectorRouterDeps, CrudOutcome } from '../router';
import { connectorIdentity } from '../catalog-install';

/** The CLI's `kortix connectors credential --oauth2-client-credentials` body. */
const OAuth2ConnectionBody = z
  .object({
    token_url: z.string().openapi({ description: 'The token endpoint, https only.' }),
    client_id: z.string(),
    client_secret: z.string().optional().openapi({ description: 'Sent once, stored encrypted, never returned.' }),
    token_endpoint_auth_method: z
      .enum(['none', 'client_secret_post', 'client_secret_basic', 'client_secret_jwt', 'private_key_jwt'])
      .optional()
      .openapi({ description: 'Default: client_secret_basic.' }),
    private_key: z.string().optional(),
    scopes: z.array(z.string()).optional(),
    audience: z.string().optional(),
    resource: z.string().optional(),
  })
  .passthrough();
import {
  AdminConnectorsResponseSchema,
  AuthDiscoverySchema,
  CatalogQuerySchema,
  ConnectorSecretBindingInputSchema,
  CrudOkSchema,
  OkSchema,
  OpaqueSchema,
  ProjectParam,
  ProjectSlugParam,
  featureNotSupportedResponse,
} from './shared';

/**
 * Structured 400 for an EXPECTED source-address validation rejection from
 * {@link assertAllowedSourceAddress} (the LFI/SSRF guard — non-https URL,
 * private host, local-folder path). The throw is a typed
 * {@link AllowedSourceValidationError} (stable `code: 'invalid_source_address'`)
 * so this helper converts it to a clean 400 without letting it propagate to
 * `app.onError` → `captureException` → Sentry (Better Stack pattern
 * `f5c0ce61…`). Mirrors the `feature_not_supported` (#5240) +
 * `RepoFileNotFoundError` (#5652) typed-error pattern: an expected user-input
 * validation state must NOT page like a server defect. Returns the 400
 * response when the error matches, otherwise `null` so the caller re-throws /
 * falls through to the generic handler for a genuine server failure.
 */
export function allowedSourceValidationResponse(c: Context, err: unknown): Response | null {
  if (isAllowedSourceValidationError(err)) {
    return c.json(
      {
        error: err.code,
        code: err.code,
        message: err.message,
      },
      400,
    );
  }
  // Defense in depth: the DNS-resolving egress guard (`safeEgressFetch`) is
  // the last check before a connector endpoint is fetched. Whatever it
  // rejects — a non-https scheme the source guard admitted as shorthand, a
  // public hostname that resolves to a private address — is still a property
  // of the URL the user typed, never a server defect. Same 400 envelope.
  if (err instanceof UnsafeEgressError) {
    return c.json(
      {
        error: INVALID_SOURCE_ADDRESS_CODE,
        code: INVALID_SOURCE_ADDRESS_CODE,
        message: `Connector endpoint rejected: ${err.message}`,
      },
      400,
    );
  }
  return null;
}

export function registerConnectorAdminRoutes(app: OpenAPIHono, deps: ConnectorRouterDeps): void {
  // ── Admin: list connectors for the dashboard ─────────────────────────────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{projectId}/connectors',
      tags: ['connector'],
      summary: "List a project's connectors with status (dashboard)",
      ...auth,
      request: { params: ProjectParam, query: CatalogQuerySchema.pick({ include_schemas: true }) },
      responses: {
        200: json(AdminConnectorsResponseSchema, 'Connectors with admin status'),
        ...errors(403),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      // Read-tier: plain members hold project.connector.read and the dashboard
      // sections that render this list are visible to them. The response carries
      // no credential values (only whether one is set).
      const reader = deps.resolveReader
        ? await deps.resolveReader(c, projectId)
        : await deps.resolveAdmin(c, projectId);
      if (!reader) return c.json({ error: 'forbidden' }, 403);
      const canReadSecretIdentifiers = deps.resolveSecretReader
        ? Boolean(await deps.resolveSecretReader(c, projectId))
        : false;
      const query = c.req.valid('query') as { include_schemas?: 'true' | 'false' };
      // Whose own credentialed accounts count as "connected" for a connector
      // with no project-wide shared credential — see listConnectors' doc.
      const connectors = await deps.listConnectors(projectId, reader.userId, {
        includeSchemas: query.include_schemas !== 'false',
      });
      return c.json({
        connectors: canReadSecretIdentifiers
          ? connectors
          : connectors.map((connector) => ({ ...connector, secretIdentifier: null })),
      });
    },
  );

  // ── Admin: can an MCP server be signed in to in one click ───────────────
  // Install asks this before it offers an app's MCP server instead of its
  // managed app: OAuth metadata plus dynamic client registration is one click.
  app.openapi(
    createRoute({
      method: 'post',
      path: '/projects/{projectId}/connectors/mcp-sign-in-check',
      tags: ['connector'],
      summary: 'Check whether an MCP server supports one-click OAuth sign-in',
      ...auth,
      request: {
        params: ProjectParam,
        body: {
          content: {
            'application/json': { schema: z.object({ url: z.string().url() }) },
          },
        },
      },
      responses: {
        200: json(
          z.object({ requires_sign_in: z.boolean(), one_click: z.boolean() }),
          'Whether the server needs a sign-in, and whether Kortix can run it in one click',
        ),
        ...errors(400, 403),
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid('param');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      const { url } = c.req.valid('json');
      try {
        return c.json(
          mcpSignInCheck(await discoverProtectedResourceOAuth2({ resourceUrl: url, provider: 'mcp' })),
          200,
        );
      } catch (err) {
        // The egress guard refused the URL (private, local, non-https): the
        // user's input, never a server defect.
        if (!(err instanceof UnsafeEgressError)) throw err;
        return c.json(
          {
            error: INVALID_SOURCE_ADDRESS_CODE,
            code: INVALID_SOURCE_ADDRESS_CODE,
            message: `MCP server rejected: ${err.message}`,
          },
          400,
        );
      }
    },
  );

  // ── Admin: preview authentication advertised by a connector source ──────
  app.openapi(
    createRoute({
      method: 'post',
      path: '/projects/{projectId}/connectors/auth-discovery',
      tags: ['connector'],
      summary: 'Discover authentication advertised by a connector source',
      ...auth,
      request: {
        params: ProjectParam,
        body: { content: { 'application/json': { schema: OpaqueSchema } } },
      },
      responses: {
        200: json(AuthDiscoverySchema, 'Normalized authentication candidates'),
        ...errors(400, 403, 501),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.discoverConnectorAuth)
        return featureNotSupportedResponse(c, 'connector_auth_discovery');
      let body: Record<string, unknown>;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      // `discoverConnectorAuth` calls `assertAllowedSourceAddress` (the LFI/SSRF
      // guard) on the draft's endpoint/spec URL, which throws a typed
      // `AllowedSourceValidationError` for a non-https / private / local source.
      // That's an EXPECTED user-input validation state — catch it here and
      // return a structured 400 instead of letting it propagate to
      // `app.onError` → Sentry (Better Stack pattern `f5c0ce61…`).
      try {
        return c.json(await deps.discoverConnectorAuth(projectId, body));
      } catch (err) {
        const validation = allowedSourceValidationResponse(c, err);
        if (validation) return validation;
        throw err;
      }
    },
  );

  // ── Admin: add/update a connector (writes kortix.yaml) ───────────────────
  app.openapi(
    createRoute({
      method: 'post',
      path: '/projects/{projectId}/connectors',
      tags: ['connector'],
      summary: 'Create or update a connector in kortix.yaml',
      description:
        'Add or update a connector. It is committed to kortix.yaml. Fields depend on provider.',
      ...auth,
      request: {
        params: ProjectParam,
        body: { content: { 'application/json': { schema: lenientBody({
            slug: z.string().openapi({ description: 'Connector slug (its name in kortix.yaml).' }),
            provider: z.enum(['composio', 'pipedream', 'mcp', 'openapi', 'postman', 'graphql', 'http', 'channel']).openapi({ description: 'Connector provider. Use composio for managed SaaS apps.' }),
            name: z.string().optional().openapi({ description: 'Display name.' }),
            app: z.string().optional().openapi({ description: 'Composio app slug, e.g. gmail (composio providers).' }),
            url: z.string().optional().openapi({ description: 'MCP server URL (provider mcp).' }),
            transport: z.enum(['http', 'sse']).optional().openapi({ description: 'MCP transport (provider mcp).' }),
            endpoint: z.string().optional().openapi({ description: 'GraphQL endpoint (provider graphql).' }),
            baseUrl: z.string().optional().openapi({ description: 'Base URL (provider http or openapi).' }),
            spec: z.string().optional().openapi({ description: 'OpenAPI or Postman spec URL.' }),
            authorization_strategy: z.string().optional().openapi({ description: 'Who owns connections: project or user.' }),
            auth: z.record(z.string(), z.any()).optional().openapi({ description: 'Auth scheme: { type: none|bearer|basic|custom|api_key|..., in, name, prefix }. Discovered when omitted.' }),
            headers: z.record(z.string(), z.any()).optional().openapi({ description: 'Static request headers (plaintext, committed to kortix.yaml).' }),
            create_only: z.boolean().optional().openapi({ description: 'Refuse to update an existing slug.' }),
          }) } } },
      },
      responses: {
        200: json(CrudOkSchema, 'Created/updated'),
        ...errors(400, 403, 409, 501, 502),
      },
    }),
    // Manual parse kept: the connector draft is an opaque record validated
    // downstream; original returns `invalid_json` / `not supported` envelopes.
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.createConnector) return featureNotSupportedResponse(c, 'connector_create');
      let body: any;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      if (body?.create_only !== undefined && typeof body.create_only !== 'boolean') {
        return c.json({ error: 'create_only must be a boolean' }, 400);
      }
      if (body?.provider === 'pipedream' && body?.allow_legacy_pipedream !== true) {
        return c.json(
          {
            error:
              'Pipedream is legacy rollback only. Use provider "composio" for managed SaaS apps. Explicit human approval is required for a legacy Pipedream addition.',
          },
          400,
        );
      }
      delete body.allow_legacy_pipedream;
      const refused = await customSourceRefusal(c, deps, projectId, body);
      if (refused) return c.json(refused, 403);
      let authDiscovery: ConnectorAuthDiscovery | undefined;
      if (body.auth === undefined && deps.discoverConnectorAuth) {
        // `discoverConnectorAuth` → `discoverConnectorAuthFromSource` calls
        // `assertAllowedSourceAddress` on the draft's endpoint URL, which
        // throws a typed `AllowedSourceValidationError` for a non-https /
        // private / local source. That's an EXPECTED user-input validation
        // state — catch it here and return a structured 400 instead of
        // letting it propagate to `app.onError` → Sentry (Better Stack
        // pattern `f5c0ce61…`). Same guard wraps `createConnector` below
        // (the sync path also asserts the source on re-materialize).
        try {
          authDiscovery = await deps.discoverConnectorAuth(projectId, body);
          if (authDiscovery.recommended) body.auth = authDiscovery.recommended;
        } catch (err) {
          const validation = allowedSourceValidationResponse(c, err);
          if (validation) return validation;
          throw err;
        }
      }
      try {
        const result = await deps.createConnector(projectId, admin.accountId, body, admin.userId);
        return result.ok
          ? c.json({ ok: true, sync: result.sync, authDiscovery })
          : c.json(result.body ?? { error: result.error }, result.status as 400 | 403 | 409 | 502);
      } catch (err) {
        const validation = allowedSourceValidationResponse(c, err);
        if (validation) return validation;
        throw err;
      }
    },
  );

  // ── Admin: delete a connector ────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/projects/{projectId}/connectors/{slug}',
      tags: ['connector'],
      summary: 'Delete a connector from kortix.yaml',
      ...auth,
      request: { params: ProjectSlugParam },
      responses: {
        200: json(OkSchema, 'Deleted'),
        ...errors(400, 403, 409, 501, 502),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.deleteConnector) return featureNotSupportedResponse(c, 'connector_delete');
      const result = await deps.deleteConnector(projectId, slug);
      return result.ok
        ? c.json({ ok: true })
        : c.json({ error: result.error }, result.status as 400 | 409 | 502);
    },
  );

  // ── Admin: set a connector's credential value ────────────────────────────
  app.openapi(
    createRoute({
      method: 'put',
      path: '/projects/{projectId}/connectors/{slug}/credential',
      tags: ['connector'],
      summary: "Set a connector's credential value",
      ...auth,
      request: {
        params: ProjectSlugParam,
        body: {
          content: {
            'application/json': { schema: UpdateConnectionCredentialInputSchema },
          },
        },
      },
      responses: {
        200: json(CrudOkSchema, 'Credential set, with the MCP re-sync it ran'),
        ...errors(400, 403, 404, 409, 501),
      },
    }),
    // Manual parse kept: original returns `invalid_json` and a `value is
    // required` 400 (empty string rejected) before delegating.
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.setConnectorCredential)
        return featureNotSupportedResponse(c, 'connector_credential_set');
      let body: any;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const parsed = UpdateConnectionCredentialInputSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            error:
              body?.oauth2 != null
                ? (parsed.error.issues[0]?.message ?? 'invalid OAuth2 credential')
                : 'value is required',
          },
          400,
        );
      }
      let result: CrudOutcome;
      try {
        result = await deps.setConnectorCredential(projectId, slug, parsed.data);
      } catch (error) {
        return c.json({ error: (error as Error).message || 'credential validation failed' }, 400);
      }
      // An MCP connector re-syncs on a credential write: return that run, so
      // the caller sees whether the tools load with the new credential.
      return result.ok
        ? c.json({ ok: true, ...(result.sync ? { sync: result.sync } : {}) })
        : c.json({ error: result.error }, result.status as 400 | 404 | 409);
    },
  );

  // ── Admin: OAuth2 client credentials for the shared account ─────────────
  app.openapi(
    createRoute({
      method: 'put',
      path: '/projects/{projectId}/connectors/{slug}/oauth2/connection',
      tags: ['connector'],
      summary: 'Set OAuth2 client credentials on a connector\'s shared account',
      description:
        'The API trades `client_id` + `client_secret` at `token_url` for an access token now, stores the client credentials encrypted, and refreshes the token before each call needs it. Nothing is stored when the token request fails (503 `oauth2_token_failed`). The secret is never returned.',
      ...auth,
      request: {
        params: ProjectSlugParam,
        body: { content: { 'application/json': { schema: OAuth2ConnectionBody } } },
      },
      responses: {
        200: json(OpaqueSchema, 'Client credentials stored; the first token was issued'),
        ...errors(400, 403, 404, 409, 501, 503),
      },
    }),
    async (c: Context) => {
      const projectId = c.req.param('projectId')!;
      const slug = c.req.param('slug')!;
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.setConnectorCredential) return featureNotSupportedResponse(c, 'connector_credential_set');
      const body = await c.req.json().catch(() => null);
      const parsed = OAuth2ClientCredentialsSchema.safeParse({
        type: 'oauth2_client_credentials',
        token_endpoint_auth_method: 'client_secret_basic',
        ...(body && typeof body === 'object' ? body : {}),
      });
      if (!parsed.success) {
        return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid OAuth2 client credentials', code: 'invalid_oauth2' }, 400);
      }
      let result: Awaited<ReturnType<NonNullable<ConnectorRouterDeps['setConnectorCredential']>>>;
      try {
        result = await deps.setConnectorCredential(projectId, slug, { oauth2: parsed.data });
      } catch (error) {
        const detail = (error as Error).message || 'the token request failed';
        // 503, not 502: the edge never sends a 502 (Cloudflare replaces its body; http-middleware.ts).
        return c.json({ error: 'oauth2_token_failed', code: 'oauth2_token_failed', detail }, 503);
      }
      if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
      return c.json({
        ok: true,
        slug,
        account: result.account ?? null,
        expires_at: result.oauth2ExpiresAt ? new Date(result.oauth2ExpiresAt).toISOString() : null,
      });
    },
  );

  // ── Admin: bind a brokered project secret to a connector ────────────────
  app.openapi(
    createRoute({
      method: 'put',
      path: '/projects/{projectId}/connectors/{slug}/secret-binding',
      tags: ['connectors'],
      summary: "Bind a brokered project secret as a connector's credential",
      ...auth,
      request: {
        params: ProjectSlugParam,
        body: {
          content: { 'application/json': { schema: ConnectorSecretBindingInputSchema } },
        },
      },
      responses: {
        200: json(CrudOkSchema, 'Binding updated, with the MCP re-sync it ran'),
        ...errors(400, 403, 404, 409, 501),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const admin = deps.resolveSecretBindingAdmin
        ? await deps.resolveSecretBindingAdmin(c, projectId)
        : null;
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.setConnectorSecretBinding) {
        return featureNotSupportedResponse(c, 'connector_secret_binding');
      }
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const parsed = ConnectorSecretBindingInputSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: 'secret_identifier is invalid' }, 400);
      }
      const result = await deps.setConnectorSecretBinding(
        projectId,
        slug,
        parsed.data.secret_identifier,
      );
      return result.ok
        ? c.json({ ok: true, ...(result.sync ? { sync: result.sync } : {}) })
        : c.json({ error: result.error }, result.status as 404 | 409);
    },
  );

  // ── Admin: disconnect a connector (remove its credential) ────────────────
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/projects/{projectId}/connectors/{slug}/credential',
      tags: ['connector'],
      summary: 'Disconnect a connector (remove its credential)',
      ...auth,
      request: { params: ProjectSlugParam },
      responses: {
        200: json(OkSchema, 'Disconnected'),
        ...errors(403, 404, 409, 501),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.deleteConnectorCredential)
        return featureNotSupportedResponse(c, 'connector_credential_delete');
      const result = await deps.deleteConnectorCredential(projectId, slug, admin.userId);
      return result.ok
        ? c.json({ ok: true })
        : c.json({ error: result.error }, result.status as 404 | 409);
    },
  );
}

/** The remote address a draft points calls at, or null (a toolkit, a repo file). */
function remoteSourceOf(draft: Record<string, unknown>): string | null {
  for (const key of ['url', 'endpoint', 'baseUrl', 'spec'] as const) {
    const value = draft[key];
    if (typeof value === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim())) return value.trim();
  }
  return null;
}

/**
 * An agent session adds only servers the project already has, or catalogue
 * apps (`discover/install`): a prompt can then never point the project's
 * tools at a server nobody chose. A person confirms a custom server on the
 * page `setup_url` opens. A `baseUrl` from an agent always needs a person: it
 * redirects every call of an existing profile.
 */
async function customSourceRefusal(
  c: Context,
  deps: ConnectorRouterDeps,
  projectId: string,
  draft: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const source = remoteSourceOf(draft);
  if (!source || !deps.isAgentCaller?.(c)) return null;
  const identity = connectorIdentity(draft as Parameters<typeof connectorIdentity>[0]);
  const known = identity
    ? ((await deps.listConnectorIdentities?.(projectId)) ?? []).some((p) => p.identity === identity)
    : false;
  if (known && draft.baseUrl === undefined) return null;
  return {
    error: `An agent cannot add the custom server ${source}. A person adds it at setup_url, or the agent installs a catalogue app (add_connector with app).`,
    code: 'custom_connector_needs_human',
    setup_url: deps.customConnectorSetupUrl?.(projectId, draft) ?? null,
  };
}
