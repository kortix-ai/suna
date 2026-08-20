import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
/**
 * `kortix connectors mcp` — the Connector exposed as a stdio MCP server.
 *
 * This is the MCP face for every configured connector.
 * (Pipedream / MCP / OpenAPI / Postman / GraphQL / HTTP). The default agent path is the
 * `kortix connectors` CLI; OpenCode only sees this MCP server when the runtime
 * explicitly registers it.
 *
 * Modeled on RhysSullivan/connector: instead of exploding every connector action
 * into tools/list (which floods context once a catalog has hundreds of actions),
 * we expose a small, stable set of META-TOOLS and let the agent progressively
 * discover what it needs.
 *
 * Thin client: it never holds a third-party credential. Every call goes to the
 * Kortix Connector Gateway, which checks sharing, resolves the secret SERVER-SIDE,
 * runs the call, and audits it. The sandbox only carries KORTIX_CLI_TOKEN +
 * KORTIX_API_URL (injected at sandbox spawn).
 *
 * STDOUT IS THE JSON-RPC CHANNEL — nothing else may be written there. index.ts
 * skips host/update notices for `connectors mcp`, so this stays clean.
 */
import {
  addConnector,
  brokerSecretRequest,
  callWithApprovalHandoff,
  connectorClient,
  mintConnectLink,
  mintSecretLink,
  removeConnector,
  type BrokerMethod,
  type ConnectorClient,
} from './gateway.ts';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

// The MCP server identity is `kortix-connectors`, matching the CLI command tree.
const SERVER_INFO = { name: 'kortix-connectors', version: '0.3.0' };

const BROKER_METHODS: BrokerMethod[] = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
];

const MAX_ATTACHMENT_FILES = 20;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const DEFAULT_ATTACHMENT_ROOTS = ['output', 'artifacts', 'reports', 'deliverables'];

const ATTACHMENT_CONTENT_TYPES: Record<string, string> = {
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
};

interface LocalAttachmentFile {
  path: string;
  filename?: string;
  content_type?: string;
  content_disposition?: 'attachment' | 'inline';
  content_id?: string;
}

interface UploadedAttachment {
  filename: string;
  content_type: string;
  content_disposition: 'attachment' | 'inline';
  content_id?: string;
  attachment_id: string;
}

function isWithinRoot(path: string, root: string): boolean {
  const offset = relative(root, path);
  return offset !== '' && !offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset);
}

function localAttachment(value: unknown, index: number): LocalAttachmentFile {
  const row = asRecord(value);
  const path = stringField(row, 'path').trim();
  if (!path) throw new Error(`attachment_files[${index}].path is required`);
  const disposition = row.content_disposition;
  if (disposition !== undefined && disposition !== 'attachment' && disposition !== 'inline') {
    throw new Error(
      `attachment_files[${index}].content_disposition must be "attachment" or "inline"`,
    );
  }
  return {
    path,
    ...(stringField(row, 'filename').trim()
      ? { filename: stringField(row, 'filename').trim() }
      : {}),
    ...(stringField(row, 'content_type').trim()
      ? { content_type: stringField(row, 'content_type').trim() }
      : {}),
    ...(disposition ? { content_disposition: disposition } : {}),
    ...(stringField(row, 'content_id').trim()
      ? { content_id: stringField(row, 'content_id').trim() }
      : {}),
  };
}

