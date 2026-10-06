/**
 * Gateway routes (sandbox-facing): the catalog, attachments and `/call`, on the
 * token-scoped face and the project-explicit face. One implementation, two faces.
 */
import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { SLUG_RE } from '@kortix/manifest-schema';
import type { Context } from 'hono';
import { auth, errors, json } from '../../openapi';
import { canonicalConnectorAlias } from '../../projects/lib/session-connector-bindings';
import { ATTACHMENT_REF_KEY } from '../attachment-inline';
import { MAX_CONNECTOR_ATTACHMENT_BYTES, type StageConnectorAttachmentInput } from '../attachments';
import { handleCall } from '../gateway';
import {
  type ConnectorDenialReason,
  connectorDenialBody,
  principalMayUseConnector,
} from '../principal-access';
import type { ConnectorPrincipal, ConnectorRouterDeps } from '../router';
import {
  AttachmentUploadResponseSchema,
  CallResponseSchema,
  CatalogQuerySchema,
  ConnectorsResponseSchema,
  OpaqueSchema,
  ProjectParam,
  featureNotSupportedResponse,
} from './shared';

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

const CONNECTOR_DENIAL_REASONS: ReadonlySet<string> = new Set<ConnectorDenialReason>([
  'connector_not_assigned',
  'connector_not_found',
  'connector_not_connected',
  'connector_disabled',
  'action_not_found',
  'account_required',
]);

const COMPUTER_REFUSALS = ['computer_access_pending', 'computer_access_denied', 'computer_access_off', 'computer_capability_not_approved'];
const COMPUTER_STATES = ['computer_offline', 'computer_unpaired'];

/**
 * HTTP status for a gateway `error`. Computer states the owner controls are
 * expected outcomes, not server faults: a 5xx invites a retry, and each retry
 * re-prompts the owner. 500, not 502, for the rest (Cloudflare eats 502 bodies).
 */
export function connectorErrorHttpStatus(reason: string): 403 | 409 | 500 {
  const kind = reason.split(':', 1)[0];
  if (COMPUTER_REFUSALS.includes(kind)) return 403;
  if (COMPUTER_STATES.includes(kind)) return 409;
  return 500;
}

function isConnectorDenialReason(reason: string): reason is ConnectorDenialReason {
  return CONNECTOR_DENIAL_REASONS.has(reason);
}

