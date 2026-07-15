/**
 * Agent Tunnel CLI: filesystem, shell, and CUA Driver-backed computer control.
 *
 * Usage: agent-tunnel-cli <command> [args as JSON]
 */

import { readFileSync } from 'fs';
import { TunnelClient, TunnelClientError } from './tunnel-client';

const S6_ENV_DIR = process.env.S6_ENV_DIR || '/run/s6/container_environment';
const FALLBACK_API_URL = 'http://localhost:8008';

const ALL_COMMANDS = [
  'status',
  'fs_read',
  'fs_write',
  'fs_list',
  'shell',
  'cua_ensure',
  'cua_start_daemon',
  'cua_status',
  'cua_version',
  'cua_list_tools',
  'cua_describe',
  'cua_call',
  'cua_list_apps',
  'cua_list_windows',
  'cua_get_window_state',
  'cua_click',
  'cua_type_text',
  'cua_hotkey',
];

function getEnv(key: string): string | undefined {
  try {
    const value = readFileSync(`${S6_ENV_DIR}/${key}`, 'utf-8').trim();
    if (value) return value;
  } catch {}
  return process.env[key];
}

function getApiBase(): string {
  const raw = getEnv('TUNNEL_API_URL') || FALLBACK_API_URL;
  const url = raw.startsWith('http') ? raw : FALLBACK_API_URL;
  return url.replace(/\/+$/, '').replace(/\/v1\/router\/?$/, '');
}

const client = new TunnelClient({
  apiUrl: `${getApiBase()}/v1/tunnel`,
  token: getEnv('TUNNEL_TOKEN') || '',
  tunnelId: getEnv('TUNNEL_ID'),
});

