import { buildAcpBridgeEndpoint } from '../session/runtime-transport';
import { createAcpClient, type AcpClient } from './client';
import { applyAcpEnvelope, createAcpProjection, type AcpProjection } from './projection';
import type {
  AcpContentBlock,
  AcpEnvelope,
  AcpJsonRpcId,
  AcpStreamEvent,
  AcpStreamHandle,
} from './types';
import { AcpTransportError } from './types';

const MAX_CONFIG_RESTART_RETRIES = 3;
const ACP_PROMPT_QUIET_PERIOD_MS = 500;

class AcpRuntimeRestartError extends Error {
  constructor() {
    super('ACP runtime restarted');
    this.name = 'AcpRuntimeRestartError';
  }
}

export interface AcpSessionClient {
  connect(options: {
    onEvent(event: AcpStreamEvent): void;
    onError?(error: unknown): void;
  }): AcpStreamHandle;
  loadSession(input: {
    sessionId: string;
    cwd: string;
    mcpServers?: unknown[];
  }): Promise<Record<string, unknown>>;
  setSessionConfigOption(
    sessionId: string,
    configId: string,
    value: unknown,
  ): Promise<Record<string, unknown>>;
  prompt(
    sessionId: string,
    prompt: AcpContentBlock[],
  ): Promise<{ stopReason: string; usage?: Record<string, unknown> }>;
  cancel(sessionId: string): Promise<void>;
  respond(id: AcpJsonRpcId, result?: unknown): Promise<void>;
}

export interface AcpSessionControllerSnapshot {
  ready: boolean;
  sending: boolean;
  connection: 'idle' | 'connecting' | 'open' | 'closed' | 'error';
  error: Error | null;
  projection: AcpProjection;
  configOptions: Array<Record<string, unknown>>;
}

export interface AcpSessionControllerOptions {
  sessionId: string;
  runtimeUrl?: string;
  client?: AcpSessionClient;
  cwd?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function selectedPermissionOption(
  params: Record<string, unknown>,
  reply: 'once' | 'always' | 'reject',
): string | null {
  const options = Array.isArray(params.options) ? params.options.filter(isObject) : [];
  const kinds =
    reply === 'once'
      ? ['allow_once', 'allow']
      : reply === 'always'
        ? ['allow_always', 'always']
        : ['reject_once', 'reject_always', 'reject'];
  for (const kind of kinds) {
    const option = options.find((candidate) => candidate.kind === kind);
    const id = option && asString(option.optionId);
    if (id) return id;
  }
  return null;
}

function questionContent(
  params: Record<string, unknown>,
  answers: string[][],
): Record<string, unknown> {
  const schema = isObject(params.requestedSchema)
    ? params.requestedSchema
    : isObject(params.schema)
      ? params.schema
      : null;
  const properties = schema && isObject(schema.properties) ? Object.keys(schema.properties) : [];
  if (properties.length === 0) return { answers };
  return Object.fromEntries(
    properties.map((key, index) => {
      const answer = answers[index] ?? [];
      return [key, answer.length <= 1 ? (answer[0] ?? '') : answer];
    }),
  );
}

function hasProjectionBlockers(projection: AcpProjection): boolean {
  return (
    projection.permissions.length > 0 ||
    projection.questions.length > 0 ||
    projection.messages.some((message) =>
      message.parts.some(
        (part) =>
          part.type === 'tool' &&
          (part.state.status === 'pending' || part.state.status === 'running'),
      ),
    )
  );
}

function isPromptResult(envelope: AcpEnvelope): boolean {
  return (
    'id' in envelope &&
    !('method' in envelope) &&
    isObject(envelope.result) &&
    (asString(envelope.result.stopReason) !== null || isObject(envelope.result.usage))
  );
}

function settleLoadedProjection(projection: AcpProjection): AcpProjection {
  if (hasProjectionBlockers(projection)) return projection;
  const completed = Date.now();
  return {
    ...projection,
    status: { type: 'idle' },
    messages: projection.messages.map((message) =>
      message.info.role === 'assistant' && !message.info.time.completed
        ? {
            ...message,
            info: {
              ...message.info,
              time: { ...message.info.time, completed },
            },
          }
        : message,
    ),
  };
}

export class AcpSessionController {
  private readonly client: AcpSessionClient;
  private readonly listeners = new Set<() => void>();
  private readonly openRequests = new Map<
    string,
    { id: AcpJsonRpcId; params: Record<string, unknown> }
  >();
  private stream: AcpStreamHandle | null = null;
  private connecting: Promise<void> | null = null;
  private runtimeReload: Promise<void> | null = null;
  private runtimeGeneration = 0;
  private readonly restartWaiters = new Set<() => void>();
  private promptQueue: Promise<void> = Promise.resolve();
  private promptSettlement: {
    result: Record<string, unknown>;
    timer: ReturnType<typeof setTimeout> | null;
    resolve(): void;
  } | null = null;
  private snapshot: AcpSessionControllerSnapshot;

