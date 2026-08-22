/** Versioned wire contract for the outbound kortixd compute-node channel. */
export const NODE_CHANNEL_VERSION = 1 as const;
export const NODE_CHANNEL_MAX_FRAME_BYTES = 256 * 1024;
export const NODE_CHANNEL_MAX_WINDOW_BYTES = 4 * 1024 * 1024;
export const NODE_CHANNEL_MAX_SOCKET_MESSAGE_BYTES = 16 * 1024 * 1024;

type HeaderList = Array<[string, string]>;

interface FrameBase {
  v: typeof NODE_CHANNEL_VERSION;
  stream_id: string;
  seq: number;
}

export interface NodeAssignmentSpec {
  assignment_id: string;
  session_id: string;
  project_id: string;
  lease_epoch: number;
  lease_expires_at: string;
  workload: 'session';
  harness: 'opencode';
  repository: { url: string; branch: string; base_ref: string };
  secrets_revision: string;
  ports: number[];
  writable_roots: string[];
  env: Record<string, string>;
}

export type NodeChannelFrame =
  | (FrameBase & {
      type: 'node.heartbeat';
      version: string;
      capabilities: string[];
      platform: string;
      arch: string;
      sent_at: string;
    })
  | (FrameBase & {
      type: 'stream.open';
      port: number;
      method: string;
      path: string;
      headers: HeaderList;
      window: number;
    })
  | (FrameBase & { type: 'stream.request'; data: string })
  | (FrameBase & { type: 'stream.request.end' })
  | (FrameBase & {
      type: 'stream.response';
      status: number;
      headers: HeaderList;
      window: number;
    })
  | (FrameBase & { type: 'stream.response.data'; data: string })
  | (FrameBase & { type: 'stream.response.end' })
  | (FrameBase & { type: 'stream.cancel'; reason: string })
  | (FrameBase & { type: 'stream.window'; credit: number })
  | (FrameBase & {
      type: 'socket.open';
      port: number;
      path: string;
      headers: HeaderList;
    })
  | (FrameBase & { type: 'socket.opened' })
  | (FrameBase & { type: 'socket.data'; data: string; binary: boolean; fin: boolean })
  | (FrameBase & { type: 'socket.close'; code: number; reason: string })
  | (FrameBase & { type: 'rpc.request'; method: string; params: Record<string, unknown> })
  | (FrameBase & { type: 'rpc.result'; result: unknown })
  | (FrameBase & { type: 'rpc.error'; code: number; message: string })
  | (FrameBase & { type: 'assignment.apply'; assignment: NodeAssignmentSpec })
  | (FrameBase & { type: 'assignment.accept'; status: 'starting' | 'ready' })
  | (FrameBase & { type: 'assignment.reject'; reason: string })
  | (FrameBase & { type: 'assignment.ready'; native_conversation_id?: string; ports: number[] })
  | (FrameBase & { type: 'assignment.stop'; reason: 'stop' | 'restart' | 'release' | 'drain' })
  | (FrameBase & { type: 'assignment.stopped'; reason: string });

const STREAM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const TYPES = new Set([
  'node.heartbeat',
  'stream.open',
  'stream.request',
  'stream.request.end',
  'stream.response',
  'stream.response.data',
  'stream.response.end',
  'stream.cancel',
  'stream.window',
  'socket.open',
  'socket.opened',
  'socket.data',
  'socket.close',
  'rpc.request',
  'rpc.result',
  'rpc.error',
  'assignment.apply',
  'assignment.accept',
  'assignment.reject',
  'assignment.ready',
  'assignment.stop',
  'assignment.stopped',
]);

function invalid(message: string): never {
  throw new Error(`Invalid node channel frame: ${message}`);
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    invalid(name);
  }
  return value as number;
}

function headers(value: unknown): HeaderList {
  if (!Array.isArray(value) || value.length > 128) invalid('headers');
  return value.map((entry) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      !TOKEN.test(entry[0]) ||
      typeof entry[1] !== 'string' ||
      /[\r\n]/.test(entry[1])
    ) {
      invalid('header');
    }
    return [entry[0].toLowerCase(), entry[1]];
  });
}

function data(value: unknown): string {
  if (typeof value !== 'string' || !BASE64.test(value)) invalid('data');
  return value;
}

function assignment(value: unknown): NodeAssignmentSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('assignment');
  const item = value as Record<string, unknown>;
  for (const key of ['assignment_id', 'session_id', 'project_id']) {
    if (typeof item[key] !== 'string' || !STREAM_ID.test(item[key] as string)) invalid(`assignment.${key}`);
  }
  integer(item.lease_epoch, 'assignment.lease_epoch', 1, Number.MAX_SAFE_INTEGER);
  if (typeof item.lease_expires_at !== 'string' || Number.isNaN(Date.parse(item.lease_expires_at))) invalid('assignment.lease_expires_at');
  if (item.workload !== 'session' || item.harness !== 'opencode') invalid('assignment.workload');
  if (!item.repository || typeof item.repository !== 'object' || Array.isArray(item.repository)) invalid('assignment.repository');
  const repository = item.repository as Record<string, unknown>;
  if (typeof repository.url !== 'string' || repository.url.length > 4096 || !/^https?:\/\//.test(repository.url)) invalid('assignment.repository.url');
  for (const key of ['branch', 'base_ref']) if (typeof repository[key] !== 'string' || !(repository[key] as string).trim() || (repository[key] as string).length > 512) invalid(`assignment.repository.${key}`);
  if (typeof item.secrets_revision !== 'string' || item.secrets_revision.length > 256) invalid('assignment.secrets_revision');
  if (!Array.isArray(item.ports) || item.ports.length > 32) invalid('assignment.ports');
  item.ports = item.ports.map((port) => integer(port, 'assignment.port', 1, 65_535));
  if (!Array.isArray(item.writable_roots) || item.writable_roots.length > 32 || !item.writable_roots.every((root) => typeof root === 'string' && root.startsWith('/') && root.length <= 4096)) invalid('assignment.writable_roots');
  if (!item.env || typeof item.env !== 'object' || Array.isArray(item.env)) invalid('assignment.env');
  const entries = Object.entries(item.env as Record<string, unknown>);
  if (entries.length > 128 || entries.some(([key, entry]) => !/^[A-Z_][A-Z0-9_]{0,127}$/.test(key) || typeof entry !== 'string' || entry.length > 131_072)) invalid('assignment.env');
  if (entries.reduce((total, [key, entry]) => total + key.length + (entry as string).length, 0) > 512 * 1024) invalid('assignment.env');
  for (const forbidden of ['KORTIX_NODE_TOKEN', 'KORTIX_SANDBOX_TOKEN', 'KORTIX_TOKEN']) if (forbidden in (item.env as object)) invalid(`assignment.env.${forbidden}`);
  return item as unknown as NodeAssignmentSpec;
}

