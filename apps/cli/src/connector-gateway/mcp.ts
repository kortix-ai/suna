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
 *
 * This module is the JSON-RPC transport only: framing, the request switch and
 * the stdio read loop. The tool records live in mcp-tools.ts, the execution
 * and result envelopes in mcp-run.ts — both re-exported here so the original
 * `./mcp.ts` import path keeps resolving for every existing caller.
 */
import type { ConnectorClient } from './gateway.ts';
import { connectorClient } from './gateway.ts';
import { asRecord, runMetaTool, stringField } from './mcp-run.ts';
import { META_TOOLS } from './mcp-tools.ts';

export { uploadAttachmentFiles } from './attachments.ts';
export { secretLinkToolPayload } from './mcp-run.ts';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

// The MCP server identity is `kortix-connectors`, matching the CLI command tree.
const SERVER_INFO = { name: 'kortix-connectors', version: '0.3.0' };

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
