#!/usr/bin/env bun
/**
 * executor-mcp — stdio MCP facade over the Kortix Executor Gateway.
 *
 * The sandbox still only receives KORTIX_EXECUTOR_TOKEN + KORTIX_API_URL. This
 * process lists every usable Executor action as an MCP tool and forwards calls
 * to /v1/executor/call, so MCP clients get the same policy, sharing, credential
 * resolution, and audit path as the CLI and TS SDK.
 */
import {
  createExecutorClient,
  type ExecutorClient,
  type ExecutorToolMatch,
} from '../../../../packages/executor-sdk/src/index';
import { getEnv, requireEnv } from '../lib';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

function apiBase(): string {
  const url = getEnv('KORTIX_API_URL')?.trim();
  if (!url) throw new Error('KORTIX_API_URL not set');
  return url.replace(/\/+$/, '');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

function mcpToolName(tool: ExecutorToolMatch): string {
  return `${tool.connector}__${tool.action.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

function content(data: unknown) {
  return [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }];
}

function inputSchema(tool: ExecutorToolMatch): Record<string, unknown> {
  return tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema)
    ? tool.inputSchema as Record<string, unknown>
    : { type: 'object', properties: {} };
}

async function findToolByMcpName(executor: ExecutorClient, name: string): Promise<ExecutorToolMatch | null> {
  return (await executor.tools()).find((tool) => mcpToolName(tool) === name) ?? null;
}

async function handle(req: JsonRpcRequest, executor: ExecutorClient) {
  switch (req.method) {
    case 'initialize':
      return {
        protocolVersion: asRecord(req.params).protocolVersion ?? '2025-06-18',
        serverInfo: { name: 'kortix-executor', version: '0.1.0' },
        capabilities: { tools: {} },
      };

    case 'tools/list': {
      return {
        tools: (await executor.tools()).map((tool) => ({
          name: mcpToolName(tool),
          title: tool.tool,
          description: tool.description || tool.tool,
          inputSchema: inputSchema(tool),
          annotations: {
            readOnlyHint: tool.risk === 'read',
            destructiveHint: tool.risk === 'destructive',
          },
        })),
      };
    }

    case 'tools/call': {
      const params = asRecord(req.params);
      const name = stringField(params, 'name');
      const args = asRecord(params.arguments);
      const tool = await findToolByMcpName(executor, name);
      if (tool) {
        const result = await executor.call(tool.connector, tool.action, args);
        return { content: content(result), isError: !result.ok };
      }
      return { content: content({ ok: false, error: `unknown tool ${name}` }), isError: true };
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
