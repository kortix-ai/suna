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
 * runs the call, and audits it. The sandbox only carries KORTIX_TOKEN +
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
  finalizeConnectorConnection,
  mintConnectLink,
  mintSecretLink,
  removeConnector,
  type BrokerMethod,
  type ConnectorClient,
} from './gateway.ts';
import {
  attachmentRef,
  attachmentSlot,
  insertAttachmentHandles,
  uploadAttachmentFiles,
} from './attachments.ts';
import { connectorErrorPayload } from './io.ts';

export { uploadAttachmentFiles } from './attachments.ts';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

// The MCP server identity is `kortix-connectors`, matching the CLI command tree.
const SERVER_INFO = { name: 'kortix-connectors', version: '0.3.0' };

const BROKER_METHODS: BrokerMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/**
 * The fixed meta-tool surface. Stable regardless of how many connectors or
 * actions a session has — that's the whole point versus exploding the catalog.
 */
const META_TOOLS = [
  {
    name: 'connectors',
    description:
      'List the connectors this session can use (Pipedream / MCP / OpenAPI / Postman / GraphQL / HTTP), each with its provider, status, and number of tools. Start here to see what is available.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
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
        limit: {
          type: 'number',
          description: 'Maximum matches to return (default 20).',
        },
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
      'Run a tool. The gateway resolves the credential server-side, enforces sharing + policy, executes the call, and audits it. Returns { ok, data, risk, account } on success — `account` names WHICH connected account actually ran the call — or a denial / pending-approval result. A connector may have several accounts (see `accounts`); if it does and the human did not say which one, ask — or say which one you used, reading it off the result\'s `account`. If several accounts are reachable, none is named, and none is pinned as the default, the call is denied with reason "account_required" (not a guess) — pass `account`, or tell the human to pin one with `kortix connectors accounts <slug> --default <label>`. To attach files to an email (native Email channel, Microsoft Graph sendMail, SendGrid, Postmark, …), pass local file references in attachment_files and leave the attachment array out of args; this MCP uploads raw bytes outside the model and JSON-RPC payloads, and the gateway writes them into the field the action\'s schema declares. Never paste base64 into args. GraphQL tools take selected fields via an "__select" arg, e.g. {"id":"1","__select":"id name email"}.',
    inputSchema: {
      type: 'object',
      properties: {
        connector: {
          type: 'string',
          description: 'Connector slug, e.g. "stripe".',
        },
        action: {
          type: 'string',
          description: 'Action path within the connector, e.g. "charges.create".',
        },
        args: {
          type: 'object',
          description: "Arguments matching the tool's input schema (see describe). Defaults to {}.",
        },
        account: {
          type: 'string',
          description:
            'Which connected account to run as, when this connector has more than one (a shared project account and each member\'s own). Give the account label or its connection id exactly as `accounts` returns it, or the selector word `me` (the caller\'s own default private account) or `project` (the project\'s default shared account). Omit to use the default account. A name that matches nothing is refused and the refusal lists the available names — it never silently runs as a different account.',
        },
        attachment_files: {
          type: 'array',
          description:
            'Local files to attach. Works for any action whose input schema has an `attachments` array, at any depth (for example `body.message.attachments` on Microsoft Graph sendMail). Paths must be absolute and inside /workspace/output, /workspace/artifacts, /workspace/reports, or /workspace/deliverables. The MCP uploads raw bytes and passes opaque attachment handles; the gateway base64-encodes them server-side, so never paste base64 into args.',
          items: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Absolute local file path.',
              },
              filename: {
                type: 'string',
                description: 'Optional recipient-visible filename.',
              },
              content_type: {
                type: 'string',
                description: 'Optional MIME type.',
              },
              content_disposition: {
                type: 'string',
                enum: ['attachment', 'inline'],
                description: 'Defaults to attachment.',
              },
              content_id: {
                type: 'string',
                description: 'Optional inline content ID.',
              },
            },
            required: ['path'],
            additionalProperties: false,
          },
          maxItems: 20,
        },
        attachment_path: {
          type: 'string',
          description:
            'Optional dotted path of the array that receives attachment_files, e.g. "body.message.attachments". Omit it: the first array named `attachments` in the action\'s input schema is used.',
        },
      },
      required: ['connector', 'action'],
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'upload_attachment',
    description:
      'Stage one local file for a connector call and get back `ref`, the value {"$kortix_attachment": "<id>"}. Put `ref` anywhere in `call` args: as an `attachments[]` element the gateway builds the provider\'s attachment item (Microsoft Graph fileAttachment, SendGrid, Postmark, …); in a string field such as `contentBytes` or `content` it becomes the file\'s base64. The bytes never pass through the model. For the common case, `call` with attachment_files does upload + placement in one step. A staged file is single-use and expires after 24 hours.',
    inputSchema: {
      type: 'object',
      properties: {
        connector: {
          type: 'string',
          description: 'Slug of the connector the file is for, e.g. "microsoft-graph".',
        },
        path: {
          type: 'string',
          description:
            'Absolute path inside /workspace/output, /workspace/artifacts, /workspace/reports, or /workspace/deliverables.',
        },
        filename: { type: 'string', description: 'Optional recipient-visible filename.' },
        content_type: { type: 'string', description: 'Optional MIME type.' },
        content_disposition: {
          type: 'string',
          enum: ['attachment', 'inline'],
          description: 'Defaults to attachment.',
        },
        content_id: { type: 'string', description: 'Optional inline content ID.' },
      },
      required: ['connector', 'path'],
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'accounts',
    description:
      'Use this whenever the human asks which/how many accounts are connected, or before a call where the account matters. Never infer accounts from a profile/whoami call — a connector can hold several accounts, and a single get_profile/get_me only ever answers for one of them. List the connected accounts a connector can be called as, default first. Each account is either SHARED with the project (owner_type "project") or PRIVATE to one member (owner_type "member"). Use this before passing `account` to `call`, and when a call is denied `connector_not_connected` (nothing named matched) or `account_required` (several accounts, none named, none pinned — the denial lists `available_accounts`). `call` also accepts the two selector words `me` (the caller\'s own default private account) and `project` (the project\'s default shared account) instead of a label or id. A human can pin one account as the default with `kortix connectors accounts <slug> --default <label>`, after which unnamed calls use it. An empty list means nothing is connected yet — call `connect` to get a link for the human.',
    inputSchema: {
      type: 'object',
      properties: {
        connector: { type: 'string', description: 'Connector slug, e.g. "gmail".' },
      },
      required: ['connector'],
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: 'connect',
    description:
      'Start the configured provider authorization for a connector — its first account, or an additional one beside the accounts `accounts` already lists — and SURFACE any returned url to the human in your reply. This works for Composio and explicit legacy Pipedream connectors. In the web UI the link opens a connect popup; in Slack it is tappable. No credential ever touches the sandbox. The connector must already exist in kortix.yaml.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: 'Connector slug to connect, e.g. "smartlead".',
        },
        expires_in_minutes: {
          type: 'number',
          description: 'Link lifetime in minutes (default 30, max 1440).',
        },
        owner: {
          type: 'string',
          enum: ['me', 'project'],
          description:
            'Who the new account belongs to: "me" (the human who opens the link, and only they can call with it — the default) or "project" (shared with every project member, which requires project.connector.write). Ask the human before choosing "project": it authorizes an identity the whole project can spend.',
        },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'finalize_connection',
    description:
      'After the human finishes the authorization URL returned by `connect`, confirm the provider connection and persist its account binding. Pass through the connection_id and request_id returned by `connect`. If connected=false, ask the human to finish authorization and retry. Works for Composio and explicit legacy Pipedream connectors.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: 'Connector slug that was authorized.',
        },
        connection_id: {
          type: 'string',
          description: 'Connection ID returned by `connect`, when present.',
        },
        request_id: {
          type: 'string',
          description: 'Authorization request ID returned by `connect`, when present.',
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
      'Get a link the human opens to enter one or more project SECRET values (e.g. an API key), and SURFACE the returned url in your reply. Use this whenever you need a credential you do not have — never ask the human to paste a raw key into chat or to hunt through the dashboard. The value is never pasted into chat. In the web UI the link opens a fill-in modal; in Slack it is a tappable link. The default connector scope keeps the value server-side. Use runtime scope only when a sandbox process must receive the value.',
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
          description: 'connector (default, server-side only) or runtime (sandbox environment).',
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
      'Add or update a connector on this project now. The command commits kortix.yaml to main and syncs it server-side. For managed SaaS apps such as Gmail, GitHub, Slack, Notion, or Calendar, use provider="composio" and the Composio toolkit slug. Composio is the default managed provider. Pipedream is legacy rollback only and must never be selected unless the human explicitly asks for Pipedream. Use `connect` for managed OAuth or `request_secret` for direct API credentials.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: 'Connector slug, e.g. "smartlead".',
        },
        provider: {
          type: 'string',
          enum: ['composio', 'pipedream', 'mcp', 'openapi', 'postman', 'graphql', 'http'],
          description:
            'Connector provider. Use composio for managed SaaS apps. Pipedream is legacy rollback only and requires allow_legacy_pipedream=true.',
        },
        app: {
          type: 'string',
          description:
            'Managed app/toolkit slug. For Composio use the discovered toolkit slug, e.g. "gmail" or "composio_search".',
        },
        allow_legacy_pipedream: {
          type: 'boolean',
          description:
            'Required only for an explicit human-requested Pipedream rollback. Never set this merely because an app needs OAuth.',
        },
        name: { type: 'string', description: 'Optional display name.' },
        url: { type: 'string', description: 'MCP server URL (provider=mcp).' },
        transport: {
          type: 'string',
          enum: ['http', 'sse'],
          description: 'MCP transport (provider=mcp).',
        },
        endpoint: {
          type: 'string',
          description: 'GraphQL endpoint (provider=graphql).',
        },
        base_url: {
          type: 'string',
          description: 'HTTP base URL (provider=http).',
        },
        spec: {
          type: 'string',
          description: 'OpenAPI/Postman/GraphQL/HTTP spec or source ref.',
        },
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
      properties: {
        slug: { type: 'string', description: 'Connector slug to remove.' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    readOnly: false,
  },
] as const;

