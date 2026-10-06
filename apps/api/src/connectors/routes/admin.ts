/** Admin routes: list, create, delete a connector and set or bind its credential. */
import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { UpdateConnectionCredentialInputSchema } from '@kortix/api-contract';
import type { Context } from 'hono';
import { INVALID_SOURCE_ADDRESS_CODE, isAllowedSourceValidationError } from '../../marketplace/catalog';
import { auth, errors, json, lenientBody } from '../../openapi';
import { UnsafeEgressError } from '../../shared/ssrf-guard';
import type { ConnectorAuthDiscovery } from '../auth-discovery';
import type { ConnectorRouterDeps, CrudOutcome } from '../router';
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
function allowedSourceValidationResponse(c: Context, err: unknown): Response | null {
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
        200: json(OkSchema, 'Credential set'),
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
      return result.ok
        ? c.json({ ok: true })
        : c.json({ error: result.error }, result.status as 400 | 404 | 409);
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
        200: json(OkSchema, 'Binding updated'),
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
        ? c.json({ ok: true })
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