export function parseNodeChannelFrame(raw: string): NodeChannelFrame {
  if (Buffer.byteLength(raw, 'utf8') > NODE_CHANNEL_MAX_FRAME_BYTES) invalid('too large');
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    invalid('JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('object');
  if (value.v !== NODE_CHANNEL_VERSION) invalid('version');
  if (typeof value.type !== 'string' || !TYPES.has(value.type)) invalid('type');
  if (typeof value.stream_id !== 'string' || !STREAM_ID.test(value.stream_id)) invalid('stream_id');
  integer(value.seq, 'seq', 0, Number.MAX_SAFE_INTEGER);

  switch (value.type) {
    case 'node.heartbeat':
      if (typeof value.version !== 'string' || value.version.length > 128) invalid('version');
      if (!Array.isArray(value.capabilities) || value.capabilities.length > 32 || !value.capabilities.every((item) => typeof item === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(item))) invalid('capabilities');
      if (typeof value.platform !== 'string' || value.platform.length > 64) invalid('platform');
      if (typeof value.arch !== 'string' || value.arch.length > 64) invalid('arch');
      if (typeof value.sent_at !== 'string' || Number.isNaN(Date.parse(value.sent_at))) invalid('sent_at');
      break;
    case 'assignment.apply':
      value.assignment = assignment(value.assignment);
      break;
    case 'assignment.accept':
      if (value.status !== 'starting' && value.status !== 'ready') invalid('status');
      break;
    case 'assignment.reject':
    case 'assignment.stopped':
      if (typeof value.reason !== 'string' || value.reason.length > 512 || /[\r\n]/.test(value.reason)) invalid('reason');
      break;
    case 'assignment.ready':
      if (value.native_conversation_id !== undefined && (typeof value.native_conversation_id !== 'string' || value.native_conversation_id.length > 512)) invalid('native_conversation_id');
      if (!Array.isArray(value.ports) || value.ports.length > 32) invalid('ports');
      value.ports = value.ports.map((port) => integer(port, 'port', 1, 65_535));
      break;
    case 'assignment.stop':
      if (!['stop', 'restart', 'release', 'drain'].includes(value.reason as string)) invalid('reason');
      break;
    case 'stream.open':
      integer(value.port, 'port', 1, 65_535);
      if (typeof value.method !== 'string' || !TOKEN.test(value.method)) invalid('method');
      if (typeof value.path !== 'string' || !value.path.startsWith('/') || value.path.length > 16_384) invalid('path');
      value.headers = headers(value.headers);
      integer(value.window, 'window', 1, NODE_CHANNEL_MAX_WINDOW_BYTES);
      break;
    case 'stream.response':
      integer(value.status, 'status', 100, 599);
      value.headers = headers(value.headers);
      integer(value.window, 'window', 1, NODE_CHANNEL_MAX_WINDOW_BYTES);
      break;
    case 'stream.request':
    case 'stream.response.data':
      data(value.data);
      break;
    case 'socket.data':
      data(value.data);
      if (typeof value.binary !== 'boolean') invalid('binary');
      if (typeof value.fin !== 'boolean') invalid('fin');
      break;
    case 'stream.cancel':
      if (typeof value.reason !== 'string' || value.reason.length > 256 || /[\r\n]/.test(value.reason)) invalid('reason');
      break;
    case 'stream.window':
      integer(value.credit, 'credit', 1, NODE_CHANNEL_MAX_WINDOW_BYTES);
      break;
    case 'socket.open':
      integer(value.port, 'port', 1, 65_535);
      if (typeof value.path !== 'string' || !value.path.startsWith('/') || value.path.length > 16_384) invalid('path');
      value.headers = headers(value.headers);
      break;
    case 'socket.close':
      integer(value.code, 'code', 1000, 4999);
      if (typeof value.reason !== 'string' || value.reason.length > 123 || /[\r\n]/.test(value.reason)) invalid('reason');
      break;
    case 'rpc.request':
      if (typeof value.method !== 'string' || !/^[a-z][a-z0-9_.-]{0,127}$/.test(value.method)) invalid('method');
      if (!value.params || typeof value.params !== 'object' || Array.isArray(value.params)) invalid('params');
      break;
    case 'rpc.error':
      integer(value.code, 'code', -32_768, 32_767);
      if (typeof value.message !== 'string' || value.message.length > 1024 || /[\r\n]/.test(value.message)) invalid('message');
      break;
  }
  return value as unknown as NodeChannelFrame;
}