/** One account, as summarized on `connectors` / `describe` tool output. */
interface AccountSummaryEntry {
  label: string;
  /** `private` = one member's own account. `shared` = the project's account. */
  owner: 'shared' | 'private';
  default: boolean;
  connection_id: string;
}

/** `private` for a member-owned account, `shared` for everything else (the project's). */
function ownerKind(ownerType: string): 'shared' | 'private' {
  return ownerType === 'member' ? 'private' : 'shared';
}

/**
 * Summarize a connector's accounts for a meta-tool result: the
 * label/owner/default table, `default_account`, and — only when there is a
 * real choice to make (more than one account) — `how_to_choose`, a
 * copy-pasteable `call` shape naming the default.
 */
function accountsSummary(
  connector: string,
  accounts: ReadonlyArray<{
    connection_id: string;
    label: string;
    owner_type: string;
    is_default: boolean;
  }>,
  defaultLabel: string | null,
): { accounts: AccountSummaryEntry[]; default_account: string | null; how_to_choose?: string } {
  const entries: AccountSummaryEntry[] = accounts.map((a) => ({
    label: a.label,
    owner: ownerKind(a.owner_type),
    default: a.is_default,
    connection_id: a.connection_id,
  }));
  const resolvedDefault = defaultLabel ?? entries[0]?.label ?? null;
  return {
    accounts: entries,
    default_account: resolvedDefault,
    ...(entries.length > 1 && resolvedDefault
      ? {
          how_to_choose: `call {connector: "${connector}", action: "<action>", account: "${resolvedDefault}"}`,
        }
      : {}),
  };
}

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
  return [
    {
      type: 'text',
      text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
    },
  ];
}

