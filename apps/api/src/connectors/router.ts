/**
 * Connector HTTP surface — one Hono router with two faces:
 *
 *   Gateway (sandbox-facing, KORTIX_CLI_TOKEN):
 *     GET  /v1/connectors/catalog             — catalog the session can use
 *     POST /v1/connectors/call                — { connector, action, args } → run
 *
 *   Admin (dashboard-facing, user auth + project access):
 *     GET  /v1/connectors/projects/:projectId/connectors          — list + status
 *     POST /v1/connectors/projects/:projectId/connectors/sync     — re-materialize from kortix.yaml
 *
 * Connectors are project-wide visible — the only access gate is the agent-side
 * `[[agents]].connectors` grant (iam/agent-scope.ts), enforced below.
 *
 * Built against an injected `ConnectorRouterDeps` so the e2e drives the real HTTP
 * layer + real gateway logic with in-memory fakes (db + upstream) at the
 * boundary; production wires DB-backed deps (db-deps.ts). See docs/specs/connector.md.
 */
import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import {
  type UpdateConnectionCredentialInput,
  UpdateConnectionCredentialInputSchema,
} from '@kortix/api-contract';
import type { AgentGrant } from '@kortix/db';
import { SLUG_RE } from '@kortix/manifest-schema';
import type { Context } from 'hono';
import { featureDisabledBody } from '../feature-flags/gate';
import type { FeatureFlagKey } from '../feature-flags/registry';
import { agentMayUseConnector } from '../iam/agent-scope';
import { isAllowedSourceValidationError } from '../marketplace/catalog';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import { canonicalConnectorAlias } from '../projects/lib/session-connector-bindings';
import {
  type ConnectorAttachmentStore,
  MAX_CONNECTOR_ATTACHMENT_BYTES,
  type StageConnectorAttachmentInput,
} from './attachments';
import type { ConnectorAuthDiscovery } from './auth-discovery';
import type { ConnectorAuth } from './call';
import { type GatewayDeps, handleCall } from './gateway';

// ── Response schemas ─────────────────────────────────────────────────────────
// Connector catalog/admin shapes are permissive (opaque tool metadata); the
// /call result `data` and the pipedream/policy payloads are modeled loosely
// because they pass through opaque upstream content.

// Connector catalog/admin entries carry opaque tool metadata (inputSchema, risk)
// — documented by example but modeled with `z.any()` so the strict
// zod-openapi handler-return check accepts the real interface-typed payloads
// without rejecting any currently-valid shape.
const CatalogActionSchema = z
  .object({
    path: z.string(),
    name: z.string(),
    description: z.string(),
    risk: z.string(),
    inputSchema: z.any().nullable(),
  })
  .openapi('ConnectorCatalogAction');
const CatalogConnectorSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    provider: z.string(),
    platform: z.string().nullable().optional(),
    iconUrl: z.string().nullable().optional(),
    status: z.string(),
    actions: z.array(CatalogActionSchema),
  })
  .openapi('ConnectorCatalogConnector');
const ConnectorsResponseSchema = z
  .object({ connectors: z.array(CatalogConnectorSchema) })
  .openapi('Connectors');

const AdminConnectorSchema = CatalogConnectorSchema.extend({
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
}).openapi('ConnectorAdminConnector');
const AdminConnectorsResponseSchema = z
  .object({ connectors: z.array(AdminConnectorSchema) })
  .openapi('ConnectorAdminConnectors');

// /call returns one of several envelopes by status; model permissively.
const CallResponseSchema = z
  .object({
    ok: z.boolean(),
    data: z.any().optional(),
    risk: z.any().optional(),
    status: z.string().optional(),
    reason: z.any().optional(),
  })
  .passthrough()
  .openapi('ConnectorCallResult');

const OkSchema = z.object({ ok: z.boolean() }).passthrough();
const SyncResultSchema = z
  .object({
    synced: z.number(),
    errors: z.array(z.object({ slug: z.string(), error: z.string() })),
  })
  .passthrough()
  .openapi('ConnectorSyncResult');
const CrudOkSchema = z.object({ ok: z.boolean(), sync: z.any().optional() }).passthrough();
const AuthDiscoverySchema = z.record(z.string(), z.any());
const OpaqueSchema = z.record(z.string(), z.any());
const AttachmentUploadResponseSchema = z
  .object({
    attachment_id: z.string().uuid(),
    filename: z.string(),
    content_type: z.string(),
    content_disposition: z.enum(['attachment', 'inline']),
    content_id: z.string().optional(),
    size: z.number().int().positive(),
    expires_at: z.string(),
  })
  .openapi('ConnectorAttachmentUpload');

export interface ConnectorPrincipal {
  userId: string;
  accountId: string;
  projectId: string;
  sessionId: string | null;
  /** The acting identity resolved to its group memberships. */
  subject: { userId: string; groupIds: string[] };
  /** Per-agent grant from the session token — restricts which connectors this
   *  agent may call. Null = no restriction (non-agent token). */
  agentGrant?: AgentGrant | null;
}

interface CatalogAction {
  path: string; // connector-relative
  name: string;
  description: string;
  risk: string;
  inputSchema: Record<string, unknown> | null;
}
export interface CatalogConnector {
  slug: string;
  name: string;
  provider: string;
  /** Channel provider only: native platform backing this connection. */
  platform?: string | null;
  iconUrl?: string | null;
  status: string;
  actions: CatalogAction[];
}

export interface AdminConnectorView extends CatalogConnector {
  authSecret: string | null;
  /** Project secret identifier used as the connector credential source. */
  secretIdentifier: string | null;
  /** Credential location. No credential value is returned. */
  credentialSource: 'none' | 'stored' | 'project_secret' | 'platform';
  /** Credential storage mode. Always `shared` — `per_user` (each member's
   *  own) was removed 2026-07-05. */
  credentialMode: 'shared';
  authorizationStrategy: 'project' | 'user';
  /** Authentication shape required when a member adds a private credential. */
  requestAuthType: ConnectorAuth['type'];
  /** Marked sensitive — its reads gate too (require_approval by default). */
  sensitive: boolean;
  /** Whether the shared credential is set. */
  secretSet: boolean;
}

