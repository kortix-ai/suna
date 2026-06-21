/**
 * `kortix executor mcp` — the Executor exposed as a stdio MCP server.
 *
 * This is the agent's PRIMARY interface to every configured integration
 * (Pipedream / MCP / OpenAPI / GraphQL / HTTP). OpenCode auto-loads it in every
 * session (the daemon registers `kortix executor mcp` via OPENCODE_CONFIG_CONTENT),
 * so the agent reaches connectors as native MCP tools.
 *
 * Modeled on RhysSullivan/executor: instead of exploding every connector action
 * into tools/list (which floods context once a catalog has hundreds of actions),
 * we expose a small, stable set of META-TOOLS and let the agent progressively
 * discover what it needs.
 *
 * Thin client: it never holds a third-party credential. Every call goes to the
 * Kortix Executor Gateway, which checks sharing, resolves the secret SERVER-SIDE,
 * runs the call, and audits it. The sandbox only carries KORTIX_EXECUTOR_TOKEN +
 * KORTIX_API_URL (injected at sandbox spawn).
 *
 * STDOUT IS THE JSON-RPC CHANNEL — nothing else may be written there. index.ts
 * skips the host/update notices for `executor`, so this stays clean.
 */
import type { ExecutorClient } from '@kortix/executor-sdk';
import {
  addConnector,
  executorClient,
  mintConnectLink,
  mintSecretLink,
  removeConnector,
} from './gateway.ts';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

// The MCP server identity is kept as `kortix-executor` (unchanged from the old
// standalone shim) so the agent's tool names and registration key don't move.
const SERVER_INFO = { name: 'kortix-executor', version: '0.3.0' };

/**
 * The fixed meta-tool surface. Stable regardless of how many connectors or
 * actions a session has — that's the whole point versus exploding the catalog.
 */