async function runMetaTool(client: ConnectorClient, name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'connectors': {
      const connectors = await client.catalog();
      return {
        content: content({
          connectors: connectors.map((c) => {
            const summary = accountsSummary(c.slug, c.accounts ?? [], c.default_account ?? null);
            return {
              slug: c.slug,
              name: c.name,
              provider: c.provider,
              status: c.status,
              tools: c.actions.length,
              ...summary,
            };
          }),
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
          matches: matches.map((m) => ({
            tool: m.tool,
            risk: m.risk,
            description: m.description,
          })),
        }),
        isError: false,
      };
    }

    case 'describe': {
      const ref = typeof args.tool === 'string' ? args.tool : '';
      if (!ref.includes('.')) {
        return {
          content: content({
            ok: false,
            error: 'tool must be a "<connector>.<action>" path',
          }),
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
      // Same accounts summary as `connectors` — a describe call is often the
      // step right before `call`, so this is where `account` gets decided.
      const accounts = await client.accounts(tool.connector).catch(() => []);
      return {
        content: content({
          tool: tool.tool,
          risk: tool.risk,
          description: tool.description,
          inputSchema: tool.inputSchema,
          // `accounts` comes back default-first (see listEntitledConnectorConnections),
          // so the first entry is what an unnamed call resolves to.
          ...accountsSummary(tool.connector, accounts, accounts[0]?.label ?? null),
        }),
        isError: false,
      };
    }

    case 'call': {
      const connector = typeof args.connector === 'string' ? args.connector : '';
      const action = typeof args.action === 'string' ? args.action : '';
      if (!connector || !action) {
        return {
          content: content({
            ok: false,
            error: 'connector and action are required',
          }),
          isError: true,
        };
      }
      let callArgs = asRecord(args.args);
      if (args.attachment_files !== undefined) {
        const described = await client.describe(`${connector}.${action}`);
        try {
          const slot = described
            ? attachmentSlot(
                described.inputSchema,
                typeof args.attachment_path === 'string' ? args.attachment_path : undefined,
              )
            : null;
          if (!slot) {
            return {
              content: content({
                ok: false,
                error: `${connector}.${action} does not accept attachments: its input schema has no \`attachments\` array. Pass attachment_path to name the array field.`,
              }),
              isError: true,
            };
          }
          const files = await uploadAttachmentFiles(args.attachment_files, client, { connector });
          callArgs = insertAttachmentHandles(
            callArgs,
            slot,
            files.map((file) => attachmentRef(file.attachment_id)),
          );
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
      let result;
      try {
        result = await callWithApprovalHandoff(client, connector, action, callArgs, {
          account: typeof args.account === 'string' ? args.account : null,
        });
      } catch (err) {
        // A denial is an HTTP 403, so the SDK THROWS it. Left to the JSON-RPC
        // loop it would reach the model as a bare `message` string, dropping
        // `available_accounts`, `hint` and `connect_url` — the only fields
        // that tell the model what to do next. Hand back the API body itself.
        return { content: content(connectorErrorPayload(err)), isError: true };
      }
      return {
        // The result passes through untouched, including the `account` echo
        // that names WHICH identity ran the call.
        content: content(result),
        // Pending approval is a successful handoff, not a connector failure.
        isError: result.status !== 'pending_approval' && !result.ok,
      };
    }

    case 'upload_attachment': {
      const connector = typeof args.connector === 'string' ? args.connector.trim() : '';
      if (!connector) {
        return { content: content({ ok: false, error: 'connector is required' }), isError: true };
      }
      try {
        const { connector: _connector, ...file } = args;
        const [uploaded] = await uploadAttachmentFiles([file], client, { connector });
        return {
          content: content({ ok: true, ...uploaded, ref: attachmentRef(uploaded!.attachment_id) }),
          isError: false,
        };
      } catch (err) {
        return { content: content(connectorErrorPayload(err)), isError: true };
      }
    }

    case 'accounts': {
      const connector = typeof args.connector === 'string' ? args.connector : '';
      if (!connector) {
        return {
          content: content({ ok: false, error: 'connector is required' }),
          isError: true,
        };
      }
      const accounts = await client.accounts(connector);
      return {
        content: content({
          ok: true,
          connector,
          accounts,
          ...(accounts.length === 0
            ? {
                note: `Nothing is connected to "${connector}" yet. Call connect to get an authorization link for the human.`,
              }
            : {}),
        }),
        isError: false,
      };
    }

    case 'connect': {
      const slug = typeof args.slug === 'string' ? args.slug : '';
      if (!slug)
        return {
          content: content({ ok: false, error: 'slug is required' }),
          isError: true,
        };
      const expires =
        typeof args.expires_in_minutes === 'number' ? args.expires_in_minutes : undefined;
      // Default `me`: the human authorizes themselves. `project` is an explicit
      // choice — it creates an account every member can spend — so anything
      // else is refused rather than quietly downgraded.
      const owner: 'me' | 'project' | undefined =
        args.owner === 'me' || args.owner === 'project' ? args.owner : undefined;
      if (args.owner !== undefined && owner === undefined) {
        return {
          content: content({ ok: false, error: 'owner must be "me" or "project"' }),
          isError: true,
        };
      }
      try {
        const link = await mintConnectLink({
          slug,
          expiresInMinutes: expires,
          ...(owner ? { owner } : {}),
        });
        return {
          content: content({
            ok: true,
            slug: link.slug,
            owner: owner ?? 'me',
            provider: link.provider,
            app: link.app,
            url: link.url,
            expires_at: link.expires_at,
            connected: link.connected,
            is_no_auth: link.is_no_auth,
            session_id: link.session_id,
            connection_id: link.connection_id,
            request_id: link.request_id,
            instructions: link.url
              ? 'Surface this url to the human now. After they approve it, call finalize_connection with this slug, connection_id, and request_id.'
              : link.connected
                ? 'The connector is connected and ready to call.'
                : 'No authorization URL was returned. Do not call connector actions until connected=true.',
          }),
          isError: false,
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

    case 'finalize_connection': {
      const slug = typeof args.slug === 'string' ? args.slug : '';
      if (!slug)
        return {
          content: content({ ok: false, error: 'slug is required' }),
          isError: true,
        };
      try {
        const result = await finalizeConnectorConnection({
          slug,
          ...(typeof args.connection_id === 'string' ? { connectionId: args.connection_id } : {}),
          ...(typeof args.request_id === 'string' ? { requestId: args.request_id } : {}),
        });
        return {
          content: content({
            ok: result.connected,
            slug,
            ...result,
            instructions: result.connected
              ? 'Connection confirmed. Discover or call the connector actions now.'
              : 'Authorization is not complete yet. Ask the human to finish the provider flow, then retry finalize_connection.',
          }),
          isError: false,
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

    case 'request_secret': {
      const names = Array.isArray(args.names)
        ? args.names.filter((n): n is string => typeof n === 'string')
        : [];
      if (names.length === 0)
        return {
          content: content({ ok: false, error: 'names is required' }),
          isError: true,
        };
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
              link.scope === 'runtime'
                ? 'Surface this url to the human now. Web: opens a fill-in modal. Slack: tappable link. The runtime value appears in KORTIX_PROJECT_SECRET_NAMES after submission.'
                : 'Surface this url to the human now. Web: opens a fill-in modal. Slack: tappable link. The connector value remains server-side and never appears in KORTIX_PROJECT_SECRET_NAMES.',
          }),
          isError: false,
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

    case 'secret_call': {
      const identifier = typeof args.identifier === 'string' ? args.identifier : '';
      const url = typeof args.url === 'string' ? args.url : '';
      if (!identifier || !url) {
        return {
          content: content({
            ok: false,
            error: 'identifier and url are required',
          }),
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
              ? {
                  body: Buffer.from(result.body_base64, 'base64').toString('utf8'),
                }
              : { body_base64: result.body_base64 }),
          }),
          // A 4xx/5xx is a real answer from upstream, not a tool failure — the
          // model needs the status and body to decide what to do next.
          isError: false,
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

    case 'add_connector': {
      const slug = typeof args.slug === 'string' ? args.slug : '';
      const provider = typeof args.provider === 'string' ? args.provider : '';
      if (!slug || !provider)
        return {
          content: content({
            ok: false,
            error: 'slug and provider are required',
          }),
          isError: true,
        };
      if (provider === 'pipedream' && args.allow_legacy_pipedream !== true) {
        return {
          content: content({
            ok: false,
            error:
              'Pipedream is legacy rollback only. Use provider="composio" for managed SaaS apps. If Composio cannot satisfy the request, stop and ask the human before setting allow_legacy_pipedream=true.',
          }),
          isError: true,
        };
      }
      const draft: Record<string, unknown> = { slug, provider };
      if (provider === 'pipedream') draft.allow_legacy_pipedream = true;
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
            instructions: `Live now (committed to kortix.yaml on main + synced) — no change request needed. Next: call connect("${slug}") for managed provider authorization, or request_secret for a direct API key.`,
          }),
          isError: false,
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

    case 'remove_connector': {
      const slug = typeof args.slug === 'string' ? args.slug : '';
      if (!slug)
        return {
          content: content({ ok: false, error: 'slug is required' }),
          isError: true,
        };
      try {
        await removeConnector(slug);
        return {
          content: content({ ok: true, slug, removed: true }),
          isError: false,
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

    default:
      return {
        content: content({ ok: false, error: `unknown tool ${name}` }),
        isError: true,
      };
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