export async function uploadAttachmentFiles(
  value: unknown,
  connector: Pick<ConnectorClient, 'uploadAttachment'>,
  options: {
    workspaceRoot?: string;
    maxBytes?: number;
    afterOpen?: (path: string, index: number) => Promise<void>;
  } = {},
): Promise<UploadedAttachment[]> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('attachment_files must be a non-empty array');
  }
  if (value.length > MAX_ATTACHMENT_FILES) {
    throw new Error(`attachment_files supports at most ${MAX_ATTACHMENT_FILES} files`);
  }

  const workspaceRoot = await realpath(
    options.workspaceRoot ?? process.env.KORTIX_INTERNAL_WORKSPACE_ROOT ?? '/workspace',
  );
  const allowedRoots = DEFAULT_ATTACHMENT_ROOTS.map((name) => resolve(workspaceRoot, name));
  const maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
  let totalBytes = 0;
  const uploaded: UploadedAttachment[] = [];

  for (let index = 0; index < value.length; index++) {
    const item = localAttachment(value[index], index);
    if (!isAbsolute(item.path)) {
      throw new Error(`attachment_files[${index}].path must be absolute`);
    }
    const file = await open(item.path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
      (error: unknown) => {
        if (asRecord(error).code === 'ELOOP') {
          throw new Error(`attachment_files[${index}].path must not be a symbolic link`);
        }
        throw error;
      },
    );
    try {
      await options.afterOpen?.(item.path, index);
      const path = await realpath(item.path);
      if (!allowedRoots.some((root) => isWithinRoot(path, root))) {
        throw new Error(
          `attachment_files[${index}].path must be inside /workspace/{${DEFAULT_ATTACHMENT_ROOTS.join(',')}}`,
        );
      }
      const [details, pathDetails] = await Promise.all([file.stat(), stat(path)]);
      if (!details.isFile()) throw new Error(`attachment_files[${index}].path is not a file`);
      if (details.nlink !== 1) {
        throw new Error(`attachment_files[${index}].path must not have hard links`);
      }
      if (details.dev !== pathDetails.dev || details.ino !== pathDetails.ino) {
        throw new Error(`attachment_files[${index}].path changed while it was being opened`);
      }
      totalBytes += details.size;
      if (totalBytes > maxBytes) {
        throw new Error(
          `attachment_files exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MiB aggregate limit`,
        );
      }

      const filename = item.filename || basename(path);
      if (
        !filename ||
        filename === '.' ||
        filename === '..' ||
        filename.includes('/') ||
        filename.includes('\\')
      ) {
        throw new Error(`attachment_files[${index}].filename must be a plain filename`);
      }
      const contentType =
        item.content_type ||
        ATTACHMENT_CONTENT_TYPES[extname(filename).toLowerCase()] ||
        'application/octet-stream';
      const result = await connector.uploadAttachment(await file.readFile(), {
        filename,
        contentType,
        contentDisposition: item.content_disposition ?? 'attachment',
        ...(item.content_id ? { contentId: item.content_id } : {}),
      });
      uploaded.push({
        filename,
        content_type: contentType,
        content_disposition: item.content_disposition ?? 'attachment',
        ...(item.content_id ? { content_id: item.content_id } : {}),
        attachment_id: result.attachment_id,
      });
    } finally {
      await file.close();
    }
  }
  return uploaded;
}

/**
 * The fixed meta-tool surface. Stable regardless of how many connectors or
 * actions a session has — that's the whole point versus exploding the catalog.
 */