  constructor(private readonly options: AcpSessionControllerOptions) {
    if (!options.client && !options.runtimeUrl) {
      throw new Error('AcpSessionController requires a runtimeUrl or injected client');
    }
    this.client =
      options.client ??
      createAcpClient({
        endpoint: buildAcpBridgeEndpoint(options.runtimeUrl as string, options.sessionId),
      });
    this.snapshot = {
      ready: false,
      sending: false,
      connection: 'idle',
      error: null,
      projection: createAcpProjection(options.sessionId),
      configOptions: [],
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AcpSessionControllerSnapshot => this.snapshot;

  async connect(): Promise<void> {
    if (this.runtimeReload) return this.runtimeReload;
    if (this.snapshot.ready) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async open(): Promise<void> {
    this.resetCanonicalSessionState();
    this.patch({ connection: 'connecting', error: null });
    if (!this.stream) {
      this.stream = this.client.connect({
        onEvent: (event) => this.onEnvelope(event.envelope),
        onError: (error) => {
          if (!(error instanceof AcpTransportError) || !error.terminal) return;
          this.patch({
            ready: false,
            connection: 'error',
            error: error instanceof Error ? error : new Error(String(error)),
          });
        },
      });
    }
    try {
      await this.stream.ready;
      await this.loadCanonicalSession();
    } catch (error) {
      this.patch({
        ready: false,
        connection: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    }
  }

  private resetCanonicalSessionState(): void {
    this.openRequests.clear();
    this.patch({
      projection: createAcpProjection(this.options.sessionId),
    });
  }

  private async loadCanonicalSession(): Promise<void> {
    const loaded = await this.client.loadSession({
      sessionId: this.options.sessionId,
      cwd: this.options.cwd ?? '/workspace',
    });
    const configOptions = Array.isArray(loaded.configOptions)
      ? loaded.configOptions.filter(isObject)
      : [];
    const projection = settleLoadedProjection(this.snapshot.projection);
    this.patch({
      ready: true,
      connection: 'open',
      error: null,
      configOptions,
      projection: {
        ...projection,
        configOptions,
      },
    });
  }

  private reloadAfterRuntimeReady(): void {
    if (!this.snapshot.ready || this.runtimeReload) return;
    this.resetCanonicalSessionState();
    this.patch({ ready: false, connection: 'connecting', error: null });
    const reload = this.loadCanonicalSession()
      .catch((error) => {
        this.patch({
          ready: false,
          connection: 'error',
          error: error instanceof Error ? error : new Error(String(error)),
        });
      })
      .finally(() => {
        if (this.runtimeReload === reload) this.runtimeReload = null;
      });
    this.runtimeReload = reload;
    void reload;
  }

  private onRuntimeReady(): void {
    this.runtimeGeneration += 1;
    for (const restart of this.restartWaiters) restart();
    this.restartWaiters.clear();
    this.reloadAfterRuntimeReady();
  }

  private async raceWithRuntimeRestart<T>(operation: Promise<T>, generation: number): Promise<T> {
    if (generation !== this.runtimeGeneration) {
      void operation.catch(() => {});
      throw new AcpRuntimeRestartError();
    }
    let restart = (): void => {};
    const restarted = new Promise<never>((_resolve, reject) => {
      restart = () => reject(new AcpRuntimeRestartError());
    });
    this.restartWaiters.add(restart);
    try {
      return await Promise.race([operation, restarted]);
    } finally {
      this.restartWaiters.delete(restart);
    }
  }

  send(
    prompt: AcpContentBlock[],
    options: { model?: string | null; agent?: string | null } = {},
  ): Promise<void> {
    let resolveRequest: () => void = () => {};
    let rejectRequest: (error: unknown) => void = () => {};
    const request = new Promise<void>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const queued = this.promptQueue.then(() =>
      this.executeSend(prompt, options, {
        resolve: resolveRequest,
        reject: rejectRequest,
      }),
    );
    this.promptQueue = queued.catch(() => {});
    return request;
  }

  private async executeSend(
    prompt: AcpContentBlock[],
    options: { model?: string | null; agent?: string | null },
    request: { resolve(): void; reject(error: unknown): void },
  ): Promise<void> {
    const text = prompt
      .filter((part): part is Extract<AcpContentBlock, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('');
    this.patch({ sending: true, error: null });
    try {
      let restartRetries = 0;
      let generation = this.runtimeGeneration;
      while (true) {
        if (!this.snapshot.ready) await this.connect();
        generation = this.runtimeGeneration;
        try {
          if (options.model) {
            await this.raceWithRuntimeRestart(
              this.client.setSessionConfigOption(this.options.sessionId, 'model', options.model),
              generation,
            );
          }
          if (options.agent) {
            await this.raceWithRuntimeRestart(
              this.client.setSessionConfigOption(this.options.sessionId, 'mode', options.agent),
              generation,
            );
          }
          if (generation !== this.runtimeGeneration) {
            throw new AcpRuntimeRestartError();
          }
          break;
        } catch (error) {
          if (!(error instanceof AcpRuntimeRestartError)) throw error;
          restartRetries += 1;
          if (restartRetries > MAX_CONFIG_RESTART_RETRIES) {
            throw new Error(
              `ACP runtime restarted more than ${MAX_CONFIG_RESTART_RETRIES} times while preparing the prompt`,
            );
          }
          if (this.runtimeReload) await this.runtimeReload;
        }
      }

      if (text) {
        this.onEnvelope({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: this.options.sessionId,
            update: {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text },
            },
          },
        });
      }
      const promptOperation = this.client.prompt(this.options.sessionId, prompt);
      let result: Awaited<ReturnType<AcpSessionClient['prompt']>>;
      try {
        result = await this.raceWithRuntimeRestart(promptOperation, generation);
      } catch (error) {
        if (error instanceof AcpRuntimeRestartError) {
          throw new Error(
            'ACP runtime restarted after session/prompt dispatch; the prompt result is unknown',
          );
        }
        throw error;
      }
      this.applyPromptResult(result, false);
      request.resolve();
      await this.settlePrompt(result);
    } catch (error) {
      request.reject(error);
      this.discardPromptSettlement();
      this.patch({
        error: error instanceof Error ? error : new Error(String(error)),
        projection: {
          ...this.snapshot.projection,
          status: { type: 'idle' },
        },
      });
      throw error;
    } finally {
      this.patch({ sending: false });
    }
  }

  async cancel(): Promise<void> {
    await this.client.cancel(this.options.sessionId);
    this.discardPromptSettlement();
    this.patch({
      projection: {
        ...this.snapshot.projection,
        status: { type: 'idle' },
        permissions: [],
        questions: [],
      },
    });
  }

  async runCommand(
    command: string,
    args: string,
    options: { model?: string | null; agent?: string | null } = {},
  ): Promise<void> {
    const normalized = command.replace(/^\/+/, '').toLowerCase();
    if (normalized === 'undo' || normalized === 'redo') {
      throw new Error(`OpenCode ACP does not support /${normalized}`);
    }
    const text = `/${normalized}${args.trim() ? ` ${args.trim()}` : ''}`;
    await this.send([{ type: 'text', text }], options);
  }

  async answerPermission(requestId: string, reply: 'once' | 'always' | 'reject'): Promise<void> {
    const request = this.openRequests.get(requestId);
    const responseId = request?.id ?? requestId;
    const params = request?.params ?? {};
    const optionId = selectedPermissionOption(params, reply);
    if (reply === 'reject' && !optionId) {
      const result = { outcome: { outcome: 'cancelled' } };
      await this.client.respond(responseId, result);
      this.onEnvelope({ jsonrpc: '2.0', id: responseId, result });
      return;
    }
    if (!optionId) {
      throw new Error(`ACP permission request ${requestId} has no compatible ${reply} option`);
    }
    const result = {
      outcome: { outcome: 'selected', optionId },
    };
    await this.client.respond(responseId, result);
    this.onEnvelope({ jsonrpc: '2.0', id: responseId, result });
  }

  async answerQuestion(requestId: string, answers: string[][]): Promise<void> {
    const request = this.openRequests.get(requestId);
    const responseId = request?.id ?? requestId;
    const params = request?.params ?? {};
    const result = {
      action: 'accept',
      content: questionContent(params, answers),
    };
    await this.client.respond(responseId, result);
    this.onEnvelope({ jsonrpc: '2.0', id: responseId, result });
  }

  async rejectQuestion(requestId: string): Promise<void> {
    const responseId = this.openRequests.get(requestId)?.id ?? requestId;
    const result = { action: 'decline' };
    await this.client.respond(responseId, result);
    this.onEnvelope({ jsonrpc: '2.0', id: responseId, result });
  }

  close(): void {
    this.discardPromptSettlement();
    this.stream?.close();
    this.stream = null;
    this.patch({ connection: 'closed', ready: false });
  }

  private onEnvelope(envelope: AcpEnvelope): void {
    if (this.snapshot.sending && isPromptResult(envelope)) return;
    if (
      'method' in envelope &&
      envelope.method === 'kortix/runtime_ready' &&
      (!isObject(envelope.params) ||
        envelope.params.sessionId === null ||
        envelope.params.sessionId === this.options.sessionId)
    ) {
      this.onRuntimeReady();
    }
    if ('method' in envelope && 'id' in envelope && isObject(envelope.params)) {
      this.openRequests.set(String(envelope.id), {
        id: envelope.id,
        params: envelope.params,
      });
    } else if ('id' in envelope && !('method' in envelope)) {
      this.openRequests.delete(String(envelope.id));
    }
    const projection = applyAcpEnvelope(this.snapshot.projection, envelope);
    if (projection !== this.snapshot.projection) this.patch({ projection });
    if ('method' in envelope && envelope.method === 'session/update') {
      this.schedulePromptSettlement();
    }
  }

  private settlePrompt(result: Record<string, unknown>): Promise<void> {
    return new Promise((resolve) => {
      this.promptSettlement = {
        result,
        timer: null,
        resolve,
      };
      this.schedulePromptSettlement();
    });
  }

  private schedulePromptSettlement(): void {
    const settlement = this.promptSettlement;
    if (!settlement) return;
    if (settlement.timer) {
      clearTimeout(settlement.timer);
      settlement.timer = null;
    }
    if (hasProjectionBlockers(this.snapshot.projection)) return;
    settlement.timer = setTimeout(() => {
      if (this.promptSettlement !== settlement || hasProjectionBlockers(this.snapshot.projection)) {
        this.schedulePromptSettlement();
        return;
      }
      this.promptSettlement = null;
      this.applyPromptResult(settlement.result, true);
      settlement.resolve();
    }, ACP_PROMPT_QUIET_PERIOD_MS);
  }

  private applyPromptResult(result: Record<string, unknown>, settled: boolean): void {
    const projection = applyAcpEnvelope(this.snapshot.projection, {
      jsonrpc: '2.0',
      id: `prompt:${Date.now()}`,
      result,
    });
    const next = settled ? projection : { ...projection, status: { type: 'busy' } as const };
    if (next !== this.snapshot.projection) this.patch({ projection: next });
  }

  private discardPromptSettlement(): void {
    const settlement = this.promptSettlement;
    if (!settlement) return;
    this.promptSettlement = null;
    if (settlement.timer) clearTimeout(settlement.timer);
    settlement.resolve();
  }

  private patch(value: Partial<AcpSessionControllerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...value };
    for (const listener of this.listeners) listener();
  }
}

export function createAcpSessionController(
  options: AcpSessionControllerOptions,
): AcpSessionController {
  return new AcpSessionController(options);
}

export type AcpSessionClientInstance = AcpClient;
