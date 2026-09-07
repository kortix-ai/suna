export type BenchmarkRuntime = 'pi' | 'opencode';
export type WorkerPath = 'cold-create' | 'warm-pool-hit' | 'resume';
export type WorkspacePath =
  | 'not-observed'
  | 'same-runtime'
  | 'cold-create'
  | 'already-running'
  | 'resume';

export interface BenchmarkDeclaration {
  label: string;
  runtime: BenchmarkRuntime;
  provider: string;
  region: string;
  model: string;
  workerPath: WorkerPath;
  workspacePath: WorkspacePath;
  tool: boolean;
}

export interface ProductEvent {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
}

interface GlobalEventEnvelope {
  directory?: unknown;
  payload?: unknown;
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const WORKER_PATHS = new Set<WorkerPath>(['cold-create', 'warm-pool-hit', 'resume']);
const WORKSPACE_PATHS = new Set<WorkspacePath>([
  'not-observed',
  'same-runtime',
  'cold-create',
  'already-running',
  'resume',
]);

/** OpenCode wire ids sort by their 48-bit millisecond clock prefix. */
export function mintBenchmarkMessageId(nowMs = Date.now(), random = Math.random): string {
  const clock = (BigInt(Math.trunc(nowMs)) * BigInt(0x1000)) & BigInt(0xffffffffffff);
  let tail = '';
  for (let i = 0; i < 14; i++) {
    tail += BASE62[Math.min(BASE62.length - 1, Math.floor(random() * BASE62.length))];
  }
  return `msg_${clock.toString(16).padStart(12, '0')}${tail}`;
}

function option(argv: readonly string[], name: string): string | undefined {
  const split = argv.find((value) => value.startsWith(`--${name}=`));
  if (split) return split.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function required(argv: readonly string[], name: string): string {
  const value = option(argv, name)?.trim();
  if (!value || value.startsWith('--')) throw new Error(`missing --${name}`);
  return value;
}

/**
 * Parse the dimensions that make two benchmark files comparable.
 *
 * Provider, region, model, and lifecycle are required. A free-form label is
 * never allowed to carry those claims on its own.
 */
export function parseBenchmarkDeclaration(argv: readonly string[]): BenchmarkDeclaration {
  const runtime = required(argv, 'runtime') as BenchmarkRuntime;
  if (runtime !== 'pi' && runtime !== 'opencode') {
    throw new Error('--runtime must be pi or opencode');
  }

  const workerPath = required(argv, 'worker-path') as WorkerPath;
  if (!WORKER_PATHS.has(workerPath)) {
    throw new Error('--worker-path must be cold-create, warm-pool-hit, or resume');
  }

  const workspacePath = required(argv, 'workspace-path') as WorkspacePath;
  if (!WORKSPACE_PATHS.has(workspacePath)) {
    throw new Error(
      '--workspace-path must be not-observed, same-runtime, cold-create, already-running, or resume',
    );
  }

  const tool = argv.includes('--tool');
  if (tool && workspacePath === 'not-observed') {
    throw new Error('--tool requires an observed --workspace-path');
  }

  return {
    label: option(argv, 'label')?.trim() || `${runtime}-${workerPath}`,
    runtime,
    provider: required(argv, 'provider').toLowerCase(),
    region: required(argv, 'region'),
    model: required(argv, 'model'),
    workerPath,
    workspacePath,
    tool,
  };
}

/** Incremental decoder for standard SSE records, including split CRLF chunks. */
export class JsonSseDecoder {
  private readonly decoder = new TextDecoder();
  private buffered = '';

  push(chunk: Uint8Array): unknown[] {
    this.buffered += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  finish(): unknown[] {
    this.buffered += this.decoder.decode();
    return this.drain(true);
  }

  private drain(final: boolean): unknown[] {
    // Preserve a trailing CR until the next chunk. Converting it immediately
    // would turn a CRLF split across chunks into two newlines and create a
    // false record boundary.
    const trailingCr = !final && this.buffered.endsWith('\r');
    const normalizable = trailingCr ? this.buffered.slice(0, -1) : this.buffered;
    this.buffered =
      normalizable.replace(/\r\n/g, '\n').replace(/\r/g, '\n') + (trailingCr ? '\r' : '');
    const records: string[] = [];
    let boundary = this.buffered.indexOf('\n\n');
    while (boundary >= 0) {
      records.push(this.buffered.slice(0, boundary));
      this.buffered = this.buffered.slice(boundary + 2);
      boundary = this.buffered.indexOf('\n\n');
    }
    if (final && this.buffered.trim()) {
      records.push(this.buffered);
      this.buffered = '';
    }

    const values: unknown[] = [];
    for (const record of records) {
      const data = record
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data || data === '[DONE]') continue;
      try {
        values.push(JSON.parse(data));
      } catch {
        throw new Error(`global event stream returned invalid JSON: ${data.slice(0, 160)}`);
      }
    }
    return values;
  }
}

/** Accept both OpenCode's raw event and `/global/event`'s directory envelope. */
export function unwrapProductEvent(value: unknown): ProductEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const envelope = value as GlobalEventEnvelope;
  const candidate =
    envelope.payload && typeof envelope.payload === 'object' && !Array.isArray(envelope.payload)
      ? envelope.payload
      : value;
  const event = candidate as { id?: unknown; type?: unknown; properties?: unknown };
  if (typeof event.type !== 'string') return null;
  return {
    ...(typeof event.id === 'string' ? { id: event.id } : {}),
    type: event.type,
    properties:
      event.properties && typeof event.properties === 'object' && !Array.isArray(event.properties)
        ? (event.properties as Record<string, unknown>)
        : {},
  };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function eventSessionId(event: ProductEvent): string | null {
  const properties = event.properties;
  const info =
    properties.info && typeof properties.info === 'object'
      ? (properties.info as Record<string, unknown>)
      : null;
  const part =
    properties.part && typeof properties.part === 'object'
      ? (properties.part as Record<string, unknown>)
      : null;
  return text(properties.sessionID) ?? text(info?.sessionID) ?? text(part?.sessionID);
}

export interface TurnEventObservation {
  firstTokenMs?: number;
  firstToolResultMs?: number;
  assistantMessageIds: string[];
  observedModels: string[];
  eventCount: number;
  terminalError?: string;
}

/**
 * Select only the assistant that answers this benchmark's user message.
 * This prevents the echoed user text from being recorded as a model token.
 */
export class TurnEventProbe {
  private readonly assistantIds = new Set<string>();
  private readonly models = new Set<string>();
  private firstTokenMs: number | undefined;
  private firstToolResultMs: number | undefined;
  private terminalError: string | undefined;
  private eventCount = 0;

  constructor(
    private readonly sessionId: string,
    private readonly userMessageId: string,
    private readonly requireTool: boolean,
    private readonly toolSentinel: string,
  ) {}

  accept(raw: unknown, elapsedMs: number): void {
    const event = unwrapProductEvent(raw);
    if (!event) return;
    const eventSession = eventSessionId(event);
    if (eventSession && eventSession !== this.sessionId) return;
    this.eventCount++;

    if (event.type === 'message.updated') {
      const info = event.properties.info as Record<string, unknown> | undefined;
      if (info?.role === 'assistant' && typeof info.id === 'string') {
        if (typeof info.parentID !== 'string' || info.parentID === this.userMessageId) {
          this.assistantIds.add(info.id);
          const provider = text(info.providerID);
          const model = text(info.modelID);
          if (provider && model) this.models.add(`${provider}/${model}`);
          if (info.error) this.terminalError = JSON.stringify(info.error).slice(0, 500);
        }
      }
      return;
    }

    if (event.type === 'session.error') {
      this.terminalError = JSON.stringify(event.properties.error ?? event.properties).slice(0, 500);
      return;
    }

    if (event.type === 'message.part.delta') {
      const messageId = text(event.properties.messageID);
      if (
        messageId &&
        this.assistantIds.has(messageId) &&
        event.properties.field === 'text' &&
        text(event.properties.delta) &&
        this.firstTokenMs === undefined
      ) {
        this.firstTokenMs = elapsedMs;
      }
      return;
    }

    if (event.type !== 'message.part.updated') return;
    const part = event.properties.part as Record<string, unknown> | undefined;
    const messageId = text(part?.messageID);
    if (!part || !messageId || !this.assistantIds.has(messageId)) return;
    if (part.type === 'text' && text(part.text) && this.firstTokenMs === undefined) {
      this.firstTokenMs = elapsedMs;
    }
    if (part.type !== 'tool') return;
    const state =
      part.state && typeof part.state === 'object' ? (part.state as Record<string, unknown>) : null;
    if (state?.status === 'error') {
      this.terminalError = `tool failed: ${String(state.error ?? 'unknown error').slice(0, 400)}`;
      return;
    }
    if (
      state?.status === 'completed' &&
      String(state.output ?? '').includes(this.toolSentinel) &&
      this.firstToolResultMs === undefined
    ) {
      this.firstToolResultMs = elapsedMs;
    }
  }

  get complete(): boolean {
    return (
      this.firstTokenMs !== undefined && (!this.requireTool || this.firstToolResultMs !== undefined)
    );
  }

  snapshot(): TurnEventObservation {
    return {
      ...(this.firstTokenMs === undefined ? {} : { firstTokenMs: this.firstTokenMs }),
      ...(this.firstToolResultMs === undefined
        ? {}
        : { firstToolResultMs: this.firstToolResultMs }),
      assistantMessageIds: [...this.assistantIds],
      observedModels: [...this.models],
      eventCount: this.eventCount,
      ...(this.terminalError ? { terminalError: this.terminalError } : {}),
    };
  }
}

export function selectRuntimeSessionId(
  sessions: readonly { id?: unknown }[],
  pinnedId: string | null,
): string {
  if (pinnedId) {
    if (sessions.some((session) => session.id === pinnedId)) return pinnedId;
    throw new Error(`runtime session list does not contain pinned id ${pinnedId}`);
  }
  const ids = sessions
    .map((session) => session.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const only = ids[0];
  if (ids.length === 1 && only) return only;
  throw new Error(`runtime session is ambiguous: expected one session, received ${ids.length}`);
}
