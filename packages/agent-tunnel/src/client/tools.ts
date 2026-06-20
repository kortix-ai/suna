import type { TunnelClient } from './tunnel-client';

export interface TunnelToolParameter {
  type: string;
  description: string;
  required?: boolean;
  items?: { type: string };
  enum?: string[];
}

export interface TunnelToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, TunnelToolParameter>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

const tunnelIdParam: TunnelToolParameter = {
  type: 'string',
  description: 'Tunnel connection ID (auto-discovered if omitted)',
  required: false,
};

function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result;
  return JSON.stringify(result, null, 2);
}

export function createTunnelTools(client: TunnelClient): TunnelToolDefinition[] {
  return [
    {
      name: 'tunnel_status',
      description: `Check the status of all Agent Tunnel connections to local computers. Lists every registered machine with live/offline status, capabilities, and machine info.`,
      parameters: {},
      async execute() {
        const connections = (await client.getConnections()) as Array<Record<string, unknown>>;

        if (connections.length === 0) {
          return 'No tunnel connections found. Connect this computer from the Kortix desktop app or run the tunnel connect command on another computer.';
        }

        const sections: string[] = [];
        let hasOnline = false;

        for (const data of connections) {
          const status = data.isLive ? 'ONLINE' : 'OFFLINE';
          if (data.isLive) hasOnline = true;
          const capabilities = (data.capabilities as string[]) || [];
          const machineInfo = (data.machineInfo as Record<string, unknown>) || {};

          const lines = [
            `=== Computer: ${data.name || 'Unnamed'} — ${status} ===`,
            `ID: ${data.tunnelId}`,
            `Capabilities: ${capabilities.length > 0 ? capabilities.join(', ') : '(none registered)'}`,
          ];

          if (Object.keys(machineInfo).length > 0) {
            lines.push(`Machine: ${machineInfo.hostname || 'unknown'} (${machineInfo.platform || '?'} ${machineInfo.arch || '?'})`);
          }

          sections.push(lines.join('\n'));
        }

        if (!hasOnline) {
          sections.push('\nNo tunnel is currently online. Connect this computer from the Kortix desktop app or run the tunnel connect command on the target computer.');
        }

        return sections.join('\n\n');
      },
    },
    {
      name: 'tunnel_fs_read',
      description: `Read a file from a connected computer via Agent Tunnel. Requires filesystem permission.`,
      parameters: {
        tunnel_id: tunnelIdParam,
        path: { type: 'string', description: 'Absolute path to the file on the connected computer', required: true },
        encoding: { type: 'string', description: 'File encoding (default: utf-8)', required: false },
      },
      async execute(args) {
        const result = await client.rpcWithPermissionFlow('fs.read', {
          path: args.path,
          encoding: (args.encoding as string) || 'utf-8',
        });
        if (typeof result === 'string') return result;
        const data = result as Record<string, unknown>;
        return `=== File: ${args.path} (${data.size} bytes) ===\n${data.content}`;
      },
    },
    {
      name: 'tunnel_fs_write',
      description: `Write a file to a connected computer via Agent Tunnel. Creates parent directories if needed. Requires filesystem write permission.`,
      parameters: {
        tunnel_id: tunnelIdParam,
        path: { type: 'string', description: 'Absolute path for the file on the connected computer', required: true },
        content: { type: 'string', description: 'File content to write', required: true },
        encoding: { type: 'string', description: 'File encoding (default: utf-8)', required: false },
      },
      async execute(args) {
        const result = await client.rpcWithPermissionFlow('fs.write', {
          path: args.path,
          content: args.content,
          encoding: (args.encoding as string) || 'utf-8',
        });
        if (typeof result === 'string') return result;
        const data = result as Record<string, unknown>;
        return `File written: ${data.path} (${data.size} bytes)`;
      },
    },
    {
      name: 'tunnel_fs_list',
      description: `List directory contents on a connected computer via Agent Tunnel. Requires filesystem permission.`,
      parameters: {
        tunnel_id: tunnelIdParam,
        path: { type: 'string', description: 'Absolute path to the directory on the connected computer', required: true },
        recursive: { type: 'boolean', description: 'Include subdirectory contents (default: false)', required: false },
      },
      async execute(args) {
        const result = await client.rpcWithPermissionFlow('fs.list', {
          path: args.path,
          recursive: args.recursive || false,
        });
        if (typeof result === 'string') return result;

        const data = result as { entries: Array<{ name: string; path: string; isDirectory: boolean; isFile: boolean }>; count: number };
        if (data.entries.length === 0) return `Directory is empty: ${args.path}`;

        const lines = [`=== Directory: ${args.path} (${data.count} entries) ===`];
        for (const entry of data.entries) {
          const type = entry.isDirectory ? '[DIR]' : '[FILE]';
          lines.push(`  ${type} ${entry.name}`);
        }
        return lines.join('\n');
      },
    },
    {
      name: 'tunnel_shell_exec',
      description: `Execute a command on a connected computer via Agent Tunnel. Commands are executed without shell interpolation (array args) for security. Requires shell permission.`,
      parameters: {
        tunnel_id: tunnelIdParam,
        command: { type: 'string', description: "Command executable name (e.g. 'ls', 'git', 'python')", required: true },
        args: { type: 'array', description: 'Command arguments as separate strings (no shell interpolation)', required: false, items: { type: 'string' } },
        cwd: { type: 'string', description: 'Working directory for the command', required: false },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000, max: 120000)', required: false },
      },
      async execute(args) {
        const result = await client.rpcWithPermissionFlow('shell.exec', {
          command: args.command,
          args: (args.args as string[]) || [],
          cwd: args.cwd,
          timeout: args.timeout,
        });
        if (typeof result === 'string') return result;

        const data = result as {
          exitCode: number | null;
          signal: string | null;
          stdout: string;
          stderr: string;
          stdoutTruncated: boolean;
          stderrTruncated: boolean;
        };

        const lines = [`=== Command: ${args.command} ${((args.args as string[]) || []).join(' ')} ===`];
        lines.push(`Exit code: ${data.exitCode ?? 'N/A'}${data.signal ? ` (signal: ${data.signal})` : ''}`);
        if (data.stdout) {
          lines.push(`\n--- stdout${data.stdoutTruncated ? ' (truncated)' : ''} ---`);
          lines.push(data.stdout);
        }
        if (data.stderr) {
          lines.push(`\n--- stderr${data.stderrTruncated ? ' (truncated)' : ''} ---`);
          lines.push(data.stderr);
        }
        return lines.join('\n');
      },
    },
    {
      name: 'tunnel_cua_ensure',
      description: `Ensure CUA Driver is installed on the connected computer and return its local binary path/version. Requires desktop computer_use permission.`,
      parameters: {
        tunnel_id: tunnelIdParam,
      },
      async execute() {
        return stringifyResult(await client.rpcWithPermissionFlow('desktop.cua.ensure', {}));
      },
    },
    {
      name: 'tunnel_cua_start_daemon',
      description: `Start the CUA Driver daemon/background service on the connected computer so CUA sessions and element indices remain stable.`,
      parameters: {
        tunnel_id: tunnelIdParam,
      },
      async execute() {
        return stringifyResult(await client.rpcWithPermissionFlow('desktop.cua.start_daemon', {}));
      },
    },
    {
      name: 'tunnel_cua_status',
      description: `Read CUA Driver daemon status from the connected computer.`,
      parameters: {
        tunnel_id: tunnelIdParam,
      },
      async execute() {
        return stringifyResult(await client.rpcWithPermissionFlow('desktop.cua.status', {}));
      },
    },
    {
      name: 'tunnel_cua_version',
      description: `Read the installed CUA Driver version on the connected computer.`,
      parameters: {
        tunnel_id: tunnelIdParam,
      },
      async execute() {
        return stringifyResult(await client.rpcWithPermissionFlow('desktop.cua.version', {}));
      },
    },
    {
      name: 'tunnel_cua_list_tools',
      description: `List every CUA Driver tool exposed by the connected computer's installed driver.`,
      parameters: {
        tunnel_id: tunnelIdParam,
      },
      async execute() {
        return stringifyResult(await client.rpcWithPermissionFlow('desktop.cua.list_tools', {}));
      },
    },
    {
      name: 'tunnel_cua_describe',
      description: `Describe one CUA Driver tool before calling it.`,
      parameters: {
        tunnel_id: tunnelIdParam,
        tool: { type: 'string', description: 'CUA Driver tool name', required: true },
      },
      async execute(args) {
        return stringifyResult(await client.rpcWithPermissionFlow('desktop.cua.describe', {
          tool: args.tool,
        }));
      },
    },
    {
      name: 'tunnel_cua_list_apps',
      description: `List installed and running desktop apps through CUA Driver, including bundle IDs and PIDs.`,
      parameters: {
        tunnel_id: tunnelIdParam,
      },
      async execute() {
        return stringifyResult(await client.rpcWithPermissionFlow('desktop.cua.list_apps', {}));
      },
    },
    {
      name: 'tunnel_cua_list_windows',
      description: `List top-level local desktop windows through CUA Driver. Use this before tunnel_cua_get_window_state.`,
      parameters: {
        tunnel_id: tunnelIdParam,
        pid: { type: 'number', description: 'Optional process ID filter', required: false },
        on_screen_only: { type: 'boolean', description: 'Only include windows on the current Space', required: false },
      },
      async execute(args) {
        return stringifyResult(await client.rpcWithPermissionFlow('desktop.cua.list_windows', {
          pid: args.pid,
          on_screen_only: args.on_screen_only,
        }));
      },
    },
    {
      name: 'tunnel_cua_get_window_state',
      description: `Get a CUA window snapshot: screenshot plus accessibility tree markdown with element_index values. Call this once per turn before element-indexed actions.`,
      parameters: {
        tunnel_id: tunnelIdParam,
        pid: { type: 'number', description: 'Target process ID', required: true },
        window_id: { type: 'number', description: 'Target window ID from tunnel_cua_list_windows', required: true },
        query: { type: 'string', description: 'Optional filter for tree markdown', required: false },
        capture_mode: { type: 'string', description: 'som, vision, or ax', required: false, enum: ['som', 'vision', 'ax'] },
      },
      async execute(args) {
        return stringifyResult(await client.rpcWithPermissionFlow('desktop.cua.get_window_state', {
          pid: args.pid,
          window_id: args.window_id,
          query: args.query,
          capture_mode: args.capture_mode,
        }));
      },
    },
    {
      name: 'tunnel_cua_click',
      description: `Click with CUA Driver by element_index from the last window state, or by window-local screenshot coordinates.`,
      parameters: {
        tunnel_id: tunnelIdParam,
        pid: { type: 'number', description: 'Target process ID', required: true },
        window_id: { type: 'number', description: 'Target window ID; required for element_index', required: false },
        element_index: { type: 'number', description: 'Element index from tunnel_cua_get_window_state', required: false },
        x: { type: 'number', description: 'Window-local screenshot X coordinate', required: false },
        y: { type: 'number', description: 'Window-local screenshot Y coordinate', required: false },
        action: { type: 'string', description: 'AX action: press, show_menu, pick, confirm, cancel, open', required: false },
      },
      async execute(args) {
        return stringifyResult(await client.rpcWithPermissionFlow('desktop.cua.click', args));
      },
    },
    {
      name: 'tunnel_cua_type_text',
      description: `Type text with CUA Driver into a target PID, optionally directed to an element_index from the last window state.`,
      parameters: {
        tunnel_id: tunnelIdParam,
        pid: { type: 'number', description: 'Target process ID', required: true },
        text: { type: 'string', description: 'Text to type', required: true },
        window_id: { type: 'number', description: 'Target window ID; required for element_index', required: false },
        element_index: { type: 'number', description: 'Element index from tunnel_cua_get_window_state', required: false },
      },
      async execute(args) {
        return stringifyResult(await client.rpcWithPermissionFlow('desktop.cua.type_text', args));
      },
    },
    {
      name: 'tunnel_cua_hotkey',
      description: `Press a CUA Driver hotkey against a target PID, for example ["cmd","c"].`,
      parameters: {
        tunnel_id: tunnelIdParam,
        pid: { type: 'number', description: 'Target process ID', required: true },
        keys: { type: 'array', description: 'Modifier(s) and one key, e.g. ["cmd","c"]', required: true, items: { type: 'string' } },
        window_id: { type: 'number', description: 'Optional target window ID for native menu dispatch', required: false },
      },
      async execute(args) {
        return stringifyResult(await client.rpcWithPermissionFlow('desktop.cua.hotkey', args));
      },
    },
    {
      name: 'tunnel_cua_call',
      description: `Call any CUA Driver tool by name with raw JSON args. Prefer the specific tunnel_cua_* tools when available.`,
      parameters: {
        tunnel_id: tunnelIdParam,
        tool: { type: 'string', description: 'CUA Driver tool name', required: true },
        args: { type: 'object', description: 'Raw CUA Driver tool arguments', required: false },
      },
      async execute(args) {
        return stringifyResult(await client.rpcWithPermissionFlow('desktop.cua.call', {
          tool: args.tool,
          args: args.args || {},
        }));
      },
    },
  ];
}