// Shared gateway logic — used by BOTH the legacy flat routes (project derived
// from a scoped session token) and the project-EXPLICIT routes
// (project from the path, any valid principal). One implementation, two faces.
const catalogResponse = async (deps: ConnectorRouterDeps, c: any, p: ConnectorPrincipal) => {
  const query = c.req.valid('query') as { slug?: string; include_schemas?: 'true' | 'false' };
  const slug = query.slug?.trim() || undefined;
  const connectors = await deps.listCatalog(p, {
    slug,
    includeSchemas: query.include_schemas !== 'false',
  });
  return c.json({ connectors });
};
const callResponse = async (deps: ConnectorRouterDeps, c: any, p: ConnectorPrincipal) => {
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
  // Per-agent connector assignment: a scoped agent may call only the
  // connectors its kortix.yaml overlay lists — plus the channel that created
  // the session (`principalMayUseConnector`). Default-deny otherwise, with a
  // body that says WHICH agent, WHAT it holds and WHERE that came from.
  if (!principalMayUseConnector(p, canonicalConnectorAlias(connectorSlug))) {
    return c.json(
      connectorDenialBody('connector_not_assigned', {
        principal: p,
        connector: connectorSlug,
        action: actionPath,
      }),
      403,
    );
  }
  const args =
    body?.args && typeof body.args === 'object' ? (body.args as Record<string, unknown>) : {};
  // Compatibility hint from older clients. The gateway may reuse the named
  // pending row, but it returns immediately and never polls that execution.
  const approvalExecutionId =
    typeof body?.approval_execution_id === 'string' ? body.approval_execution_id : null;
  // WHICH account to run as. Accepted as `account` (label or connection id);
  // `connection_id` is taken too because that is what the connections API
  // calls the same value. Unset keeps the default account.
  const requestedAccount =
    typeof body?.account === 'string' && body.account.trim()
      ? body.account.trim()
      : typeof body?.connection_id === 'string' && body.connection_id.trim()
        ? body.connection_id.trim()
        : null;
  const callPrincipal: ConnectorPrincipal = {
    ...p,
    requestedConnectorAccount: requestedAccount,
  };
  const result = await handleCall(deps.makeGatewayDeps(callPrincipal), {
    projectId: p.projectId,
    accountId: p.accountId,
    subject: p.subject,
    sessionId: p.sessionId,
    actingTokenId: p.tokenId ?? null,
    connectorSlug,
    actionPath,
    args,
    approvalExecutionId,
    approvalContext: typeof body?.approval_context === 'string' ? body.approval_context : null,
  });
  switch (result.status) {
    case 'ok':
      return c.json({
        ok: true,
        data: result.data,
        risk: result.risk,
        ...(result.account ? { account: result.account } : {}),
      });
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
    case 'denied': {
      // The one denial with a remedy attached. Minting is best-effort: a
      // connector with no hosted page still denies, just without a link.
      const notConnected = result.reason === 'connector_not_connected';
      const connectUrl =
        notConnected && deps.mintConnectorConnectLink
          ? await deps
              .mintConnectorConnectLink({
                projectId: p.projectId,
                slug: connectorSlug,
                userId: p.userId,
                sessionId: p.sessionId,
              })
              .catch(() => null)
          : null;
      // Two cases want the account list: the caller NAMED one that didn't
      // match (a plain unconnected call is a connect problem, not a
      // wrong-name problem, and listing an empty set would just be noise),
      // or the call is `account_required` — several accounts exist and the
      // retry needs to know what to name.
      const accountRequired = result.reason === 'account_required';
      const availableAccounts =
        ((notConnected && requestedAccount) || accountRequired) && deps.listConnectorAccounts
          ? await deps
              .listConnectorAccounts({
                projectId: p.projectId,
                slug: connectorSlug,
                userId: p.userId,
                sessionId: p.sessionId,
                agentPrincipal: p.agentPrincipal ?? null,
              })
              .then((rows) => rows.map((row) => row.label))
              .catch(() => [])
          : [];
      return c.json(
        isConnectorDenialReason(result.reason)
          ? connectorDenialBody(result.reason, {
              principal: p,
              connector: connectorSlug,
              action: actionPath,
              connectUrl,
              requestedAccount,
              availableAccounts,
            })
          : {
              ok: false,
              status: 'denied',
              reason: result.reason,
              ...(result.message ? { message: result.message } : {}),
            },
        result.reason === 'connector_not_found' || result.reason === 'action_not_found'
          ? 404
          : 403,
      );
    }
    default:
      return c.json({ ok: false, status: 'error', reason: result.reason }, connectorErrorHttpStatus(result.reason));
  }
};

const attachmentResponse = async (
  deps: ConnectorRouterDeps,
  c: Context,
  p: ConnectorPrincipal,
) => {
  if (!deps.attachmentStore) return featureNotSupportedResponse(c, 'connector_attachments');
  // The connector the file is staged for. Clients published before this header
  // existed send none; those uploads are for the native Email channel.
  let target: string;
  try {
    target = decodedAttachmentHeader(c, 'X-Kortix-Attachment-Connector') || 'kortix_email';
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
  if (target.length > 128) {
    return c.json({ error: 'X-Kortix-Attachment-Connector must not exceed 128 characters' }, 400);
  }
  if (!principalMayUseConnector(p, canonicalConnectorAlias(target))) {
    return c.json(
      connectorDenialBody('connector_not_assigned', { principal: p, connector: target }),
      403,
    );
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
    const staged = await deps.attachmentStore.stage(
      {
        accountId: p.accountId,
        projectId: p.projectId,
        sessionId: p.sessionId,
        userId: p.userId,
      },
      { ...metadata, bytes },
    );
    return c.json({ ...staged, ref: { [ATTACHMENT_REF_KEY]: staged.attachment_id } }, 201);
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

export function registerGatewayCatalogRoutes(app: OpenAPIHono, deps: ConnectorRouterDeps): void {
  // ── Gateway: list usable connectors ──────────────────────────────────────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/catalog',
      tags: ['connector'],
      summary: 'List the connectors the connector principal can use',
      ...auth,
      request: { query: CatalogQuerySchema },
      responses: {
        200: json(ConnectorsResponseSchema, 'Connector catalog for this principal'),
        ...errors(401),
      },
    }),
    async (c: any) => {
      const p = await deps.resolvePrincipal(c);
      if (!p) return c.json({ error: 'unauthorized' }, 401);
      return catalogResponse(deps, c, p);
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
      request: { query: CatalogQuerySchema },
      responses: {
        200: json(ConnectorsResponseSchema, 'Connector catalog for this principal'),
        ...errors(401),
      },
    }),
    async (c: any) => {
      const p = await deps.resolvePrincipal(c);
      if (!p) return c.json({ error: 'unauthorized' }, 401);
      return catalogResponse(deps, c, p);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/attachments',
      tags: ['connector'],
      summary: 'Stage a private attachment from raw bytes',
      description:
        'Send the raw file bytes as the body with `Content-Type`, `X-Kortix-Attachment-Filename`, and optional `X-Kortix-Attachment-Disposition` / `X-Kortix-Attachment-Content-Id`. `X-Kortix-Attachment-Connector` names the connector the file is for; the caller must be able to use it. Without it, the file is for the native Email channel.',
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
      return attachmentResponse(deps, c, p);
    },
  );
}

