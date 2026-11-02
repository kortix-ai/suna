/**
 * The in-process MCP server that hands pi's tools to Claude Code. Claude Code's own tools are
 * off (`options.ts`), so these are the only tools it can call. A call never runs here: the
 * handler waits until pi ran it (`pending.ts`).
 */
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type { Tool } from '@earendil-works/pi-ai'
import { PREFIX, SERVER, description, original, short } from './names'
import type { PendingTools } from './pending'

/** A tool's JSON schema without typebox's symbol keys, always an object schema (MCP requires one). */
function inputSchema(tool: Tool): { type: 'object'; [key: string]: unknown } {
  const schema = JSON.parse(JSON.stringify(tool.parameters ?? {})) as Record<string, unknown>
  return { ...schema, type: 'object' }
}

export async function createToolServer(tools: readonly Tool[], pending: PendingTools): Promise<McpSdkServerConfigWithInstance> {
  // Loaded on first use: a box that never runs Claude never loads the MCP SDK.
  const [{ Server }, { CallToolRequestSchema, ListToolsRequestSchema }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/index.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ])
  const server = new Server({ name: SERVER, version: '1.0.0' }, { capabilities: { tools: {} } })
  const definitions = tools.map((tool) => ({
    name: short(tool.name),
    description: description(tool.description ?? ''),
    inputSchema: inputSchema(tool),
    // Claude runs a non-read-only tool alone, so each handler takes the id of the PreToolUse before it.
    annotations: { readOnlyHint: false },
    // Every tool loads up front (tool search is off), and pi truncates results itself.
    _meta: { 'anthropic/alwaysLoad': true, 'anthropic/maxResultSizeChars': 500_000 },
  }))
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = PREFIX + request.params.name
    if (!original(name, tools)) throw new Error(`Claude called a tool Kortix did not offer: ${name}`)
    return pending.call(name)
  })
  // The SDK's public type names its high-level McpServer; it connects any MCP server instance.
  return { type: 'sdk', name: SERVER, instance: server as unknown as McpSdkServerConfigWithInstance['instance'] }
}