interface SyncResult {
  synced: number;
  errors: Array<{ slug: string; error: string }>;
}

type CrudOutcome =
  | { ok: true; sync?: SyncResult }
  // `body` overrides the default `{ error }` envelope when the failure carries a
  // machine-readable contract (today: the `feature_disabled` 403).
  | { ok: false; error: string; status: number; body?: Record<string, unknown> };

import {
  type PolicyArgCondition,
  areValidConditions,
  isValidMatcher,
  normalizeConditions,
} from './policy';

type PolicyAction = 'always_run' | 'require_approval' | 'block';
export type DefaultMode = 'risk' | 'allow_all';

export interface ProjectPolicyView {
  match: string;
  action: PolicyAction;
  /** Optional ARGUMENT conditions — ALL must hold for the rule to apply. Lets a
   *  rule say "only to these recipients", which a tool-name pattern cannot. */
  conditions?: PolicyArgCondition[] | null;
}

export interface ProjectPoliciesViewResponse {
  policies: ProjectPolicyView[];
  defaultMode: DefaultMode;
  errors: Array<{ path: string; error: string }>;
}

export interface ConnectorRouterDeps {
  /** Gateway auth: resolve the connector token → principal, or null for 401. */
  resolvePrincipal(c: Context): Promise<ConnectorPrincipal | null>;
  /**
   * Gateway auth for the project-EXPLICIT routes (/projects/:id/{catalog,call}).
   * Runs under combinedAuth; accepts ANY valid principal (session token OR a
   * logged-in user token) and pins the project from the path. Null → 403.
   */
  resolveProjectPrincipal(c: Context, projectId: string): Promise<ConnectorPrincipal | null>;
  /** Build the DB-backed (or fake) gateway deps for a principal. */
  makeGatewayDeps(p: ConnectorPrincipal): GatewayDeps;
  /** The catalog the principal can actually use (agent-grant filtered, blocked hidden). */
  listCatalog(p: ConnectorPrincipal): Promise<CatalogConnector[]>;
  /** Private raw-byte staging used by the MCP attachment transport. */
  attachmentStore?: ConnectorAttachmentStore;
  /**
   * Per-project feature-flag state. Injected (not imported) so this router
   * stays free of the DB import graph and the in-memory e2e keeps driving the
   * real HTTP layer. Required, not optional: a new deps implementation must
   * decide what the gated routes see rather than silently opening them.
   */
  featureFlagEnabled(projectId: string, key: FeatureFlagKey): Promise<boolean>;
  /** Admin auth: resolve user + verify project access, or null for 401/403. */
  resolveAdmin(
    c: Context,
    projectId: string,
  ): Promise<{ accountId: string; userId: string } | null>;
  /** Read-tier auth for the connectors LIST: `project.connector.read` is in the
   *  member baseline (the Connectors/Channels rail sections gate on it), so the
   *  list must not require connector.write like the mutations do. Falls back to
   *  resolveAdmin when a deps implementation doesn't provide it. */
  resolveReader?(
    c: Context,
    projectId: string,
  ): Promise<{ accountId: string; userId: string } | null>;
  /** Read-tier authorization for exact project secret identifiers. */
  resolveSecretReader?(
    c: Context,
    projectId: string,
  ): Promise<{ accountId: string; userId: string } | null>;
  listConnectors(projectId: string): Promise<AdminConnectorView[]>;
  syncConnectors(projectId: string, accountId: string): Promise<SyncResult>;
  /** Create/update a connector in kortix.yaml + materialize. */
  createConnector?(
    projectId: string,
    accountId: string,
    draft: Record<string, unknown>,
  ): Promise<CrudOutcome>;
  discoverConnectorAuth?(
    projectId: string,
    draft: Record<string, unknown>,
  ): Promise<ConnectorAuthDiscovery>;
  /** Remove a connector from kortix.yaml + drop its rows. */
  deleteConnector?(projectId: string, slug: string): Promise<CrudOutcome>;
  /** Set a connector's server-side static or OAuth2 credential. */
  setConnectorCredential?(
    projectId: string,
    slug: string,
    input: UpdateConnectionCredentialInput,
  ): Promise<CrudOutcome>;
  /** Bind or unbind a brokered project secret as the connector credential. */
  setConnectorSecretBinding?(
    projectId: string,
    slug: string,
    secretIdentifier: string | null,
  ): Promise<CrudOutcome>;
  /** Secret binding requires both connector-write and secret-write. */
  resolveSecretBindingAdmin?(
    c: Context,
    projectId: string,
  ): Promise<{ accountId: string; userId: string } | null>;
  /** `userId` is accepted for back-compat but unused — a connector has exactly
   *  one (shared) credential since `per_user` was removed 2026-07-05. */
  deleteConnectorCredential?(projectId: string, slug: string, userId: string): Promise<CrudOutcome>;
  /** `shared` is the only credential mode (`per_user` removed 2026-07-05). This
   *  route is kept as a restricted no-op for back-compat callers — the router
   *  rejects any `mode` other than `shared` before calling this. */
  setCredentialMode?(
    projectId: string,
    accountId: string,
    slug: string,
    mode: 'shared',
  ): Promise<CrudOutcome>;
  /** Set the exclusive connection owner model for this connector. */
  setAuthorizationStrategy?(
    projectId: string,
    accountId: string,
    slug: string,
    authorizationStrategy: 'project' | 'user',
  ): Promise<CrudOutcome>;
  /** Toggle a connector's `sensitive` flag (gate reads too) in kortix.yaml + re-sync. */
  setSensitive?(
    projectId: string,
    accountId: string,
    slug: string,
    sensitive: boolean,
  ): Promise<CrudOutcome>;
  /** Rename a connector (display label) in kortix.yaml + re-sync. */
  setConnectorName?(
    projectId: string,
    accountId: string,
    slug: string,
    name: string,
  ): Promise<CrudOutcome>;
  /** Read a connector's [[connectors.policies]] (per-tool/per-pattern permissions). */
  getConnectorPolicies?(
    projectId: string,
    slug: string,
  ): Promise<{ policies: Array<{ match: string; action: string }> } | null>;
  /** Read a connector's definition (provider + connection fields) from kortix.yaml for editing. */
  getConnectorConfig?(
    projectId: string,
    slug: string,
  ): Promise<{
    slug: string;
    name: string;
    provider: string;
    platform?: string | null;
    credentialMode: 'shared';
    authorizationStrategy: 'project' | 'user';
    app: string | null;
    account: string | null;
    url: string | null;
    transport: 'http' | 'sse' | null;
    endpoint: string | null;
    baseUrl: string | null;
    spec: string | null;
    tunnelIds?: string[];
    auth: {
      type:
        | 'none'
        | 'bearer'
        | 'basic'
        | 'custom'
        | 'api_key'
        | 'oauth1'
        | 'hmac'
        | 'aws_sigv4'
        | 'mtls';
      in: 'header' | 'query' | 'cookie';
      name: string | null;
      prefix: string | null;
    };
  } | null>;
  /** Replace a connector's `policies:` list in kortix.yaml + re-sync. */
  setConnectorPolicies?(
    projectId: string,
    accountId: string,
    slug: string,
    policies: Array<{ match: string; action: string }>,
  ): Promise<CrudOutcome>;
  /** Pipedream 1-click: mint a connect token (for the frontend SDK overlay) + link.
   *  null = not pipedream. `userId` is accepted for back-compat but unused —
   *  the connection is always the shared project account (`per_user` removed
   *  2026-07-05). */
  pipedreamConnect?(
    projectId: string,
    slug: string,
    userId: string,
    redirects?: { success?: string; error?: string },
  ): Promise<{ token?: string; app?: string; connectUrl?: string } | null>;
  /** Pipedream 1-click: after the user finishes, persist the shared account binding. */
  pipedreamFinalize?(
    projectId: string,
    slug: string,
    userId: string,
  ): Promise<{ connected: boolean; accountId?: string } | null>;
  /** Pipedream webhook: verify sig + finalize. Returns false on bad signature. */
  pipedreamWebhook?(externalUserId: string, sig: string | null): Promise<boolean>;
  /** Browse the Pipedream app catalogue (search + paginate). */
  listPipedreamApps?(
    query: string | undefined,
    cursor: string | undefined,
  ): Promise<{
    apps: Array<{
      slug: string;
      name: string;
      description: string | null;
      imgSrc: string | null;
      authType: 'oauth';
      categories: string[];
    }>;
    nextCursor?: string;
    hasMore: boolean;
  }>;
  /** Browse the direct integrations.sh catalogue. */
  listDiscoverConnectors?(input: {
    q?: string;
    cursor?: string;
  }): Promise<unknown>;
  /** Resolve every known surface for one trusted catalogue record. */
  getDiscoverConnector?(id: string): Promise<unknown>;
  /** Read project-level `policies:` list + `policy.default_mode` from kortix.yaml. */
  getProjectPolicies?(projectId: string): Promise<ProjectPoliciesViewResponse | null>;
  /** Replace project policies + default_mode (CRUD round-trips to kortix.yaml). */
  setProjectPolicies?(
    projectId: string,
    accountId: string,
    policies: ProjectPolicyView[],
    defaultMode: DefaultMode,
  ): Promise<CrudOutcome>;
}