const META_TOOLS = [
  {
    name: 'connectors',
    description:
      'List the connectors this session can use (Pipedream / MCP / OpenAPI / Postman / GraphQL / HTTP), each with its provider, status, and number of tools. Start here to see what is available.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
  },
  {
    name: 'discover',
    description:
      'Search every usable tool by intent and return the best matches (connector-namespaced path, risk, description). Use a natural-language query like "send a slack message" or "create a stripe charge".',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Natural-language intent to search for. Empty returns the first available tools.',
        },
        limit: { type: 'number', description: 'Maximum matches to return (default 20).' },
      },
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: 'describe',
    description:
      'Show one tool\'s full input JSON schema, risk, and description. Pass the connector-namespaced path from discover, e.g. "stripe.charges.create". Always describe an unfamiliar tool before calling it.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: {
          type: 'string',
          description: 'Connector-namespaced tool path, e.g. "stripe.charges.create".',
        },
      },
      required: ['tool'],
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: 'call',
    description:
      'Run a tool. The gateway resolves the credential server-side, enforces sharing + policy, executes the call, and audits it. Returns { ok, data, risk } on success, or a denial / pending-approval result. For email attachments, pass local file references in attachment_files; this MCP uploads raw bytes outside the model and JSON-RPC payloads. GraphQL tools take selected fields via an "__select" arg, e.g. {"id":"1","__select":"id name email"}.',
    inputSchema: {
      type: 'object',
      properties: {
        connector: { type: 'string', description: 'Connector slug, e.g. "stripe".' },
        action: {
          type: 'string',
          description: 'Action path within the connector, e.g. "charges.create".',
        },
        args: {
          type: 'object',
          description: "Arguments matching the tool's input schema (see describe). Defaults to {}.",
        },
        attachment_files: {
          type: 'array',
          description:
            'Local files for an email action that supports attachments. Paths must be absolute and inside /workspace/output, /workspace/artifacts, /workspace/reports, or /workspace/deliverables. The MCP uploads raw bytes and passes opaque attachment handles, so never paste base64 into args.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Absolute local file path.' },
              filename: { type: 'string', description: 'Optional recipient-visible filename.' },
              content_type: { type: 'string', description: 'Optional MIME type.' },
              content_disposition: {
                type: 'string',
                enum: ['attachment', 'inline'],
                description: 'Defaults to attachment.',
              },
              content_id: { type: 'string', description: 'Optional inline content ID.' },
            },
            required: ['path'],
            additionalProperties: false,
          },
          maxItems: MAX_ATTACHMENT_FILES,
        },
      },
      required: ['connector', 'action'],
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'connect',
    description:
      'Get a 1-click Pipedream Quick Connect link for a connector that is declared but not yet authenticated, and SURFACE the returned url to the human in your reply. Use this the moment you add/need a Pipedream connector — never tell the human to open the dashboard. In the web UI the link opens a connect popup; in Slack it is a tappable link. No credential ever touches the sandbox. The connector must already exist in kortix.yaml (add it + land the change request first).',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Connector slug to connect, e.g. "smartlead".' },
        expires_in_minutes: {
          type: 'number',
          description: 'Link lifetime in minutes (default 30, max 1440).',
        },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'request_secret',
    description:
      'Get a link the human opens to enter one or more project SECRET values (e.g. an API key), and SURFACE the returned url in your reply. Use this whenever you need a credential you do not have — never ask the human to paste a raw key into chat or to hunt through the dashboard. The value is never pasted into chat; once they submit it, the secret becomes available to your session (check KORTIX_PROJECT_SECRET_NAMES). In the web UI the link opens a fill-in modal; in Slack it is a tappable link. scope "runtime" (default) injects the value into your sandbox env; "connector" keeps it server-side only.',
    inputSchema: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Env var name(s) to request, e.g. ["APOLLO_API_KEY","SMARTLEAD_API_KEY"]. UPPER_SNAKE_CASE.',
        },
        scope: {
          type: 'string',
          enum: ['runtime', 'connector'],
          description: 'runtime (default) or connector.',
        },
        labels: {
          type: 'object',
          description: 'Optional per-name human label, { NAME: "label" }.',
        },
        descriptions: {
          type: 'object',
          description: 'Optional per-name hint shown on the form, { NAME: "where to find it" }.',
        },
        expires_in_minutes: {
          type: 'number',
          description: 'Link lifetime in minutes (default 30, max 1440).',
        },
      },
      required: ['names'],
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'secret_call',
    description:
      'Make an HTTPS request that needs a project API key, WITHOUT ever holding the key. Kortix adds the credential outside this sandbox and returns only the upstream response, with any echo of the value replaced by [REDACTED]. Use this for a secret whose capability lists delivery "https_broker" — it has no environment variable at all, so this is the only way to spend it — and as the fallback for a "network" secret when a request cannot be relayed the ordinary way (send its handle with your normal HTTP client first). Pass the secret\'s identifier plus the full https:// URL; add the request\'s own non-secret headers if it needs them, and never add an Authorization header yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          description:
            'Secret identifier exactly as listed in your secret capabilities, e.g. "STRIPE_KEY". Not the value.',
        },
        url: {
          type: 'string',
          description: 'Full HTTPS URL to call, e.g. "https://api.stripe.com/v1/charges".',
        },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
          description: 'HTTP method (default GET).',
        },
        headers: {
          type: 'object',
          description:
            'Non-secret request headers, { "content-type": "application/json" }. Omit the credential header — Kortix adds it.',
        },
        body: {
          type: 'string',
          description: 'Request body as a string. For JSON, pass the serialized JSON text.',
        },
      },
      required: ['identifier', 'url'],
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'add_connector',
    description:
      'Add or update a connector on this project now. The command commits kortix.yaml to main and syncs it server-side. Use `connect` for Pipedream or `request_secret` for its credential. For Pipedream pass provider="pipedream" and app (for example, "smartlead").',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Connector slug, e.g. "smartlead".' },
        provider: {
          type: 'string',
          enum: ['pipedream', 'mcp', 'openapi', 'postman', 'graphql', 'http'],
          description: 'Connector provider.',
        },
        app: {
          type: 'string',
          description: 'Pipedream app slug (provider=pipedream), e.g. "smartlead".',
        },
        name: { type: 'string', description: 'Optional display name.' },
        url: { type: 'string', description: 'MCP server URL (provider=mcp).' },
        transport: {
          type: 'string',
          enum: ['http', 'sse'],
          description: 'MCP transport (provider=mcp).',
        },
        endpoint: { type: 'string', description: 'GraphQL endpoint (provider=graphql).' },
        base_url: { type: 'string', description: 'HTTP base URL (provider=http).' },
        spec: { type: 'string', description: 'OpenAPI/Postman/GraphQL/HTTP spec or source ref.' },
        credential: {
          type: 'string',
          enum: ['shared'],
          description: 'Credential storage mode (shared is the only mode).',
        },
      },
      required: ['slug', 'provider'],
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'remove_connector',
    description:
      'Remove a connector from this project (committed to kortix.yaml on main + catalog). No change request needed.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string', description: 'Connector slug to remove.' } },
      required: ['slug'],
      additionalProperties: false,
    },
    readOnly: false,
  },
] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

