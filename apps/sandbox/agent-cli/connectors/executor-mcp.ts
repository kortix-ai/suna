#!/usr/bin/env bun
/**
 * executor-mcp — the agent's PRIMARY interface to every configured integration,
 * exposed as a stdio MCP server. OpenCode auto-loads it in every session (the
 * daemon registers it via OPENCODE_CONFIG_CONTENT), so the agent reaches
 * Pipedream / MCP / OpenAPI / GraphQL / HTTP connectors as native MCP tools.
 *
 * Modeled on RhysSullivan/executor: instead of exploding every connector action
 * into tools/list (which floods the agent's context once a catalog has hundreds
 * of actions), we expose a small, stable set of META-TOOLS and let the agent
 * progressively discover what it needs:
 *
 *   connectors  — what this session can use (provider, status, tool count)
 *   discover    — intent search across every usable tool
 *   describe    — one tool's full input schema + risk
 *   call        — run a tool (gateway resolves the credential server-side)
 *
 * Thin client: it never holds a third-party credential. Every call goes to the
 * Kortix Executor Gateway (/v1/executor/*), which checks this user's connector
 * sharing, resolves the secret SERVER-SIDE, runs the call, and audits it. The
 * sandbox only carries KORTIX_EXECUTOR_TOKEN + KORTIX_API_URL (injected at
 * sandbox spawn).
 */
import {
  createExecutorClient,
  type ExecutorClient,
} from '../../../../packages/executor-sdk/src/index';
import { getEnv, requireEnv } from '../lib';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

const SERVER_INFO = { name: 'kortix-executor', version: '0.2.0' };

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
] as const;

function apiBase(): string {
  const url = getEnv('KORTIX_API_URL')?.trim();
  if (!url) throw new Error('KORTIX_API_URL not set');
  return url.replace(/\/+$/, '');
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

export async function main() {
  const executor = createExecutorClient({ apiUrl: apiBase(), token: requireEnv('KORTIX_EXECUTOR_TOKEN') });
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
}

if (import.meta.main) {
  main().catch((err) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) })}\n`);
    process.exit(1);
  });
}