// Path-param schema shared by all admin routes.
const ProjectParam = z.object({ projectId: z.string() });
const ProjectSlugParam = z.object({ projectId: z.string(), slug: z.string() });
const ConnectorSecretBindingInputSchema = z.object({
  secret_identifier: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)
    .nullable(),
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
function featureNotSupportedResponse(c: Context, feature: string) {
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

function decodedAttachmentHeader(c: Context, name: string): string {
  const value = c.req.header(name);
  if (!value) return '';
  try {
    return decodeURIComponent(value).trim();
  } catch {
    throw new Error(`${name} is not valid URI-encoded text`);
  }
}

function attachmentMetadata(c: Context): Omit<StageConnectorAttachmentInput, 'bytes'> {
  const filename = decodedAttachmentHeader(c, 'X-Kortix-Attachment-Filename');
  const contentType = (c.req.header('content-type') ?? '').split(';', 1).at(0)?.trim() ?? '';
  const disposition = c.req.header('X-Kortix-Attachment-Disposition') ?? 'attachment';
  const contentId = decodedAttachmentHeader(c, 'X-Kortix-Attachment-Content-Id');
  if (!filename || filename.length > 512) {
    throw new Error('X-Kortix-Attachment-Filename is required and must not exceed 512 characters');
  }
  if (!contentType || contentType.length > 255) {
    throw new Error('Content-Type is required and must not exceed 255 characters');
  }
  if (disposition !== 'attachment' && disposition !== 'inline') {
    throw new Error('X-Kortix-Attachment-Disposition must be attachment or inline');
  }
  if (contentId.length > 512) {
    throw new Error('X-Kortix-Attachment-Content-Id must not exceed 512 characters');
  }
  return {
    filename,
    contentType,
    contentDisposition: disposition,
    ...(contentId ? { contentId } : {}),
  };
}

async function readAttachmentBytes(c: Context): Promise<Uint8Array> {
  const body = c.req.raw.body;
  if (!body) return new Uint8Array();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CONNECTOR_ATTACHMENT_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('attachment exceeds the 25 MiB limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

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
  if (!isAllowedSourceValidationError(err)) return null;
  return c.json(
    {
      error: err.code,
      code: err.code,
      message: err.message,
    },
    400,
  );
}

export function createConnectorRouter(deps: ConnectorRouterDeps): OpenAPIHono {
  const app = makeOpenApiApp();

  // Shared gateway logic — used by BOTH the legacy flat routes (project derived
  // from a scoped session token) and the project-EXPLICIT routes
  // (project from the path, any valid principal). One implementation, two faces.
  const catalogResponse = async (c: any, p: ConnectorPrincipal) => {
    const connectors = await deps.listCatalog(p);
    return c.json({ connectors });
  };
  const callResponse = async (c: any, p: ConnectorPrincipal) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const connectorSlug = typeof body?.connector === 'string' ? body.connector.trim() : '';
    const actionPath = typeof body?.action === 'string' ? body.action.trim() : '';
    if (!connectorSlug || !actionPath) {
      return c.json({ error: 'connector and action are required' }, 400);
    }
    // Validate request shape before authorization. CLI discovery and describe
    // expose tools as `connector.action`, so a client can accidentally put that
    // complete reference in the connector field. Reporting that syntax error as
    // connector_not_assigned falsely blames the session grant.
    if (!SLUG_RE.test(connectorSlug)) {
      const separator = connectorSlug.indexOf('.');
      if (separator > 0 && separator < connectorSlug.length - 1) {
        return c.json(
          {
            ok: false,
            status: 'error',
            reason: 'invalid_tool_reference',
            message:
              'The connector field contains a dotted tool reference. Send the connector and action separately.',
            connector: connectorSlug.slice(0, separator),
            action: connectorSlug.slice(separator + 1),
          },
          400,
        );
      }
      return c.json(
        {
          ok: false,
          status: 'error',
          reason: 'invalid_connector_slug',
          message:
            'The connector field must be a lowercase connector slug containing only letters, digits, underscores, or hyphens.',
        },
        400,
      );
    }
    // Per-agent connector assignment: a scoped agent may call only the connector
    // connectors its kortix.yaml overlay lists. Default-deny otherwise.
    if (!agentMayUseConnector(p.agentGrant ?? null, canonicalConnectorAlias(connectorSlug))) {
      return c.json({ ok: false, status: 'denied', reason: 'connector_not_assigned' }, 403);
    }
    const args =
      body?.args && typeof body.args === 'object' ? (body.args as Record<string, unknown>) : {};
    // Compatibility hint from older clients. The gateway may reuse the named
    // pending row, but it returns immediately and never polls that execution.
    const approvalExecutionId =
      typeof body?.approval_execution_id === 'string' ? body.approval_execution_id : null;
    const result = await handleCall(deps.makeGatewayDeps(p), {
      projectId: p.projectId,
      accountId: p.accountId,
      subject: p.subject,
      sessionId: p.sessionId,
      connectorSlug,
      actionPath,
      args,
      approvalExecutionId,
    });
    switch (result.status) {
      case 'ok':
        return c.json({ ok: true, data: result.data, risk: result.risk });
      case 'pending_approval':
        return c.json(
          {
            ok: false,
            status: 'pending_approval',
            reason: result.reason,
            execution_id: result.executionId ?? null,
            retryable: result.retryable ?? false,
            approval_url: result.approvalUrl ?? null,
            approval_summary: result.approvalSummary ?? null,
            approval_instructions: result.approvalInstructions ?? null,
          },
          202,
        );
      case 'denied':
        return c.json(
          { ok: false, status: 'denied', reason: result.reason },
          result.reason === 'connector_not_found' || result.reason === 'action_not_found'
            ? 404
            : 403,
        );
      default:
        // 500, not 502 — Cloudflare eats 502 bodies (see route schema note).
        return c.json({ ok: false, status: 'error', reason: result.reason }, 500);
    }
  };

  const attachmentResponse = async (c: Context, p: ConnectorPrincipal) => {
    if (!deps.attachmentStore) return featureNotSupportedResponse(c, 'connector_attachments');
    if (!agentMayUseConnector(p.agentGrant ?? null, canonicalConnectorAlias('kortix_email'))) {
      return c.json({ ok: false, status: 'denied', reason: 'connector_not_assigned' }, 403);
    }
    let metadata: Omit<StageConnectorAttachmentInput, 'bytes'>;
    try {
      metadata = attachmentMetadata(c);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
    const declaredSize = Number(c.req.header('content-length') ?? '');
    if (Number.isFinite(declaredSize) && declaredSize > MAX_CONNECTOR_ATTACHMENT_BYTES) {
      return c.json({ error: 'attachment exceeds the 25 MiB limit' }, 413);
    }
    let bytes: Uint8Array;
    try {
      bytes = await readAttachmentBytes(c);
    } catch (error) {
      if ((error as Error).message.includes('25 MiB')) {
        return c.json({ error: (error as Error).message }, 413);
      }
      throw error;
    }
    try {
      return c.json(
        await deps.attachmentStore.stage(
          {
            accountId: p.accountId,
            projectId: p.projectId,
            sessionId: p.sessionId,
            userId: p.userId,
          },
          { ...metadata, bytes },
        ),
        201,
      );
    } catch (error) {
      const message = (error as Error).message || 'attachment_upload_failed';
      if (message.includes('25 MiB')) return c.json({ error: message }, 413);
      if (
        message === 'attachment is empty' ||
        message === 'filename must be a plain filename' ||
        message === 'content_type is required'
      ) {
        return c.json({ error: message }, 400);
      }
      console.error('[connector-attachments] upload failed', error);
      return c.json({ error: 'attachment_upload_failed' }, 500);
    }
  };

  // ── Gateway: list usable connectors ──────────────────────────────────────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/catalog',
      tags: ['connector'],
      summary: 'List the connectors the connector principal can use',
      ...auth,
      responses: {
        200: json(ConnectorsResponseSchema, 'Connector catalog for this principal'),
        ...errors(401),
      },
    }),
    async (c: any) => {
      const p = await deps.resolvePrincipal(c);
      if (!p) return c.json({ error: 'unauthorized' }, 401);
      return catalogResponse(c, p);
    },
  );

  // Compatibility for connector clients published before the canonical
  // `/catalog` route. New clients must not use this duplicate noun path.
  app.openapi(
    createRoute({
      method: 'get',
      path: '/connectors',
      tags: ['connector'],
      summary: 'List usable connectors through the legacy route',
      deprecated: true,
      ...auth,
      responses: {
        200: json(ConnectorsResponseSchema, 'Connector catalog for this principal'),
        ...errors(401),
      },
    }),
    async (c: any) => {
      const p = await deps.resolvePrincipal(c);
      if (!p) return c.json({ error: 'unauthorized' }, 401);
      return catalogResponse(c, p);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/attachments',
      tags: ['connector'],
      summary: 'Stage a private attachment from raw bytes',
      ...auth,
      responses: {
        201: json(AttachmentUploadResponseSchema, 'Opaque attachment handle'),
        400: json(OpaqueSchema, 'Invalid attachment metadata or empty body'),
        401: json(OpaqueSchema, 'Unauthorized'),
        403: json(OpaqueSchema, 'Denied'),
        413: json(OpaqueSchema, 'Attachment exceeds the size limit'),
        500: json(OpaqueSchema, 'Attachment storage failure'),
        501: json(OpaqueSchema, 'Attachment staging is unavailable'),
      },
    }),
    async (c: Context) => {
      const p = await deps.resolvePrincipal(c);
      if (!p) return c.json({ error: 'unauthorized' }, 401);
      return attachmentResponse(c, p);
    },
  );

  // ── Admin: browse direct connector surfaces ───────────────────────────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{projectId}/discover/connectors',
      tags: ['connector'],
      summary: 'Browse the integrations.sh catalogue',
      ...auth,
      request: {
        params: ProjectParam,
        query: z.object({ q: z.string().optional(), cursor: z.string().optional() }),
      },
      responses: {
        200: json(OpaqueSchema, 'Direct connector catalogue page'),
        ...errors(403, 502),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      // Flag gate AFTER authz: a non-admin still learns nothing.
      if (!(await deps.featureFlagEnabled(projectId, 'connectors_api_discover'))) {
        return c.json(featureDisabledBody('connectors_api_discover'), 403);
      }
      if (!deps.listDiscoverConnectors) return c.json({ error: 'catalogue unavailable' }, 502);
      try {
        return c.json(
          await deps.listDiscoverConnectors({
            q: c.req.query('q') || undefined,
            cursor: c.req.query('cursor') || undefined,
          }),
        );
      } catch (error) {
        return c.json({ error: (error as Error).message || 'catalogue unavailable' }, 502);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/projects/{projectId}/attachments',
      tags: ['connector'],
      summary: 'Stage a private attachment in a project from raw bytes',
      ...auth,
      request: { params: ProjectParam },
      responses: {
        201: json(AttachmentUploadResponseSchema, 'Opaque attachment handle'),
        400: json(OpaqueSchema, 'Invalid attachment metadata or empty body'),
        403: json(OpaqueSchema, 'Denied'),
        413: json(OpaqueSchema, 'Attachment exceeds the size limit'),
        500: json(OpaqueSchema, 'Attachment storage failure'),
        501: json(OpaqueSchema, 'Attachment staging is unavailable'),
      },
    }),
    async (c: Context) => {
      const projectId = c.req.param('projectId');
      if (!projectId) return c.json({ error: 'forbidden' }, 403);
      const p = await deps.resolveProjectPrincipal(c, projectId);
      if (!p) return c.json({ error: 'forbidden' }, 403);
      return attachmentResponse(c, p);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{projectId}/discover/connectors/detail',
      tags: ['connector'],
      summary: 'Resolve the surfaces for an integrations.sh catalogue record',
      ...auth,
      request: {
        params: ProjectParam,
        query: z.object({ id: z.string().min(1) }),
      },
      responses: {
        200: json(OpaqueSchema, 'Connector surface detail'),
        ...errors(403, 404, 502),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      // Flag gate AFTER authz: a non-admin still learns nothing.
      if (!(await deps.featureFlagEnabled(projectId, 'connectors_api_discover'))) {
        return c.json(featureDisabledBody('connectors_api_discover'), 403);
      }
      if (!deps.getDiscoverConnector) return c.json({ error: 'catalogue unavailable' }, 502);
      try {
        return c.json(await deps.getDiscoverConnector(c.req.query('id')));
      } catch (error) {
        const message = (error as Error).message || 'catalogue unavailable';
        return c.json({ error: message }, message === 'Connector not found' ? 404 : 502);
      }
    },
  );

  // ── Gateway: run a tool call ─────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: 'post',
      path: '/call',
      tags: ['connector'],
      summary: 'Run a connector action (generic connector gateway)',
      ...auth,
      request: {
        body: {
          content: {
            'application/json': {
              // Fields optional at the schema layer: the handler does auth FIRST
              // (401) then its own field validation (custom invalid_json / "connector
              // and action are required" 400 envelopes). A required schema here would
              // 400 before the auth check — see the handler note below.
              schema: z.object({
                connector: z.string().optional(),
                action: z.string().optional(),
                args: z.record(z.string(), z.any()).optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: json(CallResponseSchema, 'Tool result (ok)'),
        202: json(CallResponseSchema, 'Pending approval'),
        400: json(CallResponseSchema, 'Bad request (invalid_json / missing fields)'),
        401: json(CallResponseSchema, 'Unauthorized'),
        403: json(CallResponseSchema, 'Denied'),
        404: json(CallResponseSchema, 'Connector or action not found'),
        // 500, NOT 502: Cloudflare replaces origin 502/504 bodies with its own
        // branded error page, which destroys the JSON `reason` before the
        // sandbox SDK can read it — the agent then sees a bare "HTTP 502" and
        // can't self-correct. 500 passes through with the body intact.
        500: json(CallResponseSchema, 'Execution error'),
      },
    }),
    // Manual parse kept: original tolerates a missing/partial body (defaulting
    // args to {} and trimming strings) and returns custom `invalid_json` /
    // field-required 400 envelopes — typed validation would reject inputs the
    // existing contract accepts.
    async (c: any) => {
      const p = await deps.resolvePrincipal(c);
      if (!p) return c.json({ error: 'unauthorized' }, 401);
      return callResponse(c, p);
    },
  );

  // ── Gateway (project-explicit): list usable connectors ───────────────────
  // Same as GET /connectors, but the project comes from the PATH and runs under
  // combinedAuth — so it accepts a logged-in user token (laptop) as well as an
  // in-sandbox session token. This is what makes `kortix connectors` work locally.
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{projectId}/catalog',
      tags: ['connector'],
      summary: 'List the connectors usable in a project (any valid principal)',
      ...auth,
      request: { params: ProjectParam },
      responses: {
        200: json(ConnectorsResponseSchema, 'Connector catalog for this principal'),
        ...errors(403),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const p = await deps.resolveProjectPrincipal(c, projectId);
      if (!p) return c.json({ error: 'forbidden' }, 403);
      return catalogResponse(c, p);
    },
  );

  // ── Gateway (project-explicit): run a tool call ──────────────────────────
  app.openapi(
    createRoute({
      method: 'post',
      path: '/projects/{projectId}/call',
      tags: ['connector'],
      summary: 'Run a connector action in a project (any valid principal)',
      ...auth,
      request: {
        params: ProjectParam,
        body: {
          content: {
            'application/json': {
              schema: z.object({
                connector: z.string().optional(),
                action: z.string().optional(),
                args: z.record(z.string(), z.any()).optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: json(CallResponseSchema, 'Tool result (ok)'),
        202: json(CallResponseSchema, 'Pending approval'),
        400: json(CallResponseSchema, 'Bad request (invalid_json / missing fields)'),
        403: json(CallResponseSchema, 'Denied'),
        404: json(CallResponseSchema, 'Connector or action not found'),
        500: json(CallResponseSchema, 'Execution error'),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const p = await deps.resolveProjectPrincipal(c, projectId);
      if (!p) return c.json({ error: 'forbidden' }, 403);
      return callResponse(c, p);
    },
  );

  // ── Admin: list connectors for the dashboard ─────────────────────────────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{projectId}/connectors',
      tags: ['connector'],
      summary: "List a project's connectors with status (dashboard)",
      ...auth,
      request: { params: ProjectParam },
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
      const connectors = await deps.listConnectors(projectId);
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
      ...auth,
      request: {
        params: ProjectParam,
        body: { content: { 'application/json': { schema: OpaqueSchema } } },
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
        const result = await deps.createConnector(projectId, admin.accountId, body);
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

  // ── Admin: browse the Pipedream app catalogue ────────────────────────────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{projectId}/pipedream/apps',
      tags: ['connector'],
      summary: 'Browse the Pipedream app catalogue',
      ...auth,
      request: {
        params: ProjectParam,
        query: z.object({ q: z.string().optional(), cursor: z.string().optional() }),
      },
      responses: {
        200: json(OpaqueSchema, 'Pipedream apps page'),
        ...errors(403, 501),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.listPipedreamApps) return featureNotSupportedResponse(c, 'pipedream_apps');
      const result = await deps.listPipedreamApps(
        c.req.query('q') || undefined,
        c.req.query('cursor') || undefined,
      );
      return c.json(result);
    },
  );

  // ── Whether easy-connect (Pipedream) is configured on this deployment ─────
  // Deployment-global capability flag (no project context) so the UI can hide or
  // disable the "Easy Connect" surface up front instead of letting the user open
  // it and hit a 501. `listPipedreamApps` is only wired when pipedreamConfigured(),
  // so its presence is an exact proxy.
  app.openapi(
    createRoute({
      method: 'get',
      path: '/connect-status',
      tags: ['connector'],
      summary: 'Whether the easy-connect (Pipedream) provider is configured on this deployment',
      ...auth,
      responses: {
        200: json(
          z.object({ configured: z.boolean(), provider: z.string().nullable() }),
          'Connect provider status',
        ),
        ...errors(401),
      },
    }),
    async (c: any) => {
      const configured = !!deps.listPipedreamApps;
      return c.json({ configured, provider: configured ? 'pipedream' : null });
    },
  );

  // ── Admin: re-materialize from kortix.yaml ───────────────────────────────
  app.openapi(
    createRoute({
      method: 'post',
      path: '/projects/{projectId}/connectors/sync',
      tags: ['connector'],
      summary: 'Re-materialize connectors from kortix.yaml',
      ...auth,
      request: { params: ProjectParam },
      responses: {
        200: json(SyncResultSchema, 'Sync result'),
        ...errors(403),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      const result = await deps.syncConnectors(projectId, admin.accountId);
      return c.json(result);
    },
  );

  // ── Admin: connector credential mode — restricted to a `shared`-only no-op.
  // `per_user` (each member brings their own) was removed 2026-07-05
  // (docs/specs/2026-07-05-agent-first-config-unification.md §2.5). The route
  // stays for back-compat callers but only ever accepts `shared` now.
  app.openapi(
    createRoute({
      method: 'put',
      path: '/projects/{projectId}/connectors/{slug}/credential-mode',
      tags: ['connector'],
      summary: "Set a connector's credential mode (shared only — per_user was removed)",
      ...auth,
      request: {
        params: ProjectSlugParam,
        body: { content: { 'application/json': { schema: OpaqueSchema } } },
      },
      responses: {
        200: json(CrudOkSchema, 'Mode updated'),
        ...errors(400, 403, 404, 409, 501, 502),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.setCredentialMode)
        return featureNotSupportedResponse(c, 'connector_credential_mode');
      let body: any;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const mode = body?.mode;
      if (mode !== 'shared') {
        return c.json(
          {
            error:
              mode === 'per_user'
                ? 'per_user credential mode was removed — connectors are always shared now'
                : 'mode must be "shared"',
          },
          400,
        );
      }
      const result = await deps.setCredentialMode(projectId, admin.accountId, slug, mode);
      return result.ok
        ? c.json({ ok: true, sync: result.sync })
        : c.json({ error: result.error }, result.status as 400 | 409 | 502);
    },
  );

  // ── Admin: connector authorization strategy ────────────────────────────────
  app.openapi(
    createRoute({
      method: 'put',
      path: '/projects/{projectId}/connectors/{slug}/authorization-strategy',
      tags: ['connector'],
      summary: "Set a connector's connection strategy",
      ...auth,
      request: {
        params: ProjectSlugParam,
        body: { content: { 'application/json': { schema: OpaqueSchema } } },
      },
      responses: {
        200: json(CrudOkSchema, 'Authorization strategy updated'),
        ...errors(400, 403, 404, 409, 501, 502),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.setAuthorizationStrategy) {
        return featureNotSupportedResponse(c, 'connector_authorization_strategy');
      }
      let body: any;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const authorizationStrategy = body?.authorization_strategy;
      if (authorizationStrategy !== 'project' && authorizationStrategy !== 'user') {
        return c.json({ error: 'authorization_strategy must be "project" or "user"' }, 400);
      }
      const result = await deps.setAuthorizationStrategy(
        projectId,
        admin.accountId,
        slug,
        authorizationStrategy,
      );
      return result.ok
        ? c.json({ ok: true, sync: result.sync })
        : c.json({ error: result.error }, result.status as 400 | 409 | 502);
    },
  );

  // ── Admin: toggle a connector's `sensitive` flag (reads gate too) ─────────
  app.openapi(
    createRoute({
      method: 'put',
      path: '/projects/{projectId}/connectors/{slug}/sensitive',
      tags: ['connector'],
      summary: "Toggle a connector's sensitive flag (gate reads too)",
      ...auth,
      request: {
        params: ProjectSlugParam,
        body: { content: { 'application/json': { schema: OpaqueSchema } } },
      },
      responses: {
        200: json(CrudOkSchema, 'Sensitive flag updated'),
        ...errors(400, 403, 404, 409, 501, 502),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.setSensitive) return featureNotSupportedResponse(c, 'connector_sensitive');
      let body: any;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      if (typeof body?.sensitive !== 'boolean') {
        return c.json({ error: 'sensitive must be a boolean' }, 400);
      }
      const result = await deps.setSensitive(projectId, admin.accountId, slug, body.sensitive);
      return result.ok
        ? c.json({ ok: true, sync: result.sync })
        : c.json({ error: result.error }, result.status as 400 | 409 | 502);
    },
  );

  // ── Admin: rename a connector (display label) ────────────────────────────
  app.openapi(
    createRoute({
      method: 'put',
      path: '/projects/{projectId}/connectors/{slug}/name',
      tags: ['connector'],
      summary: 'Rename a connector (display label)',
      ...auth,
      request: {
        params: ProjectSlugParam,
        body: { content: { 'application/json': { schema: OpaqueSchema } } },
      },
      responses: {
        200: json(CrudOkSchema, 'Renamed'),
        ...errors(400, 403, 404, 409, 501, 502),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.setConnectorName) return featureNotSupportedResponse(c, 'connector_rename');
      let body: any;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const name = typeof body?.name === 'string' ? body.name : '';
      if (!name.trim()) return c.json({ error: '`name` is required' }, 400);
      const result = await deps.setConnectorName(projectId, admin.accountId, slug, name);
      return result.ok
        ? c.json({ ok: true, sync: result.sync })
        : c.json({ error: result.error }, result.status as 400 | 409 | 502);
    },
  );

  // ── Admin: read a connector's per-tool/per-pattern policies ──────────────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{projectId}/connectors/{slug}/policies',
      tags: ['connector'],
      summary: "Read a connector's tool-call policies",
      ...auth,
      request: { params: ProjectSlugParam },
      responses: {
        200: json(OpaqueSchema, 'Connector policies'),
        ...errors(403, 404),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.getConnectorPolicies)
        return featureNotSupportedResponse(c, 'connector_policies_read');
      const result = await deps.getConnectorPolicies(projectId, slug);
      if (!result) return c.json({ error: 'connector not found' }, 404);
      return c.json(result);
    },
  );

  // ── Admin: read a connector's definition (for editing the connection) ────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{projectId}/connectors/{slug}/config',
      tags: ['connector'],
      summary: "Read a connector's connection config (provider, url, auth, …)",
      ...auth,
      request: { params: ProjectSlugParam },
      responses: {
        200: json(OpaqueSchema, 'Connector config'),
        ...errors(403, 404, 501),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.getConnectorConfig) return featureNotSupportedResponse(c, 'connector_config_read');
      const result = await deps.getConnectorConfig(projectId, slug);
      if (!result) return c.json({ error: 'connector not found' }, 404);
      return c.json(result);
    },
  );

  // ── Admin: replace a connector's policies (write-through to kortix.yaml) ──
  app.openapi(
    createRoute({
      method: 'put',
      path: '/projects/{projectId}/connectors/{slug}/policies',
      tags: ['connector'],
      summary: "Replace a connector's tool-call policies",
      ...auth,
      request: {
        params: ProjectSlugParam,
        body: { content: { 'application/json': { schema: OpaqueSchema } } },
      },
      responses: {
        200: json(CrudOkSchema, 'Policies updated'),
        ...errors(400, 403, 404, 409, 501, 502),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.setConnectorPolicies)
        return featureNotSupportedResponse(c, 'connector_policies_write');
      let body: any;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const policies = Array.isArray(body?.policies) ? body.policies : null;
      if (!policies) return c.json({ error: '`policies` must be an array' }, 400);
      const result = await deps.setConnectorPolicies(projectId, admin.accountId, slug, policies);
      return result.ok
        ? c.json({ ok: true, sync: result.sync })
        : c.json({ error: result.error }, result.status as 400 | 409 | 502);
    },
  );

  // ── Pipedream 1-click connect (admin) ────────────────────────────────────
  app.openapi(
    createRoute({
      method: 'post',
      path: '/projects/{projectId}/connectors/{slug}/connect',
      tags: ['connector'],
      summary: 'Pipedream 1-click: mint a connect token',
      ...auth,
      request: { params: ProjectSlugParam },
      responses: {
        200: json(OpaqueSchema, 'Connect token / overlay info'),
        ...errors(403, 404, 501),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.pipedreamConnect) return featureNotSupportedResponse(c, 'pipedream_connect');
      // Native clients pass app deep-link redirect URIs so the in-app browser
      // auto-dismisses back to the app instead of landing on a web page.
      let redirects: { success?: string; error?: string } | undefined;
      try {
        const body = await c.req.json();
        if (body?.success_redirect_uri || body?.error_redirect_uri) {
          redirects = { success: body.success_redirect_uri, error: body.error_redirect_uri };
        }
      } catch {
        /* no body */
      }
      const result = await deps.pipedreamConnect(projectId, slug, admin.userId, redirects);
      if (!result) return c.json({ error: 'not a pipedream connector' }, 404);
      return c.json(result);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/projects/{projectId}/connectors/{slug}/connect/finalize',
      tags: ['connector'],
      summary: 'Pipedream 1-click: persist the account binding',
      ...auth,
      request: { params: ProjectSlugParam },
      responses: {
        200: json(OpaqueSchema, 'Connection finalized'),
        ...errors(403, 404, 501),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.pipedreamFinalize) return featureNotSupportedResponse(c, 'pipedream_finalize');
      const result = await deps.pipedreamFinalize(projectId, slug, admin.userId);
      if (!result) return c.json({ error: 'not a pipedream connector' }, 404);
      return c.json(result);
    },
  );

  // ── Admin: read project policies (top-level [[policies]] + [policy]) ────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{projectId}/policies',
      tags: ['connector'],
      summary: 'Read project policies and default mode',
      ...auth,
      request: { params: ProjectParam },
      responses: {
        200: json(OpaqueSchema, 'Project policies view'),
        ...errors(403, 404, 501),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.getProjectPolicies) return featureNotSupportedResponse(c, 'project_policies_read');
      const result = await deps.getProjectPolicies(projectId);
      if (!result) return c.json({ error: 'project not found' }, 404);
      return c.json(result);
    },
  );

  // ── Admin: replace project policies (write-through to kortix.yaml) ──────
  app.openapi(
    createRoute({
      method: 'put',
      path: '/projects/{projectId}/policies',
      tags: ['connector'],
      summary: 'Replace project policies and default mode',
      ...auth,
      request: {
        params: ProjectParam,
        body: { content: { 'application/json': { schema: OpaqueSchema } } },
      },
      responses: {
        200: json(CrudOkSchema, 'Policies replaced'),
        ...errors(400, 403, 409, 501, 502),
      },
    }),
    // Manual parse kept: original does per-policy validation with indexed error
    // messages (`policy #N: ...`) and tolerates a partial/missing body.
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.setProjectPolicies) return featureNotSupportedResponse(c, 'project_policies_write');

      let body: any;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }

      const rawPolicies = Array.isArray(body?.policies) ? body.policies : [];
      const policies: ProjectPolicyView[] = [];
      for (let i = 0; i < rawPolicies.length; i++) {
        const p = rawPolicies[i];
        const match = typeof p?.match === 'string' ? p.match.trim() : '';
        const action = typeof p?.action === 'string' ? p.action.trim() : '';
        if (!match) return c.json({ error: `policy #${i + 1}: \`match\` is required` }, 400);
        if (action !== 'always_run' && action !== 'require_approval' && action !== 'block') {
          return c.json({ error: `policy #${i + 1}: invalid \`action\` "${action}"` }, 400);
        }
        // Reject an invalid matcher at WRITE time. An unparseable pattern
        // compiles to a never-match, so a broken `block` rule would look saved
        // while silently protecting nothing.
        if (!isValidMatcher(match)) {
          return c.json(
            {
              error: `policy #${i + 1}: invalid \`match\` pattern "${match}"`,
              code: 'INVALID_MATCHER',
            },
            400,
          );
        }
        if (p?.conditions !== undefined && p?.conditions !== null) {
          if (!areValidConditions(p.conditions)) {
            return c.json(
              {
                error: `policy #${i + 1}: invalid \`conditions\` — each needs \`arg\` (a dot path, not __proto__/constructor/prototype) and \`match\` (glob or /regex/), with optional boolean \`negate\``,
                code: 'INVALID_CONDITIONS',
              },
              400,
            );
          }
          policies.push({ match, action, conditions: normalizeConditions(p.conditions) });
          continue;
        }
        policies.push({ match, action });
      }
      const defaultMode = body?.defaultMode === 'risk' ? 'risk' : 'allow_all';

      const result = await deps.setProjectPolicies(
        projectId,
        admin.accountId,
        policies,
        defaultMode,
      );
      return result.ok
        ? c.json({ ok: true, sync: result.sync })
        : c.json({ error: result.error }, result.status as 400 | 409 | 502);
    },
  );

  // ── Pipedream webhook (no user auth — HMAC-signed) ────────────────────────
  app.openapi(
    createRoute({
      method: 'post',
      path: '/webhook/pipedream',
      tags: ['connector'],
      summary: 'Pipedream webhook (HMAC-signed, no user auth)',
      request: {
        query: z.object({ sig: z.string().optional() }),
        body: { content: { 'application/json': { schema: OpaqueSchema } } },
      },
      responses: {
        200: json(OkSchema, 'Accepted'),
        ...errors(400, 401, 501),
      },
    }),
    // Manual parse kept: webhook tolerates an unparseable body (defaults to {})
    // and authenticates via HMAC signature, not a user token.
    async (c: any) => {
      if (!deps.pipedreamWebhook) return featureNotSupportedResponse(c, 'pipedream_webhook');
      const sig = c.req.query('sig') ?? null;
      let body: any;
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const extUserId = typeof body?.external_user_id === 'string' ? body.external_user_id : '';
      if (!extUserId) return c.json({ error: 'missing external_user_id' }, 400);
      const ok = await deps.pipedreamWebhook(extUserId, sig);
      return ok ? c.json({ ok: true }) : c.json({ error: 'invalid signature' }, 401);
    },
  );

  return app;
}