function content(data: unknown) {
  return [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }];
}

async function runMetaTool(client: ConnectorClient, name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'connectors': {
      const connectors = await client.catalog();
      return {
        content: content({
          connectors: connectors.map((c) => ({
            slug: c.slug,
            name: c.name,
            provider: c.provider,
            status: c.status,
            tools: c.actions.length,
          })),
        }),
        isError: false,
      };
    }

    case 'discover': {
      const query = typeof args.query === 'string' ? args.query : '';
      const limit = typeof args.limit === 'number' ? args.limit : undefined;
      const matches = await client.search(query, limit !== undefined ? { limit } : {});
      return {
        content: content({
          matches: matches.map((m) => ({ tool: m.tool, risk: m.risk, description: m.description })),
        }),
        isError: false,
      };
    }

    case 'describe': {
      const ref = typeof args.tool === 'string' ? args.tool : '';
      if (!ref.includes('.')) {
        return {
          content: content({ ok: false, error: 'tool must be a "<connector>.<action>" path' }),
          isError: true,
        };
      }
      const tool = await client.describe(ref);
      if (!tool) {
        return {
          content: content({
            ok: false,
            error: `unknown tool "${ref}" — run discover to list tools`,
          }),
          isError: true,
        };
      }
      return {
        content: content({
          tool: tool.tool,
          risk: tool.risk,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }),
        isError: false,
      };
    }

    case 'call': {
      const connector = typeof args.connector === 'string' ? args.connector : '';
      const action = typeof args.action === 'string' ? args.action : '';
      if (!connector || !action) {
        return {
          content: content({ ok: false, error: 'connector and action are required' }),
          isError: true,
        };
      }
      let callArgs = asRecord(args.args);
      if (args.attachment_files !== undefined) {
        const described = await client.describe(`${connector}.${action}`);
        const schema = asRecord(described?.inputSchema);
        const properties = asRecord(schema.properties);
        if (!described || !properties.attachments) {
          return {
            content: content({
              ok: false,
              error: `${connector}.${action} does not accept attachments`,
            }),
            isError: true,
          };
        }
        try {
          const files = await uploadAttachmentFiles(args.attachment_files, client);
          const existing = callArgs.attachments;
          if (existing !== undefined && !Array.isArray(existing)) {
            throw new Error('args.attachments must be an array when attachment_files is used');
          }
          callArgs = {
            ...callArgs,
            attachments: [...(Array.isArray(existing) ? existing : []), ...files],
          };
        } catch (err) {
          return {
            content: content({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }),
            isError: true,
          };
        }
      }
      // Returns the authenticated approval URL immediately when policy gates
      // the call. The server callback resumes the session after a decision.
      const result = await callWithApprovalHandoff(client, connector, action, callArgs);
      return {
        content: content(result),
        // Pending approval is a successful handoff, not a connector failure.
        isError: result.status !== 'pending_approval' && !result.ok,
      };
    }

    case 'connect': {
      const slug = typeof args.slug === 'string' ? args.slug : '';
      if (!slug)
        return { content: content({ ok: false, error: 'slug is required' }), isError: true };
      const expires =
        typeof args.expires_in_minutes === 'number' ? args.expires_in_minutes : undefined;
      try {
        const link = await mintConnectLink({ slug, expiresInMinutes: expires });
        return {
          content: content({
            ok: true,
            slug: link.slug,
            app: link.app,
            url: link.url,
            expires_at: link.expires_at,
            instructions:
              'Surface this url to the human now. Web: opens a connect popup. Slack: tappable link.',
          }),
          isError: false,
        };
      } catch (err) {
        return {
          content: content({ ok: false, error: err instanceof Error ? err.message : String(err) }),
          isError: true,
        };
      }
    }

    case 'request_secret': {
      const names = Array.isArray(args.names)
        ? args.names.filter((n): n is string => typeof n === 'string')
        : [];
      if (names.length === 0)
        return { content: content({ ok: false, error: 'names is required' }), isError: true };
      const scope =
        args.scope === 'connector' ? 'connector' : args.scope === 'runtime' ? 'runtime' : undefined;
      const expires =
        typeof args.expires_in_minutes === 'number' ? args.expires_in_minutes : undefined;
      try {
        const link = await mintSecretLink({
          names,
          scope,
          expiresInMinutes: expires,
          labels: asRecord(args.labels) as Record<string, string>,
          descriptions: asRecord(args.descriptions) as Record<string, string>,
        });
        return {
          content: content({
            ok: true,
            names: link.names,
            scope: link.scope,
            url: link.url,
            expires_at: link.expires_at,
            instructions:
              'Surface this url to the human now. Web: opens a fill-in modal. Slack: tappable link. The value is never pasted into chat; once submitted it appears in KORTIX_PROJECT_SECRET_NAMES.',
          }),
          isError: false,
        };
      } catch (err) {
        return {
          content: content({ ok: false, error: err instanceof Error ? err.message : String(err) }),
          isError: true,
        };
      }
    }

    case 'secret_call': {
      const identifier = typeof args.identifier === 'string' ? args.identifier : '';
      const url = typeof args.url === 'string' ? args.url : '';
      if (!identifier || !url) {
        return {
          content: content({ ok: false, error: 'identifier and url are required' }),
          isError: true,
        };
      }
      const method =
        typeof args.method === 'string' && BROKER_METHODS.includes(args.method as BrokerMethod)
          ? (args.method as BrokerMethod)
          : undefined;
      const rawHeaders = asRecord(args.headers);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(rawHeaders)) {
        if (typeof value === 'string') headers[key.toLowerCase()] = value;
      }
      try {
        const result = await brokerSecretRequest({
          identifier,
          url,
          method,
          headers,
          ...(typeof args.body === 'string' ? { body: args.body } : {}),
        });
        // Hand back text when the upstream says it is text; base64 otherwise.
        // A model cannot act on a base64 blob, and silently utf8-decoding an
        // image would be worse than labelling it.
        const contentType = result.headers['content-type'] ?? '';
        const isText =
          contentType.startsWith('text/') ||
          contentType.includes('json') ||
          contentType.includes('xml') ||
          contentType.includes('javascript');
        return {
          content: content({
            ok: true,
            status: result.status,
            headers: result.headers,
            ...(isText
              ? { body: Buffer.from(result.body_base64, 'base64').toString('utf8') }
              : { body_base64: result.body_base64 }),
          }),
          // A 4xx/5xx is a real answer from upstream, not a tool failure — the
          // model needs the status and body to decide what to do next.
          isError: false,
        };
      } catch (err) {
        return {
          content: content({ ok: false, error: err instanceof Error ? err.message : String(err) }),
          isError: true,
        };
      }
    }

    case 'add_connector': {
      const slug = typeof args.slug === 'string' ? args.slug : '';
      const provider = typeof args.provider === 'string' ? args.provider : '';
      if (!slug || !provider)
        return {
          content: content({ ok: false, error: 'slug and provider are required' }),
          isError: true,
        };
      const draft: Record<string, unknown> = { slug, provider };
      for (const k of [
        'app',
        'name',
        'url',
        'transport',
        'endpoint',
        'spec',
        'credential',
      ] as const) {
        if (typeof args[k] === 'string') draft[k] = args[k];
      }
      if (typeof args.base_url === 'string') draft.baseUrl = args.base_url;
      try {
        const res = await addConnector(draft);
        return {
          content: content({
            ok: true,
            slug,
            provider,
            applied: true,
            sync: res.sync,
            instructions: `Live now (committed to kortix.yaml on main + synced) — no change request needed. Next: call connect("${slug}") for a Pipedream app, or request_secret for an API key.`,
          }),
          isError: false,
        };
      } catch (err) {
        return {
          content: content({ ok: false, error: err instanceof Error ? err.message : String(err) }),
          isError: true,
        };
      }
    }

    case 'remove_connector': {
      const slug = typeof args.slug === 'string' ? args.slug : '';
      if (!slug)
        return { content: content({ ok: false, error: 'slug is required' }), isError: true };
      try {
        await removeConnector(slug);
        return { content: content({ ok: true, slug, removed: true }), isError: false };
      } catch (err) {
        return {
          content: content({ ok: false, error: err instanceof Error ? err.message : String(err) }),
          isError: true,
        };
      }
    }

    default:
      return { content: content({ ok: false, error: `unknown tool ${name}` }), isError: true };
  }
}

