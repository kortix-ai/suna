/**
 * The fixed meta-tool catalog of the `connectors` MCP server.
 *
 * Stable regardless of how many connectors or actions a session has — that's
 * the whole point versus exploding the catalog. These records are pure data:
 * the JSON-RPC transport lives in mcp.ts, the execution in mcp-run.ts.
 */

export const META_TOOLS = [
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
      'Run a tool. The gateway resolves the credential server-side, enforces sharing + policy, executes the call, and audits it. Returns { ok, data, risk, account } on success — `account` names WHICH connected account actually ran the call — or a denial / pending-approval result. A connector may have several accounts (see `accounts`); if it does and the human did not say which one, ask — or say which one you used, reading it off the result\'s `account`. If several accounts are reachable, none is named, and none is pinned as the default, the call is denied with reason "account_required" (not a guess) — pass `account`, or tell the human to pin one with `kortix connectors accounts <slug> --default <label>`. To attach files to an email (native Email channel, Microsoft Graph sendMail, SendGrid, Postmark, …), pass local file references in attachment_files and leave the attachment array out of args; this MCP uploads raw bytes outside the model and JSON-RPC payloads, and the gateway writes them into the field the action\'s schema declares. Never paste base64 into args. GraphQL tools take selected fields via an "__select" arg, e.g. {"id":"1","__select":"id name email"}. A result larger than 16 KB is saved as JSON under /workspace/.kortix/state/connector-results/ and returned as { saved_to, bytes, shape, preview }: query the file with jq or bun instead of reading it whole.',
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
            "Which connected account to run as, when this connector has more than one (a shared project account and each member's own). Give the account label or its connection id exactly as `accounts` returns it, or the selector word `me` (the caller's own default private account) or `project` (the project's default shared account). Omit to use the default account. A name that matches nothing is refused and the refusal lists the available names — it never silently runs as a different account.",
        },
        approval_context: {
          type: 'string',
          description:
            'What this call does, in plain words, shown to the human if a policy holds it for approval. Always pass it for writes whose args are only ids: for send_draft say who it goes to, the subject, and the body; for a delete say what gets deleted. The approver sees it labelled as your description next to the real arguments.',
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
      "Mint a link that adds a NEW account to a connector — its first, or another beside the accounts `accounts` already lists — and SURFACE the returned url to the human in your reply. In the web UI the link opens a dialog where the human names the account (prefilled from `label`), chooses who can use it (only them, everyone in the project, or chosen people or groups), and signs in with the provider. When it lands you are told the account's name: pass it as `account` on every call, because a connector with several accounts refuses an unnamed call. Works for Composio and explicit legacy Pipedream connectors. In Slack the link is tappable. No credential ever touches the sandbox. The connector must already exist in kortix.yaml.",
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
            'Who the new account belongs to: "me" (the human who opens the link, and only they can call with it — the default) or "project" (shared with every project member, which requires project.connector.write). In the web dialog this is only the preselected choice; the human decides. Ask the human before choosing "project": it authorizes an identity the whole project can spend.',
        },
        label: {
          type: 'string',
          description:
            'A name for the new account that tells it apart from the others, e.g. "Dad\'s Gmail" or "Support inbox". The human sees it prefilled and may change it. Not "me", "project", or an id.',
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
      'Get a link the human opens to enter one or more project SECRET values (e.g. an API key) that you do NOT have, and SURFACE the returned url in your reply. If the value is already in the conversation, call set_secret instead — do not make the human enter it twice. Never send the human to hunt through the dashboard. In the web UI the link opens a fill-in modal; in Slack it is a tappable link. The default connector scope keeps the value server-side. Use runtime scope only when a sandbox process must receive the value.',
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
    name: 'set_secret',
    description:
      'Store project SECRET value(s) you already HAVE — e.g. an API key the human gave in the conversation. Saves directly, no link. Needs your project secret-write permission; a 403 means you lack it, so fall back to request_secret. Do not echo the value back in your reply. runtime scope (default) loads it into the sandbox env; connector scope keeps it server-side for the connector gateway.',
    inputSchema: {
      type: 'object',
      properties: {
        values: {
          type: 'object',
          description:
            'Map of env var name to value, e.g. { "APOLLO_API_KEY": "<value>" }. Names are UPPER_SNAKE_CASE.',
        },
        scope: {
          type: 'string',
          enum: ['runtime', 'connector'],
          description: 'runtime (default, sandbox environment) or connector (server-side only).',
        },
      },
      required: ['values'],
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
