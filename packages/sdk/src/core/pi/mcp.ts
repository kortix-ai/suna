/** A local MCP process runs in the session's execution environment. */
export interface PiStdioMcpServer {
  type: 'local';
  command: string[];
  environment?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
  /** Request timeout in milliseconds, from 1 to 60000. Defaults to 30000. */
  timeout?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maximum &&
    !value.includes('\0')
  );
}

export function validateStdioMcpServers(
  value: unknown,
): asserts value is Record<string, PiStdioMcpServer> {
  if (!record(value) || Object.keys(value).length > 16)
    throw new Error('MCP configuration must contain at most 16 named servers');
  for (const [name, server] of Object.entries(value)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name) || !record(server))
      throw new Error('MCP server name or configuration is invalid');
    if (
      Object.keys(server).some(
        (key) =>
          ![
            'type',
            'command',
            'environment',
            'cwd',
            'enabled',
            'timeout',
          ].includes(key),
      )
    )
      throw new Error(`MCP server ${name} has an unsupported setting`);
    if (server.type !== 'local')
      throw new Error(
        `MCP server ${name} must use type local; remote servers use project connectors`,
      );
    if (
      !Array.isArray(server.command) ||
      server.command.length === 0 ||
      server.command.length > 64 ||
      !server.command.every((arg) => text(arg, 8192)) ||
      !server.command[0]?.trim()
    )
      throw new Error(`MCP server ${name} requires a command array`);
    if (
      server.cwd !== undefined &&
      (!text(server.cwd, 4096) || !server.cwd.trim())
    )
      throw new Error(`MCP server ${name} cwd is invalid`);
    if (server.enabled !== undefined && typeof server.enabled !== 'boolean')
      throw new Error(`MCP server ${name} enabled must be boolean`);
    if (
      server.timeout !== undefined &&
      (!Number.isSafeInteger(server.timeout) ||
        Number(server.timeout) < 1 ||
        Number(server.timeout) > 60000)
    )
      throw new Error(
        `MCP server ${name} timeout must be from 1 to 60000 milliseconds`,
      );
    if (
      server.environment !== undefined &&
      (!record(server.environment) ||
        Object.keys(server.environment).length > 64 ||
        Object.entries(server.environment).some(
          ([key, value]) =>
            !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || !text(value, 8192),
        ))
    )
      throw new Error(`MCP server ${name} environment is invalid`);
    if (new TextEncoder().encode(JSON.stringify(server)).length > 32768)
      throw new Error(`MCP server ${name} configuration exceeds 32 KiB`);
  }
}