async function handle(req: JsonRpcRequest, client: ConnectorClient) {
  switch (req.method) {
    case 'initialize':
      return {
        protocolVersion: asRecord(req.params).protocolVersion ?? '2025-06-18',
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      };

    case 'tools/list':
      return {
        tools: META_TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: { readOnlyHint: tool.readOnly },
        })),
      };

    case 'tools/call': {
      const params = asRecord(req.params);
      return runMetaTool(client, stringField(params, 'name'), asRecord(params.arguments));
    }

    case 'notifications/initialized':
      return undefined;

    default:
      throw new Error(`unsupported MCP method: ${req.method}`);
  }
}

function writeResponse(
  id: JsonRpcRequest['id'],
  result: unknown,
  error?: { code: number; message: string },
) {
  if (id === undefined || id === null) return;
  const payload = error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** Run the stdio JSON-RPC loop until stdin closes. */
export async function runConnectorMcpServer(): Promise<number> {
  const client = connectorClient();
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk);
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl < 0) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(line);
      } catch {
        writeResponse(null, null, { code: -32700, message: 'parse error' });
        continue;
      }
      try {
        const result = await handle(req, client);
        writeResponse(req.id, result);
      } catch (err) {
        writeResponse(req.id, null, {
          code: -32000,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return 0;
}