function out(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function fail(message: string): void {
  out({ success: false, error: message });
  process.exitCode = 1;
}

async function rpcSafe(
  method: string,
  params: Record<string, unknown> = {},
): Promise<
  | { result: unknown; permissionRequired: false }
  | { result: null; permissionRequired: true; requestId: string; message: string }
> {
  try {
    const result = await client.rpc(method, params);
    return { result, permissionRequired: false };
  } catch (err) {
    if (err instanceof TunnelClientError && err.isPermissionRequest) {
      return {
        result: null,
        permissionRequired: true,
        requestId: err.requestId || 'unknown',
        message: `Permission required. A permission request (${err.requestId}) has been sent to the user for approval.`,
      };
    }
    throw err;
  }
}

async function call(method: string, params: Record<string, unknown> = {}): Promise<unknown | null> {
  const response = await rpcSafe(method, params);
  if (response.permissionRequired) {
    out({
      success: false,
      permissionRequired: true,
      requestId: response.requestId,
      message: response.message,
    });
    return null;
  }
  return response.result;
}

async function status() {
  const connections = (await client.getConnections()) as Array<Record<string, unknown>>;

  if (connections.length === 0) {
    return out({
      success: true,
      connections: [],
      message: 'No tunnel connections found. The user needs to set up Agent Tunnel first.',
    });
  }

  let hasOnline = false;
  const mapped = connections.map((data) => {
    if (data.isLive) hasOnline = true;
    return {
      name: data.name || 'Unnamed',
      tunnelId: data.tunnelId,
      status: data.isLive ? 'ONLINE' : 'OFFLINE',
      capabilities: (data.capabilities as string[]) || [],
      machineInfo: data.machineInfo || {},
    };
  });

  out({
    success: true,
    connections: mapped,
    hasOnline,
    message: hasOnline
      ? undefined
      : 'No tunnel is currently online. Ask the user to run `npx --yes @kortix/agent-tunnel@latest connect` on their local machine.',
  });
}

async function fsRead(args: Record<string, unknown>) {
  const result = await call('fs.read', {
    path: args.path,
    encoding: (args.encoding as string) || 'utf-8',
  });
  if (result === null) return;
  const data = result as Record<string, unknown>;
  out({ success: true, path: data.path || args.path, size: data.size, content: data.content });
}

async function fsWrite(args: Record<string, unknown>) {
  const result = await call('fs.write', {
    path: args.path,
    content: args.content,
    encoding: (args.encoding as string) || 'utf-8',
  });
  if (result === null) return;
  const data = result as Record<string, unknown>;
  out({ success: true, path: data.path, size: data.size });
}

async function fsList(args: Record<string, unknown>) {
  const result = await call('fs.list', {
    path: args.path,
    recursive: args.recursive || false,
  });
  if (result === null) return;
  const data = result as { entries: unknown[]; count: number };
  out({ success: true, path: args.path, count: data.count, entries: data.entries });
}

async function shell(args: Record<string, unknown>) {
  const result = await call('shell.exec', {
    command: args.command,
    args: (args.args as string[]) || [],
    cwd: args.cwd,
    timeout: args.timeout,
  });
  if (result === null) return;
  const data = result as {
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  };
  out({
    success: data.exitCode === 0,
    exitCode: data.exitCode,
    signal: data.signal,
    stdout: data.stdout,
    stderr: data.stderr,
    stdoutTruncated: data.stdoutTruncated,
    stderrTruncated: data.stderrTruncated,
  });
}

async function cuaRpc(method: string, args: Record<string, unknown> = {}) {
  const result = await call(method, args);
  if (result === null) return;
  out({ success: true, result });
}

async function cuaCall(args: Record<string, unknown>) {
  const tool = args.tool as string;
  if (!tool) return fail('tool is required');

  const result = await call('desktop.cua.call', {
    tool,
    args: (args.args || {}) as Record<string, unknown>,
  });
  if (result === null) return;
  out({ success: true, tool, result });
}

async function cuaDescribe(args: Record<string, unknown>) {
  const tool = args.tool as string;
  if (!tool) return fail('tool is required');
  await cuaRpc('desktop.cua.describe', { tool });
}

const [cmd, rawArgs] = process.argv.slice(2);

if (!cmd) {
  console.error(`Usage: agent-tunnel-cli <command> [args as JSON]\n\nAvailable: ${ALL_COMMANDS.join(' | ')}`);
  process.exit(1);
}

let args: Record<string, unknown> = {};
try {
  args = rawArgs ? JSON.parse(rawArgs) : {};
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

try {
  switch (cmd) {
    case 'status':
      await status();
      break;
    case 'fs_read':
      await fsRead(args);
      break;
    case 'fs_write':
      await fsWrite(args);
      break;
    case 'fs_list':
      await fsList(args);
      break;
    case 'shell':
      await shell(args);
      break;
    case 'cua_ensure':
      await cuaRpc('desktop.cua.ensure');
      break;
    case 'cua_start_daemon':
      await cuaRpc('desktop.cua.start_daemon');
      break;
    case 'cua_status':
      await cuaRpc('desktop.cua.status');
      break;
    case 'cua_version':
      await cuaRpc('desktop.cua.version');
      break;
    case 'cua_list_tools':
      await cuaRpc('desktop.cua.list_tools');
      break;
    case 'cua_describe':
      await cuaDescribe(args);
      break;
    case 'cua_call':
      await cuaCall(args);
      break;
    case 'cua_list_apps':
      await cuaRpc('desktop.cua.list_apps', args);
      break;
    case 'cua_list_windows':
      await cuaRpc('desktop.cua.list_windows', args);
      break;
    case 'cua_get_window_state':
      await cuaRpc('desktop.cua.get_window_state', args);
      break;
    case 'cua_click':
      await cuaRpc('desktop.cua.click', args);
      break;
    case 'cua_type_text':
      await cuaRpc('desktop.cua.type_text', args);
      break;
    case 'cua_hotkey':
      await cuaRpc('desktop.cua.hotkey', args);
      break;
    default:
      console.error(`Unknown command: ${cmd}\n\nAvailable: ${ALL_COMMANDS.join(' | ')}`);
      process.exit(1);
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  out({ success: false, error: message });
  process.exit(1);
}