export function registerProjectAttachmentRoutes(app: OpenAPIHono, deps: ConnectorRouterDeps): void {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/projects/{projectId}/attachments',
      tags: ['connector'],
      summary: 'Stage a private attachment in a project from raw bytes',
      description:
        'Send the raw file bytes as the body with `Content-Type`, `X-Kortix-Attachment-Filename`, and optional `X-Kortix-Attachment-Disposition` / `X-Kortix-Attachment-Content-Id`. `X-Kortix-Attachment-Connector` names the connector the file is for; the caller must be able to use it. Without it, the file is for the native Email channel.',
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
      return attachmentResponse(deps, c, p);
    },
  );
}

export function registerGatewayCallRoutes(app: OpenAPIHono, deps: ConnectorRouterDeps): void {
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
                /** Which account to run as — a connection label or id. Omit for
                 *  the default. See GET .../connectors/{slug}/accounts. */
                account: z.string().optional(),
                /** Shown to the human when policy gates the call: what it does,
                 *  in the caller's words (e.g. the draft's recipient and body
                 *  for a `send_draft`). Never sent to the provider. */
                approval_context: z.string().optional(),
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
      return callResponse(deps, c, p);
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
      request: { params: ProjectParam, query: CatalogQuerySchema },
      responses: {
        200: json(ConnectorsResponseSchema, 'Connector catalog for this principal'),
        ...errors(403),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const p = await deps.resolveProjectPrincipal(c, projectId);
      if (!p) return c.json({ error: 'forbidden' }, 403);
      return catalogResponse(deps, c, p);
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
                /** Which account to run as — a connection label or id. Omit for
                 *  the default. See GET .../connectors/{slug}/accounts. */
                account: z.string().optional(),
                /** Shown to the human when policy gates the call: what it does,
                 *  in the caller's words (e.g. the draft's recipient and body
                 *  for a `send_draft`). Never sent to the provider. */
                approval_context: z.string().optional(),
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
      return callResponse(deps, c, p);
    },
  );

  // ── The accounts a call may run as ───────────────────────────────────────
  //
  // One connector can hold the project's shared account and each member's own.
  // Resolution picks the first entitled one unless a call names another, so this
  // is how a human (or an agent) finds out WHICH names `--account` accepts.
  // Same principal as `/call`, so what it lists is exactly what a call can use —
  // never an account the gateway would then refuse.
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{projectId}/connectors/{slug}/accounts',
      tags: ['connector'],
      summary: 'Accounts this principal may run a connector as',
      ...auth,
      request: {
        params: ProjectParam.extend({ slug: z.string().min(1) }),
      },
      responses: {
        200: json(OpaqueSchema, 'Accounts, default first'),
        ...errors(403, 501),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const p = await deps.resolveProjectPrincipal(c, projectId);
      if (!p) return c.json({ error: 'forbidden' }, 403);
      if (!deps.listConnectorAccounts) {
        return featureNotSupportedResponse(c, 'connector_accounts');
      }
      if (!principalMayUseConnector(p, canonicalConnectorAlias(slug))) {
        return c.json(
          connectorDenialBody('connector_not_assigned', { principal: p, connector: slug }),
          403,
        );
      }
      const accounts = await deps.listConnectorAccounts({
        projectId,
        slug,
        userId: p.userId,
        sessionId: p.sessionId,
        agentPrincipal: p.agentPrincipal ?? null,
      });
      // The pinned account, when exactly one is pinned — the SAME "is a
      // default reachable" question an unnamed `/call` answers. Two or more
      // pinned accounts (a member's own pin + the project's, both entitled)
      // is not reported as a single default here either.
      const pinned = accounts.filter((account) => account.is_default);
      return c.json({
        connector: slug,
        default_account: pinned.length === 1 ? pinned[0]!.label : null,
        accounts,
      });
    },
  );
}
