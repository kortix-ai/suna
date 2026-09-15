import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ReadResourceResultSchema,
  ListPromptsResultSchema,
  GetPromptResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  validateStdioMcpServers,
  type PiStdioMcpServer,
} from '../../../packages/sdk/src/core/pi/mcp';
import { EnvironmentStdioTransport } from './stdio-mcp-transport';

const schemas = {
  'tools/list': ListToolsResultSchema,
  'tools/call': CallToolResultSchema,
  'resources/list': ListResourcesResultSchema,
  'resources/templates/list': ListResourceTemplatesResultSchema,
  'resources/read': ReadResourceResultSchema,
  'prompts/list': ListPromptsResultSchema,
  'prompts/get': GetPromptResultSchema,
};
export type StdioMcpMethod = keyof typeof schemas;
export interface StdioMcpRequest {
  server: string;
  configuration: PiStdioMcpServer;
  method: StdioMcpMethod;
  params?: Record<string, unknown>;
  connectionId?: string;
}
export class StdioMcpError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
interface Connection {
  id: string;
  hash: string;
  client: Client;
  transport: EnvironmentStdioTransport;
  busy: boolean;
  ready: boolean;
  closing?: Promise<void>;
  idle?: ReturnType<typeof setTimeout>;
}
export class StdioMcpPool {
  private connections = new Map<string, Connection>();
  private exit = () => {
    for (const value of this.connections.values()) value.transport.kill();
  };
  constructor(
    private options: {
      cwd: string;
      environment?: () => NodeJS.ProcessEnv;
      idleTimeoutMs?: number;
      historyLock?: string;
    },
  ) {}
  get active(): number {
    return this.connections.size;
  }
  private async remove(server: string, connection: Connection): Promise<void> {
    if (connection.closing) return connection.closing;
    if (connection.idle) clearTimeout(connection.idle);
    connection.closing = (async () => {
      await connection.client.close();
      if (this.connections.get(server) === connection)
        this.connections.delete(server);
      if (!this.connections.size) process.removeListener('exit', this.exit);
    })();
    return connection.closing;
  }
  async disconnect(server: string, connectionId: string): Promise<void> {
    const connection = this.connections.get(server);
    if (!connection || connection.id !== connectionId)
      throw new StdioMcpError(
        'connection_lost',
        'MCP connection changed or expired; discover the server again',
      );
    if (connection.busy)
      throw new StdioMcpError('busy', 'MCP server has an active request');
    await this.remove(server, connection);
  }
  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.connections].map(([server, connection]) =>
        this.remove(server, connection),
      ),
    );
  }
  async request(
    input: StdioMcpRequest,
    signal?: AbortSignal,
  ): Promise<{ connectionId: string; result: any }> {
    signal?.throwIfAborted();
    try {
      validateStdioMcpServers({ [input.server]: input.configuration });
    } catch (error) {
      throw new StdioMcpError(
        'configuration',
        error instanceof Error ? error.message : 'Invalid MCP configuration',
      );
    }
    const configuration = input.configuration;
    if (configuration.enabled === false)
      throw new StdioMcpError('disabled', 'MCP server is disabled');
    if (!Object.hasOwn(schemas, input.method))
      throw new StdioMcpError('invalid', 'Unsupported MCP method');
    if (
      input.params !== undefined &&
      (!input.params ||
        typeof input.params !== 'object' ||
        Array.isArray(input.params))
    )
      throw new StdioMcpError('invalid', 'MCP params must be an object');
    const discovery = [
      'tools/list',
      'resources/list',
      'resources/templates/list',
      'prompts/list',
    ].includes(input.method);
    if (!discovery && !input.connectionId)
      throw new StdioMcpError(
        'connection_lost',
        'Discover the MCP server before calling it',
      );
    const source = this.options.environment?.() ?? process.env;
    const env = getDefaultEnvironment();
    for (const [key, value] of Object.entries(
      configuration.environment ?? {},
    )) {
      const reference = /^\{env:([a-zA-Z_][a-zA-Z0-9_]*)\}$/.exec(value);
      if (reference && source[reference[1]!] === undefined)
        throw new StdioMcpError(
          'configuration',
          `MCP environment variable ${reference[1]} is unavailable`,
        );
      env[key] = reference ? source[reference[1]!]! : value;
    }
    const cwd = path.resolve(this.options.cwd, configuration.cwd ?? '.');
    const hash = createHash('sha256')
      .update(JSON.stringify({ command: configuration.command, cwd, env }))
      .digest('hex');
    let connection = this.connections.get(input.server);
    if (
      input.connectionId &&
      (!connection ||
        connection.id !== input.connectionId ||
        connection.hash !== hash ||
        connection.closing)
    )
      throw new StdioMcpError(
        'connection_lost',
        'MCP connection changed or expired; discover the server again',
      );
    if (connection?.busy || connection?.closing)
      throw new StdioMcpError('busy', 'MCP server has an active request');
    if (connection && connection.hash !== hash) {
      await this.remove(input.server, connection);
      connection = undefined;
    }
    if (!connection) {
      if (this.connections.size >= 16)
        throw new StdioMcpError(
          'capacity',
          'At most 16 MCP server processes can run per environment',
        );
      const transport = new EnvironmentStdioTransport({
        command: configuration.command,
        cwd,
        env,
        historyLock: this.options.historyLock,
      });
      const client = new Client(
        { name: 'kortix-environment', version: '1' },
        { capabilities: {} },
      );
      connection = {
        id: randomUUID(),
        hash,
        client,
        transport,
        busy: false,
        ready: false,
      };
      const owned = connection;
      client.onclose = () => {
        if (!owned.closing)
          void this.remove(input.server, owned).catch(() => {});
      };
      if (!this.connections.size) process.once('exit', this.exit);
      this.connections.set(input.server, connection);
    }
    const owned = connection;
    owned.busy = true;
    if (owned.idle) clearTimeout(owned.idle);
    const controller = new AbortController();
    const joined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    const timer = setTimeout(
      () =>
        controller.abort(
          new StdioMcpError(
            'timeout',
            'MCP request timed out; its process was stopped',
          ),
        ),
      configuration.timeout ?? 30000,
    );
    const onAbort = () => {
      owned.transport.kill();
    };
    joined.addEventListener('abort', onAbort, { once: true });
    try {
      joined.throwIfAborted();
      if (!owned.ready) {
        await owned.client.connect(owned.transport, {
          signal: joined,
          timeout: configuration.timeout ?? 30000,
        });
        owned.ready = true;
      }
      joined.throwIfAborted();
      const result = await owned.client.request(
        { method: input.method, params: input.params ?? {} },
        schemas[input.method] as any,
        { signal: joined, timeout: configuration.timeout ?? 30000 },
      );
      joined.throwIfAborted();
      return { connectionId: owned.id, result };
    } catch (error) {
      await this.remove(input.server, owned);
      if (joined.aborted) throw joined.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      joined.removeEventListener('abort', onAbort);
      owned.busy = false;
      if (this.connections.get(input.server) === owned && !owned.closing) {
        owned.idle = setTimeout(() => {
          void this.remove(input.server, owned).catch(() => {});
        }, this.options.idleTimeoutMs ?? 60000);
        owned.idle.unref?.();
      }
    }
  }
}
