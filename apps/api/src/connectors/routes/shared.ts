/** Response schemas, path params and envelopes shared by the connector route groups. */
import { z } from '@hono/zod-openapi';
import type { Context } from 'hono';

// ── Response schemas ─────────────────────────────────────────────────────────
// Connector catalog/admin shapes are permissive (opaque tool metadata); the
// /call result `data` and the pipedream/policy payloads are modeled loosely
// because they pass through opaque upstream content.

// Connector catalog/admin entries carry opaque tool metadata (inputSchema, risk)
// — documented by example but modeled with `z.any()` so the strict
// zod-openapi handler-return check accepts the real interface-typed payloads
// without rejecting any currently-valid shape.
export const CatalogActionSchema = z
  .object({
    path: z.string(),
    name: z.string(),
    description: z.string(),
    risk: z.string(),
    inputSchema: z.any().nullable(),
    outputSchema: z.any().nullable().optional(),
  })
  .openapi('ConnectorCatalogAction');
export const CatalogAccountSchema = z
  .object({
    connection_id: z.string(),
    label: z.string(),
    owner_type: z.string(),
    is_default: z.boolean(),
  })
  .openapi('ConnectorCatalogAccount');
export const CatalogConnectorSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    provider: z.string(),
    platform: z.string().nullable().optional(),
    iconUrl: z.string().nullable().optional(),
    status: z.string(),
    actions: z.array(CatalogActionSchema),
    /**
     * The accounts THIS principal may run this connector as, default first.
     * One connector can hold the project's shared account and each member's
     * own — this is what tells a caller (human or agent) that more than one
     * exists, without a separate accounts call.
     */
    accounts: z.array(CatalogAccountSchema).optional(),
    /** Label of the account an unnamed call resolves to, or null if none. */
    default_account: z.string().nullable().optional(),
  })
  .openapi('ConnectorCatalogConnector');
export const ConnectorsResponseSchema = z
  .object({ connectors: z.array(CatalogConnectorSchema) })
  .openapi('Connectors');

export const AdminConnectorSchema = CatalogConnectorSchema.extend({
  credentialMode: z.literal('shared'),
  authorizationStrategy: z.enum(['project', 'user']),
  requestAuthType: z.enum([
    'none',
    'bearer',
    'basic',
    'custom',
    'api_key',
    'oauth1',
    'hmac',
    'aws_sigv4',
    'mtls',
  ]),
  sensitive: z.boolean(),
  authSecret: z.string().nullable(),
  secretIdentifier: z.string().nullable(),
  credentialSource: z.enum(['none', 'stored', 'project_secret', 'platform']),
  secretSet: z.boolean(),
  lastError: z.string().nullable(),
}).openapi('ConnectorAdminConnector');
export const AdminConnectorsResponseSchema = z
  .object({ connectors: z.array(AdminConnectorSchema) })
  .openapi('ConnectorAdminConnectors');

// /call returns one of several envelopes by status; model permissively.
export const CallResponseSchema = z
  .object({
    ok: z.boolean(),
    data: z.any().optional(),
    risk: z.any().optional(),
    status: z.string().optional(),
    reason: z.any().optional(),
    // Which connection ran the call, so the transcript can always answer
    // "whose account sent that". Absent when the connector resolved no
    // connection (a public/no-auth connector).
    account: z
      .object({
        connection_id: z.string(),
        label: z.string(),
        owner_type: z.string(),
      })
      .optional(),
    // Additive call contract. `data` keeps the raw upstream answer.
    binding: z.string().nullable().optional(),
    output: z.any().optional(),
    upstream_status: z.number().int().nullable().optional(),
    upstream_error: z.string().optional(),
    retry_after_seconds: z.number().int().optional(),
  })
  .passthrough()
  .openapi('ConnectorCallResult');

export const OkSchema = z.object({ ok: z.boolean() }).passthrough();
export const SyncResultSchema = z
  .object({
    synced: z.number(),
    errors: z.array(z.object({ slug: z.string(), error: z.string() })),
  })
  .passthrough()
  .openapi('ConnectorSyncResult');
export const CrudOkSchema = z.object({ ok: z.boolean(), sync: z.any().optional() }).passthrough();
export const AuthDiscoverySchema = z.record(z.string(), z.any());
export const OpaqueSchema = z.record(z.string(), z.any());
export const AttachmentUploadResponseSchema = z
  .object({
    attachment_id: z.string().uuid(),
    filename: z.string(),
    content_type: z.string(),
    content_disposition: z.enum(['attachment', 'inline']),
    content_id: z.string().optional(),
    size: z.number().int().positive(),
    expires_at: z.string(),
    /** Paste into call args; the gateway swaps in the file server-side. */
    ref: z.object({ $kortix_attachment: z.string().uuid() }),
  })
  .openapi('ConnectorAttachmentUpload');

// Path-param schema shared by all admin routes.
export const ProjectParam = z.object({ projectId: z.string() });
export const ProjectSlugParam = z.object({ projectId: z.string(), slug: z.string() });
export const ConnectorSecretBindingInputSchema = z.object({
  secret_identifier: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)
    .nullable(),
});

// GET .../catalog query params, shared by all three catalog-listing routes
// below (token-scoped, legacy /connectors, and project-explicit).
export const CatalogQuerySchema = z.object({
  /** Restrict the catalog to one connector by slug. */
  slug: z.string().optional(),
  /** `false` omits the full per-action JSON Schema. Absent means INCLUDE:
   *  sandboxes run a baked CLI that reads schemas from these routes, so the
   *  default must match what those clients were built against. */
  include_schemas: z.enum(['true', 'false']).optional(),
  /** `true` adds each action's `outputSchema`. Absent means OMIT. */
  include_output_schemas: z.enum(['true', 'false']).optional(),
});

/**
 * Stable error code the SDK's `makeRequest` classifies as an EXPECTED
 * "feature not enabled on this deployment" state and drops from Sentry
 * (the dashboard already surfaces it as a graceful "unavailable" UI state,
 * e.g. the connector-auth-discovery InfoBanner). Without this typed code the
 * bare `501 "not supported"` body surfaced as an opaque `ApiError` in
 * Better Stack (pattern `1f3c4d96…`) — a known unsupported state paging like
 * a real defect. Mirrors the `GitOperationError`/Daytona typed-envelope
 * pattern (PRs #5167/#5175/#5188) and the no-compaction-model classification
 * (PR #5183): a typed code lets the telemetry gate distinguish "deployment
 * doesn't offer this capability" (501 feature_not_supported → silent) from a
 * genuine server bug (any other 501 → report).
 */
export const FEATURE_NOT_SUPPORTED_CODE = 'feature_not_supported';

/** 501 envelope for an optional connector capability that this deployment
 *  doesn't wire. `feature` identifies which capability is missing so the
 *  dashboard can name it. */
export function featureNotSupportedResponse(c: Context, feature: string) {
  return c.json(
    {
      error: FEATURE_NOT_SUPPORTED_CODE,
      code: FEATURE_NOT_SUPPORTED_CODE,
      message: 'This capability is not enabled on this deployment.',
      feature,
    },
    501,
  );
}
