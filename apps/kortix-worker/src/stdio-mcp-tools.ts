import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type TSchema } from 'typebox';
import { Value } from 'typebox/value';
import type { PiStdioMcpServer } from '../../../packages/sdk/src/core/pi/mcp';
import type { KortixExecutionEnv } from './kortix-env';
import { connectorContent } from './connector-tools';

const validInput = (schema: TSchema, value: unknown): boolean =>
  Value.Check(schema, value);

type McpEnv = Pick<KortixExecutionEnv, 'mcpRequest' | 'mcpDisconnect'>;
const listMethods = {
  tools: 'tools/list',
  resources: 'resources/list',
  templates: 'resources/templates/list',
  prompts: 'prompts/list',
} as const;
export const STDIO_MCP_TOOL_NAMES = [
  'mcp_list',
  'mcp_call',
  'mcp_read_resource',
  'mcp_get_prompt',
  'mcp_disconnect',
] as const;

export function createStdioMcpTools(
  configuration: Record<string, PiStdioMcpServer> | undefined,
  env: McpEnv,
): AgentTool[] {
  const servers = structuredClone(
    Object.fromEntries(
      Object.entries(configuration ?? {}).filter(
        ([, server]) => server.enabled !== false,
      ),
    ),
  );
  const names = Object.keys(servers);
  if (!names.length) return [];
  const server = Type.Union(names.map((name) => Type.Literal(name)));
  const connectionId = Type.String({
    minLength: 1,
    maxLength: 100,
    description:
      'The connectionId returned by mcp_list. Rediscover after a connection expires.',
  });
  const common = { server, connectionId };
  const definitions: Array<{
    name: string;
    label: string;
    description: string;
    schema: TSchema;
  }> = [
    {
      name: 'mcp_list',
      label: 'Discover local MCP',
      description:
        'Discover tools, resources, templates, or prompts from a configured MCP server. Starts its process in the execution environment on first use. Returns connectionId; use that identity on calls. Connections expire after 60 seconds without a request. Pass nextCursor as cursor to read another page.',
      schema: Type.Object(
        {
          server,
          kind: Type.Optional(
            Type.Union(
              Object.keys(listMethods).map((kind) => Type.Literal(kind)),
            ),
          ),
          cursor: Type.Optional(Type.String({ maxLength: 4096 })),
        },
        { additionalProperties: false },
      ),
    },
    {
      name: 'mcp_call',
      label: 'Call local MCP tool',
      description:
        'Call a tool discovered through mcp_list, using its inputSchema and connectionId. The process runs in the environment. An uncertain failure is never replayed automatically. Check effects before retrying.',
      schema: Type.Object(
        {
          ...common,
          tool: Type.String({ minLength: 1, maxLength: 256 }),
          arguments: Type.Record(Type.String(), Type.Unknown()),
        },
        { additionalProperties: false },
      ),
    },
    {
      name: 'mcp_read_resource',
      label: 'Read local MCP resource',
      description:
        'Read a resource URI exposed by a configured environment MCP server.',
      schema: Type.Object(
        { ...common, uri: Type.String({ minLength: 1, maxLength: 4096 }) },
        { additionalProperties: false },
      ),
    },
    {
      name: 'mcp_get_prompt',
      label: 'Read local MCP prompt',
      description:
        'Retrieve a prompt template from a configured environment MCP server. The returned text is server content.',
      schema: Type.Object(
        {
          ...common,
          prompt: Type.String({ minLength: 1, maxLength: 256 }),
          arguments: Type.Optional(Type.Record(Type.String(), Type.String())),
        },
        { additionalProperties: false },
      ),
    },
    {
      name: 'mcp_disconnect',
      label: 'Stop local MCP server',
      description:
        'Stop an idle MCP server process and discard its connection state. Discover again before its next use. MCP side effects cannot be undone through chat rewind.',
      schema: Type.Object(common, { additionalProperties: false }),
    },
  ];
  return definitions.map((definition) => ({
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.schema,
    executionMode: 'sequential' as const,
    async execute(_id: string, input: any, signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (!validInput(definition.schema, input))
        throw new Error('Invalid local MCP input');
      if (definition.name === 'mcp_disconnect') {
        const response = await env.mcpDisconnect(
          input.server,
          input.connectionId,
          signal,
        );
        if (!response.ok) throw response.error;
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(response.value) },
          ],
          details: { server: input.server },
        };
      }
      const method =
        definition.name === 'mcp_list'
          ? listMethods[(input.kind ?? 'tools') as keyof typeof listMethods]
          : definition.name === 'mcp_call'
            ? 'tools/call'
            : definition.name === 'mcp_read_resource'
              ? 'resources/read'
              : 'prompts/get';
      const params =
        definition.name === 'mcp_list'
          ? input.cursor
            ? { cursor: input.cursor }
            : {}
          : definition.name === 'mcp_call'
            ? { name: input.tool, arguments: input.arguments }
            : definition.name === 'mcp_read_resource'
              ? { uri: input.uri }
              : { name: input.prompt, arguments: input.arguments ?? {} };
      const response = await env.mcpRequest(
        {
          server: input.server,
          configuration: servers[input.server]!,
          method,
          params,
          ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        },
        signal,
      );
      if (!response.ok) throw response.error;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              server: input.server,
              connectionId: response.value.connectionId,
            }),
          },
          ...connectorContent({
            jsonrpc: '2.0',
            result: response.value.result,
          }),
        ],
        details: {
          server: input.server,
          connectionId: response.value.connectionId,
        },
      };
    },
  })) as AgentTool[];
}