const META_TOOLS = [
  {
    name: 'connectors',
    description:
      'List the integration connectors this session can use (Pipedream / MCP / OpenAPI / GraphQL / HTTP), each with its provider, status, and number of tools. Start here to see what is available.',
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
          description: 'Natural-language intent to search for. Empty returns the first available tools.',
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
      "Show one tool's full input JSON schema, risk, and description. Pass the connector-namespaced path from discover, e.g. \"stripe.charges.create\". Always describe an unfamiliar tool before calling it.",
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
      'Run a tool. The gateway resolves the credential server-side, enforces sharing + policy, executes the call, and audits it. Returns { ok, data, risk } on success, or a denial / pending-approval result. GraphQL tools take selected fields via an "__select" arg, e.g. {"id":"1","__select":"id name email"}.',
    inputSchema: {
      type: 'object',
      properties: {
        connector: { type: 'string', description: 'Connector slug, e.g. "stripe".' },
        action: { type: 'string', description: 'Action path within the connector, e.g. "charges.create".' },
        args: {
          type: 'object',
          description: "Arguments matching the tool's input schema (see describe). Defaults to {}.",
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
      'Get a 1-click Pipedream Quick Connect link for a connector that is declared but not yet authenticated, and SURFACE the returned url to the human in your reply. Use this the moment you add/need a Pipedream connector — never tell the human to open the dashboard. In the web UI the link opens a connect popup; in Slack it is a tappable link. No credential ever touches the sandbox. The connector must already exist in kortix.toml (add it + land the change request first).',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Connector slug to connect, e.g. "smartlead".' },
        expires_in_minutes: { type: 'number', description: 'Link lifetime in minutes (default 30, max 1440).' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'request_secret',
    description:
      'Get a link the human opens to enter one or more project SECRET values (e.g. an API key), and SURFACE the returned url in your reply. Use this whenever you need a credential you do not have — never ask the human to paste a raw key into chat or to hunt through the dashboard. You never see the value; once they submit it, the secret becomes available to your session (check KORTIX_PROJECT_SECRET_NAMES). In the web UI the link opens a fill-in modal; in Slack it is a tappable link. scope "runtime" (default) injects the value into your sandbox env; "connector" keeps it server-side only.',
    inputSchema: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Env var name(s) to request, e.g. ["APOLLO_API_KEY","SMARTLEAD_API_KEY"]. UPPER_SNAKE_CASE.',
        },
        scope: { type: 'string', enum: ['runtime', 'connector'], description: 'runtime (default) or connector.' },
        labels: { type: 'object', description: 'Optional per-name human label, { NAME: "label" }.' },
        descriptions: { type: 'object', description: 'Optional per-name hint shown on the form, { NAME: "where to find it" }.' },
        expires_in_minutes: { type: 'number', description: 'Link lifetime in minutes (default 30, max 1440).' },
      },
      required: ['names'],
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'add_connector',
    description:
      'Add (or update) an integration connector on this project RIGHT NOW — committed to kortix.toml on main and synced server-side, exactly like the dashboard\'s "Add app". No change request needed; it is live this session. Use this to set up a new tool, then call `connect` (Pipedream) or `request_secret` for its credential. For Pipedream pass provider="pipedream" + app (e.g. "smartlead").',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Connector slug, e.g. "smartlead".' },
        provider: { type: 'string', enum: ['pipedream', 'mcp', 'openapi', 'graphql', 'http'], description: 'Connector provider.' },
        app: { type: 'string', description: 'Pipedream app slug (provider=pipedream), e.g. "smartlead".' },
        name: { type: 'string', description: 'Optional display name.' },
        url: { type: 'string', description: 'MCP server URL (provider=mcp).' },
        transport: { type: 'string', enum: ['http', 'sse'], description: 'MCP transport (provider=mcp).' },
        endpoint: { type: 'string', description: 'GraphQL endpoint (provider=graphql).' },
        base_url: { type: 'string', description: 'HTTP base URL (provider=http).' },
        spec: { type: 'string', description: 'OpenAPI/GraphQL/HTTP spec ref.' },
        credential: { type: 'string', enum: ['shared', 'per_user'], description: 'Credential storage mode.' },
      },
      required: ['slug', 'provider'],
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'remove_connector',
    description: 'Remove a connector from this project (committed to kortix.toml on main + catalog). No change request needed.',
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

async function runMetaTool(executor: ExecutorClient, name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'connectors': {
      const connectors = await executor.connectors();
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
      const matches = await executor.discover(query, limit !== undefined ? { limit } : {});
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
        return { content: content({ ok: false, error: 'tool must be a "<connector>.<action>" path' }), isError: true };
      }
      const tool = await executor.describe(ref);
      if (!tool) {
        return { content: content({ ok: false, error: `unknown tool "${ref}" — run discover to list tools` }), isError: true };
      }
      return {
        content: content({ tool: tool.tool, risk: tool.risk, description: tool.description, inputSchema: tool.inputSchema }),
        isError: false,
      };
    }

    case 'call': {
      const connector = typeof args.connector === 'string' ? args.connector : '';
      const action = typeof args.action === 'string' ? args.action : '';
      if (!connector || !action) {
        return { content: content({ ok: false, error: 'connector and action are required' }), isError: true };
      }
      const callArgs = asRecord(args.args);
      const result = await executor.call(connector, action, callArgs);
      return { content: content(result), isError: !result.ok };
    }

    case 'connect': {
      const slug = typeof args.slug === 'string' ? args.slug : '';
      if (!slug) return { content: content({ ok: false, error: 'slug is required' }), isError: true };
      const expires = typeof args.expires_in_minutes === 'number' ? args.expires_in_minutes : undefined;
      try {
        const link = await mintConnectLink({ slug, expiresInMinutes: expires });
        return {
          content: content({
            ok: true,
            slug: link.slug,
            app: link.app,
            url: link.url,
            expires_at: link.expires_at,
            instructions: 'Surface this url to the human now. Web: opens a connect popup. Slack: tappable link.',
          }),
          isError: false,
        };
      } catch (err) {
        return { content: content({ ok: false, error: err instanceof Error ? err.message : String(err) }), isError: true };
      }
    }

    case 'request_secret': {
      const names = Array.isArray(args.names)
        ? args.names.filter((n): n is string => typeof n === 'string')
        : [];
      if (names.length === 0) return { content: content({ ok: false, error: 'names is required' }), isError: true };
      const scope = args.scope === 'connector' ? 'connector' : args.scope === 'runtime' ? 'runtime' : undefined;
      const expires = typeof args.expires_in_minutes === 'number' ? args.expires_in_minutes : undefined;
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
            instructions: 'Surface this url to the human now. Web: opens a fill-in modal. Slack: tappable link. You never see the value; once submitted it appears in KORTIX_PROJECT_SECRET_NAMES.',
          }),
          isError: false,
        };
      } catch (err) {
        return { content: content({ ok: false, error: err instanceof Error ? err.message : String(err) }), isError: true };
      }
    }

    case 'add_connector': {
      const slug = typeof args.slug === 'string' ? args.slug : '';
      const provider = typeof args.provider === 'string' ? args.provider : '';
      if (!slug || !provider) return { content: content({ ok: false, error: 'slug and provider are required' }), isError: true };
      const draft: Record<string, unknown> = { slug, provider };
      for (const k of ['app', 'name', 'url', 'transport', 'endpoint', 'spec', 'credential'] as const) {
        if (typeof args[k] === 'string') draft[k] = args[k];
      }
      if (typeof args.base_url === 'string') draft.baseUrl = args.base_url;
      try {
        const res = await addConnector(draft);
        return {
          content: content({
            ok: true, slug, provider, applied: true, sync: res.sync,
            instructions: `Live now (committed to kortix.toml on main + synced) — no change request needed. Next: call connect("${slug}") for a Pipedream app, or request_secret for an API key.`,
          }),
          isError: false,
        };
      } catch (err) {
        return { content: content({ ok: false, error: err instanceof Error ? err.message : String(err) }), isError: true };
      }
    }

    case 'remove_connector': {
      const slug = typeof args.slug === 'string' ? args.slug : '';
      if (!slug) return { content: content({ ok: false, error: 'slug is required' }), isError: true };
      try {
        await removeConnector(slug);
        return { content: content({ ok: true, slug, removed: true }), isError: false };
      } catch (err) {
        return { content: content({ ok: false, error: err instanceof Error ? err.message : String(err) }), isError: true };
      }
    }

    default:
      return { content: content({ ok: false, error: `unknown tool ${name}` }), isError: true };
  }
}

async function handle(req: JsonRpcRequest, executor: ExecutorClient) {
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
      return runMetaTool(executor, stringField(params, 'name'), asRecord(params.arguments));
    }

    case 'notifications/initialized':
      return undefined;

    default:
      throw new Error(`unsupported MCP method: ${req.method}`);
  }
}

function writeResponse(id: JsonRpcRequest['id'], result: unknown, error?: { code: number; message: string }) {
  if (id === undefined || id === null) return;
  const payload = error
    ? { jsonrpc: '2.0', id, error }
    : { jsonrpc: '2.0', id, result };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** Run the stdio JSON-RPC loop until stdin closes. */
export async function runExecutorMcpServer(): Promise<number> {
  const executor = executorClient();
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
        const result = await handle(req, executor);
        writeResponse(req.id, result);
      } catch (err) {
        writeResponse(req.id, null, { code: -32000, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return 0;
}
