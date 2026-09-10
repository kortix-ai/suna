import { AttachmentInputError, SessionAttachmentStore, attachmentDigest, attachmentUserContent, type PromptAttachment } from './session-attachments.ts';
import { parseWorkerModelLimits, type WorkerModelLimits } from './model-limits';
import { installCustomAgent } from './custom-agent.ts';
import { applyGenerationSettings, applyReasoningVariant, supportedReasoningVariants } from './generation-settings.ts';
import { applyAgentSteps } from './agent-steps.ts';
import { appendRuntimeToolGuidance } from './runtime-tool-guidance.ts';
/**
 * kortix-worker (spike) — the harness, and only the harness.
 *
 * What makes this a worker rather than "an agent running on a box":
 *
 *   toolContext: { env: new KortixExecutionEnv(...) }
 *
 * pi-agent-core's built-in bash/read/write/edit tools and Kortix's glob/grep
 * tools resolve their filesystem and shell out of that context. Handing them a
 * KortixExecutionEnv means the agent has no reachable path to this process's
 * own disk through any default tool. That is the harness/environment split.
 *
 * Two model modes:
 *   faux  — a scripted provider. No credentials, no network. Used by the proof.
 *   real  — a normal provider; KORTIX_GATEWAY_URL sets the model endpoint so
 *           traffic goes through the Kortix LLM gateway rather than direct.
 */
import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { Agent, convertToLlm } from '@earendil-works/pi-agent-core';
import { compactedModelContext, contextNeedsCompaction, summarizeContext, transcriptMessagesFromEntries } from './context-compaction.ts';
import type { ExecutionEnv } from '@earendil-works/pi-agent-core';
import {
  InMemoryCredentialStore,
  createAssistantMessageEventStream,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import type { AssistantMessage, AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { recoverProviderOverflow } from './provider-overflow';
import { Session } from '@earendil-works/pi-agent-core';
import { assistantContractFields, ChatEventAdapter } from './chat-events.ts';
import {
  PiCommandUnsupportedError,
  preparePiCommand,
  type PiCommand,
} from './command-runtime.ts';
import { KortixExecutionEnv } from './kortix-env.ts';
import { LazyKortixEnv } from './lazy-env.ts';
import { parsePromptInput, type CompiledPromptRuntime } from './prompt-input.ts';
import { installStructuredOutput } from './structured-output.ts';
import type { OutputFormat } from '@opencode-ai/sdk/v2';
import { PermissionBroker } from './permission-broker.ts';
import { PermissionApprovalStore } from './permission-store.ts';
import { PermissionCheckpointStore, type PermissionCheckpoint } from './permission-checkpoint.ts';
import { completedToolCalls, hasIncompleteToolHistory, installToolReplay, planToolReplay } from './tool-replay.ts';
import type { PermissionConfig } from './permission-policy.ts';
import { protectToolsWithPermissions } from './permission-tools.ts';
import { QuestionBroker } from './question-broker.ts';
import { QuestionCheckpointStore, type QuestionCheckpoint } from './question-checkpoint.ts';
import { planQuestionReplay } from './question-replay.ts';
import { createWebFetchTool } from './web-fetch-tool.ts';
import { createConnectorTools } from './connector-tools.ts';
import { buildTurnResumeRelay, TurnResumeRejectedError } from './turn-resume-relay.ts';
import { createWebSearchTool } from './web-search-tool.ts';
import { createTodoTools } from './todo-tools.ts';
import { createQuestionTool } from './question-tool.ts';
import { createSkillTool, type PiSkill } from './skill-runtime.ts';
import { RuntimeSurface, decodePathSegment, mintRootId } from './runtime-surface.ts';
import {
  DurableSessionStorage,
  MAX_SESSION_LOG_ITEM_BYTES,
  RemoteSessionLog,
  SessionLogItemTooLargeError,
  SessionLogReadUnavailableError,
  type SessionLog,
  type SessionLogItem,
  type StorageLogItem,
} from './session-store.ts';
import { persistNewMessages } from './durable-append.ts';
import {
  TurnAdmissionJournal,
  TurnJournalAdmissionConflictError,
  TurnJournalMessageOrderError,
  type JsonObject,
  type TurnAdmission,
  type WireMessageEnvelope,
} from './turn-journal.ts';
import { TurnQueue, type TurnCompletion } from './turn-queue.ts';
import {
  type TurnEndIdentity,
  buildTurnEndRelay,
  createTurnEndRelayDrain,
  scheduleBootReconcile,
} from './turn-end-relay.ts';
import { createWorkspaceTools } from './workspace-tools.ts';
import { mintWireMessageId, wireIdTime } from './wire-message-id.ts';

/**
 * pi's session layer runs `assertJsonSerializable` on every durable payload:
 * no `undefined`, no non-finite numbers, no cycles. That is a deliberate and
 * correct guard — it means anything accepted into a session is guaranteed
 * persistable — but provider messages routinely carry `undefined` optional
 * fields, so a bridge has to normalize before appending.
 *
 * Dropping an `undefined`-valued key is lossless: JSON has no representation
 * for it, and a reader cannot distinguish "absent" from "present but
 * undefined". Non-finite numbers would be a real loss, so those are surfaced
 * rather than silently coerced.
 */
function toDurable<T>(value: T, path = 'message'): T {
  if (value === null) return value;
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`non-finite number at ${path} cannot be persisted`);
  }
  if (Array.isArray(value))
    return value.map((v, i) => toDurable(v, `${path}[${i}]`)) as unknown as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = toDurable(v, `${path}.${k}`);
    }
    return out as unknown as T;
  }
  return value;
}

function volatileSessionLog(): SessionLog {
  const items: SessionLogItem[] = [];
  return {
    append: async (item) => {
      items.push(structuredClone(item));
    },
    read: async () => structuredClone(items),
  };
}

class RequestBodyTooLargeError extends Error {}
class RequestBodyValidationError extends Error {}

function readBoundedRequestBody(
  req: IncomingMessage,
  maxBytes = MAX_SESSION_LOG_ITEM_BYTES,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const rejectLarge = () => {
      if (settled) return;
      settled = true;
      cleanup();
      // Discard any bytes already in flight. The response sets Connection:
      // close, so a client that never sends EOF cannot retain a request slot.
      req.resume();
      reject(new RequestBodyTooLargeError(`request body exceeds ${maxBytes} bytes`));
    };
    const onData = (chunk: Buffer | string) => {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += next.byteLength;
      if (bytes > maxBytes) return rejectLarge();
      chunks.push(next);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, bytes).toString('utf8'));
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAborted = () => onError(new Error('request body was aborted'));

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    const declaredBytes = Number(req.headers['content-length']);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) rejectLarge();
  });
}

function parseBenchmarkPromptBody(
  body: string,
  allowScript: boolean,
): { text: string; script?: unknown[] } {
  const value = JSON.parse(body);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestBodyValidationError('request body must be a JSON object');
  }
  const record = value as { text?: unknown; script?: unknown };
  if (typeof record.text !== 'string') {
    throw new RequestBodyValidationError('text must be a string');
  }
  if (allowScript && record.script !== undefined && !Array.isArray(record.script)) {
    throw new RequestBodyValidationError('script must be an array');
  }
  return {
    text: record.text,
    ...(allowScript && Array.isArray(record.script) ? { script: record.script } : {}),
  };
}

function parseFauxScript(raw: string | undefined): unknown[] | undefined {
  if (raw === undefined) return undefined;
  const script = JSON.parse(raw) as unknown;
  if (!Array.isArray(script)) {
    throw new Error('KORTIX_FAUX_SCRIPT must be a JSON array');
  }
  return script;
}

function setFauxScriptResponses(
  faux: ReturnType<typeof fauxProvider>,
  script: readonly unknown[],
): void {
  faux.setResponses(
    script.map((rawStep) => {
      const step =
        rawStep && typeof rawStep === 'object' && !Array.isArray(rawStep)
          ? (rawStep as { tool?: unknown; args?: unknown; text?: unknown })
          : {};
      return typeof step.tool === 'string'
        ? fauxAssistantMessage([fauxToolCall(step.tool, step.args ?? {})], {
            stopReason: 'toolUse',
          })
        : fauxAssistantMessage(String(step.text ?? ''), { stopReason: 'stop' });
    }),
  );
}

function promptRuntime(agent: string | null, model: string | null): CompiledPromptRuntime {
  if (!model) return { agent, model: null };
  const native = model.startsWith('kortix/') ? model.slice('kortix/'.length) : model;
  return {
    agent,
    // Every model served through the Kortix gateway is registered under the
    // synthetic `kortix` provider. The entire native ref is its modelID.
    model: native ? { providerID: 'kortix', modelID: native } : null,
  };
}

export function terminalAgentStatus(messages: readonly unknown[]): 'idle' | 'error' {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; stopReason?: unknown; kortixStructuredOutputError?: unknown } | undefined;
    if (message?.role !== 'assistant') continue;
    return message.stopReason === 'error' ||
      message.stopReason === 'aborted' ||
      message.stopReason === 'length' || message.kortixStructuredOutputError
      ? 'error'
      : 'idle';
  }
  return 'idle';
}

class TurnAdmissionStoppedError extends Error {
  constructor() { super("message was stopped before acceptance"); }
}

class TurnAdmissionConflictError extends Error {
  constructor(messageId: string) {
    super(`message ${messageId} was already admitted with conflicting content`);
    this.name = 'TurnAdmissionConflictError';
  }
}

class TurnMessageOrderError extends Error {
  constructor() {
    super('messageID must sort after the durable transcript');
    this.name = 'TurnMessageOrderError';
  }
}

/**
 * The branch's messages, oldest first.
 *
 * `findEntriesOnBranch` walks parent links UP from the leaf, so it hands the
 * branch back NEWEST-FIRST. Both consumers need the opposite: the agent
 * replays this array as its conversation history, and the runtime surface
 * mints wire ids in array order. Unsorted, a resumed session came back with
 * its questions answered backwards. Sort on the entry's own `seq` — the walk
 * order is pi's business, the ordering contract is ours.
 */
export function restoredMessagesFromEntries(entries: readonly any[]): any[] {
  return transcriptMessagesFromEntries(entries);
}

function recoveredAssistantWireMessages(
  messages: readonly any[],
  parentMessageId: string,
  sessionId: string,
): WireMessageEnvelope[] {
  const byId = new Map<string, WireMessageEnvelope>();
  for (const message of messages) {
    if (
      message?.role !== 'assistant' ||
      message.kortixParentMessageId !== parentMessageId ||
      typeof message.kortixWireMessageId !== 'string' ||
      message.kortixWireMessageId.length === 0
    ) {
      continue;
    }
    byId.set(message.kortixWireMessageId, {
      info: {
        id: message.kortixWireMessageId,
        role: 'assistant',
        sessionID: sessionId,
        parentID: parentMessageId,
      },
      parts: [],
    });
  }
  return [...byId.values()];
}

/**
 * True time-to-first-token, measured at the provider stream boundary.
 *
 * NOTE — this file previously claimed that `Agent.subscribe` emits no text
 * deltas and that a streaming frontend must tap the pi-ai layer. That was
 * WRONG. `AgentEvent` includes `message_update`, which carries both the
 * accumulating message and the raw `assistantMessageEvent`; a 30-word answer
 * produces 21 of them (text_start / 19x text_delta / text_end). S0.5's adapter
 * streams straight off Agent events and needs no pi-ai tap.
 *
 * This wrapper is kept only because it times the FIRST byte at the provider
 * boundary, before the Agent loop sees it — a slightly earlier and more
 * honest instant for a latency number. It is instrumentation, not plumbing.
 */
export function tapFirstToken(
  inner: AssistantMessageEventStream,
  onFirst: (ms: number) => void,
  model: { api?: unknown; provider?: unknown; id?: unknown },
  signal?: AbortSignal,
): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  const t0 = process.hrtime.bigint();
  let fired = false;
  const normalize = (message: AssistantMessage): AssistantMessage =>
    signal?.aborted && message.stopReason === 'error'
      ? { ...message, stopReason: 'aborted' }
      : message;
  (async () => {
    try {
      for await (const ev of inner) {
        if (!fired) {
          const event = ev as { type?: unknown; delta?: unknown };
          if (
            (event.type === 'text_delta' || event.type === 'thinking_delta') &&
            typeof event.delta === 'string' &&
            event.delta.length > 0
          ) {
            fired = true;
            onFirst(Number(process.hrtime.bigint() - t0) / 1e6);
          }
        }
        if (ev.type === 'error') {
          const error = normalize(ev.error);
          out.push({ ...ev, error, reason: error.stopReason === 'aborted' ? 'aborted' : ev.reason });
        } else {
          out.push(ev);
        }
      }
      out.end(normalize(await inner.result()));
    } catch (error) {
      const aborted = signal?.aborted || (error instanceof Error && error.name === 'AbortError');
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        api: String(model.api ?? 'unknown'),
        provider: String(model.provider ?? 'unknown'),
        model: String(model.id ?? 'unknown'),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: aborted ? 'aborted' : 'error',
        errorMessage: String((error as Error)?.message ?? error),
        timestamp: Date.now(),
      };
      out.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: message });
    }
  })();
  return out;
}

const BOOT_T0 = Date.now();

/**
 * Is this process confined by node's permission model?
 *
 * The check is the capability itself, not a flag we were told about: asking
 * `process.permission.has('fs.write')` answers whether a write ANYWHERE would
 * be allowed. A process started without `--permission` has no
 * `process.permission` at all and is, by definition, not confined.
 */
export function isConfined(): boolean {
  const permission = (process as { permission?: { has?: (scope: string) => boolean } }).permission;
  if (!permission || typeof permission.has !== 'function') return false;
  try {
    return !permission.has('fs.write');
  } catch {
    return false;
  }
}

/**
 * Seconds since the machine booted, read at the moment we start serving.
 *
 * This is the number the whole project turns on. The in-guest clock the
 * platform already has (`bootMark()` in kortixd) starts at PROCESS start, so
 * it cannot see VM allocation or rootfs restore — the two costs the small
 * image actually removes. Reading /proc/uptime at listen time gives
 * machine-boot -> serving from inside the box, with no dependency on the
 * benchmark host's clock or its latency to the provider.
 */
function vmUptimeMs(): number | null {
  try {
    const raw = require('node:fs').readFileSync('/proc/uptime', 'utf8');
    return Math.round(Number.parseFloat(raw.split(' ')[0]) * 1000);
  } catch {
    return null;
  }
}

class TurnOwnerLeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnOwnerLeaseLostError';
  }
}

export interface WorkerConfig {
  port: number;
  envUrl: string;
  /** True only when KORTIX_ENV_URL was set explicitly (spike/bench rigs). */
  envUrlExplicit?: boolean;
  envCwd: string;
  envToken?: string;
  envHeaders?: Record<string, string>;
  envTransport?: 'fetch' | 'keepalive' | 'ws';
  environmentStartup?: 'lazy' | 'prewarm';
  /** Lazy-environment identity (P1.7): all four present → first compute tool
   *  call provisions the session's environment through the Kortix API. */
  apiUrl?: string;
  kortixToken?: string;
  projectId?: string;
  systemPrompt: string;
  modelMode: 'faux' | 'real';
  providerId?: string;
  modelId?: string;
  modelLimits?: WorkerModelLimits;
  apiKey?: string;
  gatewayUrl?: string;
  /** Durable session store. Absent = in-memory only (conversation dies with the process). */
  storeUrl?: string;
  storeHeaders?: Record<string, string>;
  sessionId?: string;
  /** Internal owner lease knobs. Tests shorten them; production uses conservative defaults. */
  turnOwnerHeartbeatMs?: number;
  turnOwnerLeaseMs?: number;
  turnAbortPollMs?: number;
  turnAbortAckTimeoutMs?: number;
  /** Deterministic provider replies for black-box tests. Used only in faux mode. */
  fauxScript?: unknown[];
}

export const DEFAULT_TURN_OWNER_HEARTBEAT_MS = 10_000;
export const DEFAULT_TURN_OWNER_LEASE_MS = 60_000;
export const DEFAULT_TURN_ABORT_POLL_MS = 250;
export const DEFAULT_TURN_ABORT_ACK_TIMEOUT_MS = 5_000;

export function configFromEnv(): WorkerConfig {
  const environmentStartup = process.env.KORTIX_ENV_STARTUP ?? 'lazy';
  if (environmentStartup !== 'lazy' && environmentStartup !== 'prewarm') {
    throw new Error('KORTIX_ENV_STARTUP must be lazy or prewarm');
  }
  const mode = (process.env.KORTIX_MODEL_MODE ?? 'faux') as 'faux' | 'real';
  const gatewayUrl = process.env.KORTIX_GATEWAY_URL ?? process.env.KORTIX_LLM_BASE_URL;
  return {
    // KORTIX_SERVICE_PORT is what the PLATFORM injects and what the session
    // proxy dials (sandbox_url ends /8000); PORT is the bench's name. Reading
    // only PORT made every real session bind 8080 while the proxy asked 8000,
    // so the box was healthy and answered 502 "proxy upstream error" forever —
    // with the worker's own log saying "worker listening" the whole time.
    port: Number(process.env.KORTIX_SERVICE_PORT ?? process.env.PORT ?? 8080),
    envUrl: process.env.KORTIX_ENV_URL ?? 'http://127.0.0.1:8100',
    envUrlExplicit: Boolean(process.env.KORTIX_ENV_URL),
    envCwd: process.env.KORTIX_ENV_CWD ?? '/workspace',
    apiUrl: process.env.KORTIX_API_URL,
    kortixToken: process.env.KORTIX_TOKEN,
    projectId: process.env.KORTIX_PROJECT_ID,
    envToken: process.env.KORTIX_ENV_TOKEN,
    envHeaders: process.env.KORTIX_ENV_HEADERS
      ? JSON.parse(process.env.KORTIX_ENV_HEADERS)
      : undefined,
    envTransport: (process.env.KORTIX_ENV_TRANSPORT as any) ?? 'keepalive',
    environmentStartup,
    systemPrompt:
      process.env.KORTIX_SYSTEM_PROMPT ??
      'You are a Kortix agent. All file and shell work happens in the environment, never locally.',
    modelMode: mode,
    providerId: process.env.KORTIX_PROVIDER ?? 'openrouter',
    modelId: process.env.KORTIX_MODEL,
    modelLimits: parseWorkerModelLimits(process.env.KORTIX_MODEL_LIMITS),
    fauxScript: mode === 'faux' ? parseFauxScript(process.env.KORTIX_FAUX_SCRIPT) : undefined,
    // The platform injects the session credential and the gateway base under
    // its OWN names (KORTIX_TOKEN / KORTIX_LLM_BASE_URL, see
    // provisionSessionSandbox). The bench sets the KORTIX_API_KEY /
    // KORTIX_GATEWAY_URL pair. Read both, or a real session finds no
    // credential at all and cannot start — the bench names are the only ones
    // that ever existed here, so nothing outside a bench ever worked.
    // KORTIX_TOKEN is a control-plane session credential. It is valid as model
    // auth only when sent to the Kortix gateway. Never send it directly to an
    // external provider when the gateway URL is absent.
    apiKey: process.env.KORTIX_API_KEY ?? (gatewayUrl ? process.env.KORTIX_TOKEN : undefined),
    gatewayUrl,
    storeUrl: process.env.KORTIX_STORE_URL,
    // The control plane sets only KORTIX_STORE_URL and relies on the session
    // credential it already injects; the bench passes explicit headers. Without
    // this fallback a real session would post to the log unauthenticated and
    // every append would 401 — losing the whole transcript, silently, because
    // appends are the only thing that crosses the network.
    storeHeaders: process.env.KORTIX_STORE_HEADERS
      ? JSON.parse(process.env.KORTIX_STORE_HEADERS)
      : process.env.KORTIX_TOKEN
        ? { authorization: `Bearer ${process.env.KORTIX_TOKEN}` }
        : undefined,
    sessionId: process.env.KORTIX_SESSION_ID ?? 'session-local',
  };
}

export async function buildHarness(cfg: WorkerConfig) {
  if (cfg.projectId && cfg.kortixToken && cfg.sessionId && !cfg.storeUrl) {
    throw new Error('deployed Pi sessions require KORTIX_STORE_URL for durable admission');
  }
  // P1.7 lazy environment: in a session sandbox (identity present, no explicit
  // env URL) the first compute tool call provisions the session's environment
  // through the Kortix API and every operation then runs over the provider
  // edge. Bench/spike rigs keep the direct-URL path by setting KORTIX_ENV_URL.
  const lazy =
    !cfg.envUrlExplicit && cfg.apiUrl && cfg.kortixToken && cfg.projectId && cfg.sessionId
      ? new LazyKortixEnv({
          apiUrl: cfg.apiUrl,
          token: cfg.kortixToken,
          projectId: cfg.projectId,
          sessionId: cfg.sessionId,
          cwd: cfg.envCwd,
        })
      : null;
  const env =
    lazy ??
    new KortixExecutionEnv({
      baseUrl: cfg.envUrl,
      cwd: cfg.envCwd,
      token: cfg.envToken,
      headers: cfg.envHeaders,
      transport: cfg.envTransport,
    });

  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials });

  let model: any;
  let faux: ReturnType<typeof fauxProvider> | undefined;

  if (cfg.modelMode === 'real' && !cfg.apiKey) {
    throw new Error(
      'real model mode requires a provider API key or a gateway URL with KORTIX_TOKEN',
    );
  }
  // Retained in health for wire compatibility. Invalid real configuration now
  // fails boot instead of serving fabricated responses.
  const modelError: string | null = null;
  if (cfg.modelMode === 'faux') {
    faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-1', name: 'Faux' }] });
    models.setProvider(faux.provider);
    model = faux.getModel();
    if (cfg.fauxScript) setFauxScriptResponses(faux, cfg.fauxScript);
  } else {
    // Provider is selectable so the benchmark can use the same path production
    // does (OpenRouter behind the Kortix gateway), not a second one.
    const provider =
      cfg.providerId === 'openrouter'
        ? (await import('@earendil-works/pi-ai/providers/openrouter')).openrouterProvider()
        : (await import('@earendil-works/pi-ai/providers/anthropic')).anthropicProvider();
    models.setProvider(provider);
    if (cfg.apiKey) {
      await credentials.modify(provider.id, async () => ({
        type: 'api_key',
        key: cfg.apiKey,
      }));
    }
    const list = models.getModels(provider.id);
    model = cfg.modelId ? models.getModel(provider.id, cfg.modelId) : list[0];
    if (!model && cfg.modelId && cfg.gatewayUrl && cfg.providerId === 'openrouter') {
      model = {
        id: cfg.modelId, name: cfg.modelId, api: 'openai-completions',
        provider: provider.id, baseUrl: cfg.gatewayUrl,
        reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 0, maxTokens: 32768,
      };
    }
    if (!model) throw new Error(`no model resolved for provider ${provider.id}`);
    if (cfg.gatewayUrl) model = { ...model, baseUrl: cfg.gatewayUrl };
    if (cfg.modelLimits) {
      if (cfg.modelLimits.model !== model.id) throw new Error('Model limits do not match the selected model');
      model = { ...model, contextWindow: cfg.modelLimits.context, maxTokens: cfg.modelLimits.output };
      if (cfg.modelLimits.images !== undefined) model.input = cfg.modelLimits.images ? ['text', 'image'] : ['text'];
      if (cfg.modelLimits.reasoning !== undefined) model.reasoning = cfg.modelLimits.reasoning;
      if (cfg.modelLimits.reasoningEfforts !== undefined) {
        model.thinkingLevelMap = Object.fromEntries(
          ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(level => {
            const effort = level === 'off' ? 'none' : level;
            return [level, cfg.modelLimits!.reasoningEfforts!.includes(effort) ? effort : null];
          }),
        );
      }
    }
  }

  // THE SEAM. Every default tool is bound to the remote environment once.
  const tools = createWorkspaceTools(env as unknown as ExecutionEnv);

  // Durable transcript. The worker is a cache of it, not its owner: kill this
  // process and the conversation is still whole in the store.
  let session: Session | undefined;
  const attachments = new SessionAttachmentStore(cfg.storeUrl, cfg.sessionId, cfg.storeHeaders ?? {});
  let sessionLog: RemoteSessionLog | undefined;
  let durableSessionLog: SessionLog | undefined;
  let turnJournalRef: TurnAdmissionJournal | null = null;
  let recoveryTranscriptOwnerMessageId: string | null = null;
  let persistenceTurnIdentity: (() => string | null) | null = null;
  /** Kept in the health shape for compatibility. Store failures now fail closed. */
  const storeError: string | null = null;
  let restoredEntries = 0;
  let restoredMessages: any[] = [];
  let restoredBranchEntries: any[] = [];
  let bootstrapLogItems: SessionLogItem[] | null = null;
  const reloadDurableSession = async (): Promise<SessionLogItem[]> => {
    if (!sessionLog || !cfg.sessionId) return [];
    const opened = await DurableSessionStorage.open(
      { id: cfg.sessionId } as any,
      durableSessionLog ?? sessionLog,
    );
    restoredEntries = opened.restoredEntries;
    session = new Session(opened.storage as any);
    const leaf = await session.getLeafId();
    restoredBranchEntries = leaf
      ? (await session.findEntriesOnBranch({ start: leaf } as any)).sort(
          (a: any, b: any) => a.seq - b.seq,
        )
      : [];
    restoredMessages = restoredMessagesFromEntries(restoredBranchEntries);
    return opened.logItems;
  };
  if (cfg.storeUrl && cfg.sessionId) {
    sessionLog = new RemoteSessionLog(cfg.storeUrl, cfg.sessionId, cfg.storeHeaders ?? {});
    durableSessionLog = {
      preflight: (item) => sessionLog!.preflight(item),
      read: () => sessionLog!.read(),
      append: async (item, options) => {
        const messageId = recoveryTranscriptOwnerMessageId ?? persistenceTurnIdentity?.() ?? null;
        if (!messageId || !turnJournalRef || item.kind === 'journal') {
          await sessionLog!.append(item, options);
          return;
        }
        if (!(await turnJournalRef.appendTranscriptMutation(messageId, item as StorageLogItem))) {
          throw new TurnOwnerLeaseLostError(
            `turn ${messageId} lost its durable owner lease before transcript append`,
          );
        }
      },
    };
    bootstrapLogItems = await reloadDurableSession();
  }

  const journalLog = sessionLog ?? volatileSessionLog();
  const permissionLog: SessionLog = cfg.storeUrl && cfg.sessionId
    ? {
        read: () => journalLog.read(),
        append: (item, options) => new RemoteSessionLog(
          cfg.storeUrl!, cfg.sessionId!, cfg.storeHeaders ?? {},
        ).append(item, options),
      }
    : journalLog;
  const permissionApprovals = await PermissionApprovalStore.open(permissionLog, bootstrapLogItems ?? undefined);
  const turnJournal = bootstrapLogItems
    ? TurnAdmissionJournal.fromItems(journalLog, bootstrapLogItems)
    : await TurnAdmissionJournal.open(journalLog);
  turnJournalRef = turnJournal;
  const resumableQuestions = new Map<string, QuestionCheckpoint>();
  const resumablePermissions = new Map<string, PermissionCheckpoint[]>();
  const hasResumableTurn = (id: string) => resumableQuestions.has(id) || resumablePermissions.has(id);
  const questionCheckpoints = new QuestionCheckpointStore({
    read: () => journalLog.read(),
    append: async (item) => {
      const messageId = persistenceTurnIdentity?.();
      if (!messageId || !(await turnJournal.appendTranscriptMutation(messageId, item))) {
        throw new Error('question checkpoint lost its durable turn owner');
      }
    },
  });
  const permissionCheckpoints = new PermissionCheckpointStore({
    read: () => journalLog.read(),
    append: async (item) => {
      const messageId = persistenceTurnIdentity?.();
      if (!messageId || !(await turnJournal.appendTranscriptMutation(messageId, item))) {
        throw new TurnOwnerLeaseLostError('permission checkpoint lost its durable turn owner');
      }
    },
  });
  const ownerLeaseMs = Math.max(1, cfg.turnOwnerLeaseMs ?? DEFAULT_TURN_OWNER_LEASE_MS);
  const ownerPollMs = Math.max(1, Math.min(250, Math.floor(ownerLeaseMs / 4)));
  const claimAbandonedTurn = async (messageId: string): Promise<boolean> => {
    while (turnJournal.state(messageId) === 'started') {
      const observed = turnJournal.startedLease(messageId);
      if (!observed) return false;

      // A legacy started record has no owner lease. Claim it immediately. New
      // records must remain unchanged for one full interval measured by this
      // process, so guest clock skew cannot expire a live owner.
      if (observed.ownerId !== null) {
        const deadline = Date.now() + ownerLeaseMs;
        let changed = false;
        while (Date.now() < deadline) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, Math.min(ownerPollMs, Math.max(1, deadline - Date.now()))),
          );
          await turnJournal.refresh();
          if (turnJournal.state(messageId) !== 'started') return false;
          const current = turnJournal.startedLease(messageId);
          if (
            !current ||
            current.ownerId !== observed.ownerId ||
            current.revision !== observed.revision
          ) {
            changed = true;
            break;
          }
        }
        if (changed) continue;
      }

      if (await turnJournal.reclaim(messageId, observed)) return true;
      await turnJournal.refresh();
    }
    return false;
  };
  const rewindAcceptedInputForReplay = async (messageId: string): Promise<boolean> => {
    if (!session) return false;
    const replayIndex = restoredBranchEntries.findIndex(
      (entry: any) =>
        entry.type === 'message' &&
        entry.message?.role === 'user' &&
        entry.message?.kortixWireMessageId === messageId,
    );
    if (replayIndex < 0) return false;
    if (recoveryTranscriptOwnerMessageId && recoveryTranscriptOwnerMessageId !== messageId) {
      throw new Error(
        `turn ${recoveryTranscriptOwnerMessageId} already owns transcript persistence`,
      );
    }
    recoveryTranscriptOwnerMessageId = messageId;
    try {
      const replayEntry = restoredBranchEntries[replayIndex]!;
      await session.moveLane('main', replayEntry.parentId ?? null);
      restoredBranchEntries = restoredBranchEntries.slice(0, replayIndex);
      restoredMessages = restoredMessagesFromEntries(restoredBranchEntries);
      return true;
    } finally {
      if (recoveryTranscriptOwnerMessageId === messageId) {
        recoveryTranscriptOwnerMessageId = null;
      }
    }
  };

  let recoveredTurn: { messageId: string; status: 'idle' | 'error' } | null = null;
  const recoverAbandonedTurn = async (messageId: string): Promise<boolean> => {
    const admission = turnJournal.admission(messageId);
    if (!session || !admission || !(await claimAbandonedTurn(messageId))) return false;
    if (recoveryTranscriptOwnerMessageId && recoveryTranscriptOwnerMessageId !== messageId) {
      throw new Error(
        `turn ${recoveryTranscriptOwnerMessageId} already owns transcript persistence`,
      );
    }
    recoveryTranscriptOwnerMessageId = messageId;
    const recoveryHeartbeatMs = Math.max(
      1,
      Math.min(
        cfg.turnOwnerHeartbeatMs ?? DEFAULT_TURN_OWNER_HEARTBEAT_MS,
        Math.max(1, Math.floor(ownerLeaseMs / 3)),
      ),
    );
    let recoveryCompleted = false;
    let recoveryOwnerLost = false;
    let recoverySettling = false;
    let recoveryHeartbeatInFlight: Promise<void> | null = null;
    const recoveryHeartbeatTimer = setInterval(() => {
      if (recoverySettling || recoveryHeartbeatInFlight) return;
      const heartbeat = (async () => {
        try {
          const renewed = await turnJournal.heartbeat(messageId);
          if (!renewed && !recoveryCompleted) recoveryOwnerLost = true;
        } catch (error) {
          if (!recoveryCompleted) recoveryOwnerLost = true;
          console.error(
            JSON.stringify({
              msg: 'recovered turn owner heartbeat failed',
              messageId,
              error: String((error as Error)?.message ?? error),
            }),
          );
        }
      })();
      recoveryHeartbeatInFlight = heartbeat;
      void heartbeat.finally(() => {
        if (recoveryHeartbeatInFlight === heartbeat) recoveryHeartbeatInFlight = null;
      });
    }, recoveryHeartbeatMs);
    try {
      // The previous owner can commit its Pi message immediately before its
      // lease expires. Reopen after winning the journal claim so recovery sees
      // that terminal message and never appends a duplicate interruption.
      await reloadDurableSession();
      let user = restoredMessages.find(
        (message: any) =>
          message.role === 'user' && message.kortixWireMessageId === admission.messageId,
      );
      if (!user) {
        user = {
          role: 'user',
          content: attachmentUserContent(admission.text, admission.options.files),
          ...(admission.options.files ? { kortixWireUserParts: admission.wireUserMessage.parts } : {}),
          timestamp: Number(
            (admission.wireUserMessage.info.time as { created?: unknown } | undefined)?.created ??
              Date.now(),
          ),
          kortixWireMessageId: admission.messageId,
          ...(admission.options.format === undefined ? {} : { kortixOutputFormat: admission.options.format }),
        };
        await session.appendMessage(toDurable(user) as any);
        restoredMessages.push(user);
      }

      const assistants = restoredMessages.filter(
        (message: any) =>
          message.role === 'assistant' && message.kortixParentMessageId === admission.messageId,
      );
      const terminal = [...assistants]
        .reverse()
        .find((message: any) =>
          ['stop', 'length', 'error', 'aborted'].includes(String(message.stopReason)) ||
          ((Object.hasOwn(message, 'kortixStructured') || message.kortixStructuredOutputError) &&
            !hasIncompleteToolHistory(restoredMessages.slice(restoredMessages.indexOf(user)))),
        );
      const checkpoint = !terminal && !turnJournal.abortRequested(messageId)
        ? await questionCheckpoints.active(messageId)
        : null;
      const permissionStages = !terminal && !turnJournal.abortRequested(messageId)
        ? await permissionCheckpoints.active(messageId)
        : [];
      if (checkpoint && permissionStages.length)
        throw new Error('conflicting blocking interaction checkpoints');
      if (checkpoint || permissionStages.length) {
        if (checkpoint) planQuestionReplay(restoredMessages, checkpoint);
        else planToolReplay(restoredMessages, permissionStages.at(-1)!);
        if (recoveryOwnerLost || !(await turnJournal.heartbeat(messageId))) {
          throw new TurnOwnerLeaseLostError(`lost recovered interaction ownership for ${messageId}`);
        }
        if (checkpoint) resumableQuestions.set(messageId, checkpoint);
        else resumablePermissions.set(messageId, permissionStages);
        return true;
      }
      let status: 'idle' | 'error';
      if (admission.options.noReply === true) {
        status = 'idle';
      } else if (terminal) {
        status = terminalAgentStatus([terminal]);
      } else {
        // A stopped owner can leave a tool-call assistant without its result.
        // Branch from before this accepted input, then add one clean
        // user/interruption pair. The abandoned side-effect trace remains in the
        // append-only tree but never enters the next provider context.
        const abandonedUserEntry = restoredBranchEntries.find(
          (entry: any) =>
            entry.type === 'message' &&
            entry.message?.role === 'user' &&
            entry.message?.kortixWireMessageId === admission.messageId,
        );
        if (abandonedUserEntry && hasIncompleteToolHistory(restoredMessages.slice(restoredMessages.indexOf(user)))) {
          await session.moveLane('main', abandonedUserEntry.parentId ?? null);
          await reloadDurableSession();
          user = {
            role: 'user',
            content: attachmentUserContent(admission.text, admission.options.files),
            ...(admission.options.files ? { kortixWireUserParts: admission.wireUserMessage.parts } : {}),
            timestamp: Number(
              (admission.wireUserMessage.info.time as { created?: unknown } | undefined)?.created ??
                Date.now(),
            ),
            kortixWireMessageId: admission.messageId,
            ...(admission.options.format === undefined ? {} : { kortixOutputFormat: admission.options.format }),
          };
          await session.appendMessage(toDurable(user) as any);
          restoredMessages.push(user);
        }
        let newestKnownTime = wireIdTime(admission.messageId);
        for (const message of restoredMessages) {
          const time = wireIdTime(
            (message as { kortixWireMessageId?: string }).kortixWireMessageId,
          );
          if (time !== null && (newestKnownTime === null || time > newestKnownTime)) {
            newestKnownTime = time;
          }
        }
        const interruptedId = mintWireMessageId({
          nowMs: Date.now(),
          newestKnownTime,
        }).id;
        const interrupted = {
          role: 'assistant',
          content: admission.options.compaction === true ? [] : [
            {
              type: 'text',
              text: 'This turn was interrupted when the worker restarted. Send a new message to continue.',
            },
          ],
          ...(admission.options.compaction === true ? { kortixCompactionSummary: true } : {}),
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'aborted',
          errorMessage: 'The worker restarted before the turn reached a durable terminal state',
          timestamp: Date.now(),
          kortixWireMessageId: interruptedId,
          kortixParentMessageId: admission.messageId,
        };
        await session.appendMessage(toDurable(interrupted) as any);
        restoredMessages.push(interrupted);
        status = 'error';
      }
      recoverySettling = true;
      clearInterval(recoveryHeartbeatTimer);
      await recoveryHeartbeatInFlight;
      if (recoveryOwnerLost) {
        throw new Error(`lost recovered turn ownership for ${admission.messageId}`);
      }
      if (turnJournal.abortRequested(admission.messageId)) {
        if (!(await turnJournal.acknowledgeAbort(admission.messageId))) {
          throw new Error(`lost recovered turn ownership for ${admission.messageId}`);
        }
      }
      const assistantWireMessages = recoveredAssistantWireMessages(
        restoredMessages,
        admission.messageId,
        mintRootId(cfg.sessionId ?? 'session-local'),
      );
      let completed = await turnJournal.complete(
        admission.messageId,
        assistantWireMessages,
        status,
      );
      if (!completed) {
        await turnJournal.refresh();
        if (
          turnJournal.abortRequested(admission.messageId) &&
          (await turnJournal.acknowledgeAbort(admission.messageId))
        ) {
          status = 'error';
          completed = await turnJournal.complete(
            admission.messageId,
            assistantWireMessages,
            status,
          );
        }
      }
      if (!completed) {
        throw new Error(`lost recovered turn ownership for ${admission.messageId}`);
      }
      recoveryCompleted = true;
      recoveredTurn = { messageId: admission.messageId, status };
      return true;
    } finally {
      recoverySettling = true;
      clearInterval(recoveryHeartbeatTimer);
      await recoveryHeartbeatInFlight;
      if (recoveryTranscriptOwnerMessageId === messageId) {
        recoveryTranscriptOwnerMessageId = null;
      }
    }
  };
  if (session && turnJournal.started.length > 0) {
    for (const admission of turnJournal.started) {
      await recoverAbandonedTurn(admission.messageId);
    }
    await reloadDurableSession();
  }

  const timing: { firstTokenMs: number | null } = { firstTokenMs: null };
  let recoverRejectedContext: ((signal?: AbortSignal) => Promise<any[] | null>) | undefined;

  const agent = new Agent({
    streamFn: (m: any, ctx: any, opts: any) => {
      const open = (context: typeof ctx) => tapFirstToken(
        models.streamSimple(m, context, opts),
        (ms) => { if (timing.firstTokenMs === null) timing.firstTokenMs = ms; },
        m, opts?.signal,
      );
      return recoverProviderOverflow(
        open(ctx),
        async () => {
          const messages = await recoverRejectedContext?.(opts?.signal);
          opts?.signal?.throwIfAborted();
          return messages ? open({ ...ctx, messages }) : null;
        },
        opts?.signal,
      );
    },
    toolExecution: 'sequential',
    initialState: {
      systemPrompt: cfg.systemPrompt,
      model,
      thinkingLevel: 'off',
      tools,
      // Seeded from the durable store, so a restarted worker continues the
      // same conversation rather than starting a new one.
      messages: restoredMessages,
    } as any,
  });

  const customAgent = await installCustomAgent(agent, env as unknown as ExecutionEnv, {
    agentName: process.env.KORTIX_AGENT ?? ((globalThis as any).__KORTIX_COMPILED__?.manifest?.default_agent ?? 'build'),
    sessionId: cfg.sessionId ?? 'session-local',
    sourceSha: process.env.KORTIX_BASE_SHA ?? '',
  }, (globalThis as any).__KORTIX_PI_AGENT__, (value, signal) => attachments.hydrateHookInput(value, signal), sessionLog ? {
    read: () => journalLog.read(),
    preflight: item => journalLog.preflight?.(item),
    append: async item => {
      const messageId = persistenceTurnIdentity?.();
      if (messageId) {
        if (!(await turnJournal.appendTranscriptMutation(messageId, item)))
          throw new TurnOwnerLeaseLostError('custom state lost its durable turn owner');
      } else {
        await journalLog.append(item);
      }
    },
  } : undefined);

  const customAfterToolCall = agent.afterToolCall;
  agent.afterToolCall = async (context, signal) => {
    const override = await customAfterToolCall?.(context, signal);
    const content = await attachments.persistImages(override?.content ?? context.result.content ?? [], signal);
    return { ...override, content };
  };
  const customTransform = agent.transformContext;
  let activeModelMessages: typeof agent.state.messages | undefined;
  let recoveredProviderOverflow = false;
  agent.subscribe(event => {
    if (event.type === 'agent_start') recoveredProviderOverflow = false;
  });
  let toolRoundCompaction: ((signal?: AbortSignal) => Promise<void>) | null = null;
  const setToolRoundCompaction = (handler: NonNullable<typeof toolRoundCompaction>) => {
    toolRoundCompaction = handler;
  };
  agent.convertToLlm = async messages => convertToLlm(await attachments.hydrate(messages, agent.signal));
  agent.transformContext = async (messages, signal) => {
    activeModelMessages = messages;
    let context = compactedModelContext(messages, restoredBranchEntries);
    const latest = context.at(-1);
    if (session && toolRoundCompaction && latest?.role === 'toolResult' &&
      contextNeedsCompaction(context.slice(0, -1), latest, model, agent.state.systemPrompt, agent.state.tools)) {
      signal?.throwIfAborted();
      await persistCurrentMessages();
      await toolRoundCompaction(signal);
      signal?.throwIfAborted();
      // The native loop owns a separate transcript array from Agent.state.
      messages.splice(0, messages.length, ...agent.state.messages);
      context = compactedModelContext(messages, restoredBranchEntries);
    }
    return customTransform ? customTransform(context, signal) : context;
  };
  recoverRejectedContext = async signal => {
    if (!session || !toolRoundCompaction || !activeModelMessages || recoveredProviderOverflow ||
      !agent.state.messages.some(message => message.role === 'assistant')) return null;
    signal?.throwIfAborted();
    recoveredProviderOverflow = true;
    await persistCurrentMessages();
    await toolRoundCompaction(signal);
    signal?.throwIfAborted();
    activeModelMessages.splice(0, activeModelMessages.length, ...agent.state.messages);
    const context = compactedModelContext(activeModelMessages, restoredBranchEntries);
    const transformed = customTransform ? await customTransform(context, signal) : context;
    return convertToLlm(await attachments.hydrate(transformed, signal));
  };
  let compactionAbort: AbortController | null = null;
  const abortAgent = agent.abort.bind(agent);
  agent.abort = () => {
    compactionAbort?.abort(new Error('Context compaction was stopped'));
    abortAgent();
  };

  let replayEventHandler: ((event: any) => void) | null = null;
  const setToolReplayEventHandler = (handler: typeof replayEventHandler) => {
    replayEventHandler = handler;
  };
  agent.subscribe(event => { replayEventHandler?.(event); });
  const structuredOutput = installStructuredOutput(agent);
  let persistedMessages = restoredMessages.length;
  const persistCurrentMessages = async () => {
    if (!session || agent.state.messages.length <= persistedMessages) return;
    const result = await persistNewMessages(session, agent.state.messages, persistedMessages, toDurable);
    persistedMessages = result.persisted;
    if (result.error) throw result.error;
  };
  let refreshTail: Promise<any[]> = Promise.resolve(restoredMessages);
  const refreshDurableTranscript = (): Promise<any[]> => {
    if (!sessionLog || !cfg.sessionId) return Promise.resolve(agent.state.messages);
    const refresh = async () => {
      if (agent.state.isStreaming) {
        throw new Error('cannot refresh the durable transcript while the local model is running');
      }
      const opened = await DurableSessionStorage.open(
        { id: cfg.sessionId } as any,
        durableSessionLog ?? sessionLog!,
      );
      const nextSession = new Session(opened.storage as any);
      const leaf = await nextSession.getLeafId();
      const entries = leaf
        ? (await nextSession.findEntriesOnBranch({ start: leaf } as any)).sort(
            (a: any, b: any) => a.seq - b.seq,
          )
        : [];
      const messages = restoredMessagesFromEntries(entries);
      session = nextSession;
      restoredEntries = opened.restoredEntries;
      restoredBranchEntries = entries;
      restoredMessages = messages;
      persistedMessages = messages.length;
      agent.state.messages = messages;
      return messages;
    };
    const result = refreshTail.then(refresh, refresh);
    refreshTail = result.catch(() => agent.state.messages);
    return result;
  };
  const compactContext = async (userMessage: any, assistantId: string): Promise<any[]> => {
    if (!session) throw new Error('Context compaction requires durable session storage');
    const controller = new AbortController();
    compactionAbort = controller;
    try {
      const leaf = await session.getLeafId();
      const entries = leaf
        ? (await session.findEntriesOnBranch({ start: leaf })).sort((a, b) => a.seq - b.seq)
        : [];
      const failCompaction = async (error: unknown): Promise<any[]> => {
        const failed = {
          ...fauxAssistantMessage([], {
            stopReason: controller.signal.aborted ? 'aborted' : 'error',
            errorMessage: String((error as Error)?.message ?? error),
          }),
          api: model.api,
          provider: model.provider,
          model: model.id,
          kortixWireMessageId: assistantId,
          kortixParentMessageId: userMessage.kortixWireMessageId,
          kortixCompactionSummary: true,
        };
        agent.state.messages = [...agent.state.messages, userMessage, failed];
        await persistCurrentMessages();
        return agent.state.messages;
      };
      let summary: Awaited<ReturnType<typeof summarizeContext>>;
      try {
        summary = await summarizeContext(entries, models, model, controller.signal);
      } catch (error) {
        return failCompaction(error);
      }
      const assistant = {
        ...fauxAssistantMessage(summary.summary),
        api: model.api,
        provider: model.provider,
        model: model.id,
        ...(summary.usage ? { usage: summary.usage } : {}),
        kortixWireMessageId: assistantId,
        kortixParentMessageId: userMessage.kortixWireMessageId,
        kortixCompactionSummary: true,
      };
      const payload = toDurable({
        type: 'compaction',
        id: session.idGenerator.next(),
        ...summary,
        details: { ...(summary.details as object), kortixDisplayMessages: [userMessage, assistant] },
      });
      if (Buffer.byteLength(JSON.stringify(payload)) > MAX_SESSION_LOG_ITEM_BYTES - 4096) {
        return failCompaction(new Error('Compaction result exceeds the durable storage budget'));
      }
      try {
        sessionLog?.preflight({ kind: 'entry', lane: 'main', entry: payload });
      } catch (error) {
        if (error instanceof SessionLogItemTooLargeError) return failCompaction(error);
        throw error;
      }
      const entry = await session.appendEntry(payload as any, 'main');
      restoredBranchEntries = [...entries, entry];
      agent.state.messages = [...agent.state.messages, userMessage, assistant];
      persistedMessages = agent.state.messages.length;
      return agent.state.messages;
    } finally {
      if (compactionAbort === controller) compactionAbort = null;
    }
  };

  const setPersistenceTurnIdentity = (source: () => string | null): void => {
    persistenceTurnIdentity = source;
  };

  // Bridge Agent -> Session. AgentHarness would own this natively, but every
  // one of its 23 methods throws HarnessNotImplemented in 0.84.3, so the
  // projection is ours — the fallback the plan named for exactly this case.
  // The on-disk shape is still pi's own MessageEntry, so this stays compatible
  // when AgentHarness lands.
  if (session) {
    // `turn_end` is kept here deliberately (unlike the relay below): persisting
    // each provider round as it completes is what makes a killed worker
    // recoverable rather than losing the whole run.
    agent.subscribe(async (event: any) => {
      if (event.type !== 'agent_end' && event.type !== 'turn_end') return;
      const messageId = persistenceTurnIdentity?.() ?? null;
      if (messageId && !(await turnJournal.heartbeat(messageId))) {
        throw new TurnOwnerLeaseLostError(
          `turn ${messageId} lost its durable owner lease before persistence`,
        );
      }
      // The watermark advances only over messages that actually landed. It used
      // to be set to `all.length` unconditionally after a loop that swallowed
      // its failures, so one 5xx from the store dropped a message for good —
      // and if that message carried a `toolCall` whose `toolResult` appended
      // fine, every later turn 400'd at the provider, permanently, because the
      // hole is in an append-only log.
      await persistCurrentMessages();
    });
  }

  // Close the control plane's turn row.
  //
  // The sandbox daemon does this for an OpenCode session by watching OpenCode's
  // NATIVE `/event` stream, which the pi worker does not serve — so without
  // this, a pi turn's row stays `active` forever. Measured on pi.kortix.com
  // 2026-08-29: nine rows across four sessions, nine still `active`, the oldest
  // 67 minutes after its answer was written. See `./turn-end-relay`.
  //
  // The turn queue starts this relay only after both Pi transcript persistence
  // and the durable admission completion commit. A row closed before that
  // commit can be replayed after a crash and execute the same side effects
  // twice while the control plane reports the turn finished.
  const relayTurnEnd = buildTurnEndRelay(cfg);
  const relayTurnResume = buildTurnResumeRelay(cfg);
  // WHICH turn ended. `completeSandboxTurn` selects the row by identity, so a
  // relay that names no turn closes none and still answers 200 — set by
  // `startWorker` once the RuntimeSurface exists (it is built after the
  // harness, and it is the only holder of the `ses_pi…` id).
  let bootReconcileState:
    | (() => {
        status: 'idle' | 'error';
        identity: TurnEndIdentity | null;
        candidates: Array<{ status: 'idle' | 'error'; identity: TurnEndIdentity }>;
      })
    | null = null;
  const setBootReconcileState = (source: NonNullable<typeof bootReconcileState>) => {
    bootReconcileState = source;
  };
  // Close whatever a PREVIOUS process left open. Armed here, run after listen.
  const bootReconcile = scheduleBootReconcile({
    relay: relayTurnEnd,
    status: () => bootReconcileState?.().status ?? recoveredTurn?.status ?? 'idle',
    identity: () => bootReconcileState?.().identity ?? null,
    candidates: () => bootReconcileState?.().candidates ?? [],
  });
  agent.subscribe((event: any) => {
    // ANY agent event means this process is doing work, so the boot reconcile
    // must never fire — it exists only for a session that booted idle.
    bootReconcile.noteTurnStarted();
  });

  // `lazy` is returned because startWorker prewarms it when a prompt arrives.
  // It was NOT, and the reference there compiled to a binding that does not
  // exist at runtime — every turn answered `lazy is not defined`.
  return {
    agent,
    customAgent,
    env,
    lazy,
    faux,
    models,
    timing,
    sessionRef: () => session,
    refreshDurableTranscript,
    recoverAbandonedTurn,
    rewindAcceptedInputForReplay,
    setPersistenceTurnIdentity,
    restoredEntries,
    restoredMessages,
    storeError,
    modelError,
    resolvedModel: { providerID: String(model.provider), modelID: String(model.id) },
    recoveredTurn,
    sessionLog,
    permissionApprovals,
    questionCheckpoints,
    resumableQuestions,
    resumablePermissions,
    permissionCheckpoints,
    hasResumableTurn,
    persistCurrentMessages,
    compactContext,
    setToolRoundCompaction,
    structuredOutput,
    attachments,
    needsContextCompaction: (incoming: any) => !!session && contextNeedsCompaction(
      compactedModelContext(agent.state.messages, restoredBranchEntries), incoming,
      model, agent.state.systemPrompt, agent.state.tools,
    ),
    setToolReplayEventHandler,
    turnJournal,
    bootReconcile,
    relayTurnEnd,
    relayTurnResume,
    setBootReconcileState,
  };
}

let LISTEN_UPTIME_MS: number | null = null;
/** Process start -> listening. Captured ONCE at listen; reporting
 *  `Date.now() - BOOT_T0` at request time measures process AGE, not boot. */
let LISTEN_MS: number | null = null;

export async function startWorker(cfg = configFromEnv()) {
  let handler: RequestListener = (req, res) => {
    const path = new URL(req.url ?? '/', 'http://worker').pathname;
    const health = req.method === 'GET' && (path === '/kortix/health' || path === '/health');
    res.writeHead(health ? 200 : 503, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-kortix-boot-phase': 'worker-restoring',
      connection: 'close',
    }).end(JSON.stringify(health ? {
      daemon: 'ok',
      status: 'starting',
      runtimeReady: false,
      workload: 'session',
      engine: 'pi',
      boot_phase: 'worker-restoring',
    } : { error: 'runtime_not_ready' }), () => req.destroy());
  };
  const server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  try {
    return await initializeWorker(cfg, server, (ready) => { handler = ready; });
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
}

async function initializeWorker(cfg: WorkerConfig, server: Server, activate: (handler: RequestListener) => void) {
  const {
    agent,
    customAgent,
    env,
    lazy,
    faux,
    timing,
    sessionRef,
    refreshDurableTranscript,
    recoverAbandonedTurn,
    rewindAcceptedInputForReplay,
    setPersistenceTurnIdentity,
    restoredEntries,
    restoredMessages,
    storeError,
    modelError,
    resolvedModel,
    recoveredTurn,
    sessionLog,
    permissionApprovals,
    questionCheckpoints,
    resumableQuestions,
    resumablePermissions,
    permissionCheckpoints,
    hasResumableTurn,
    persistCurrentMessages,
    compactContext,
    setToolRoundCompaction,
    structuredOutput,
    attachments,
    needsContextCompaction,
    setToolReplayEventHandler,
    turnJournal,
    bootReconcile,
    relayTurnEnd,
    relayTurnResume,
    setBootReconcileState,
  } = await buildHarness(cfg);
  const listeners = new Set<(chunk: string) => void>();

  agent.subscribe((event: any) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const l of listeners) l(line);
  });

  // ── Kortix Runtime API (/kortix/opencode/*) ─────────────────────────────
  // The product's session surface: /state, paged /messages, ONE sequenced
  // /events SSE the API relays. One PERSISTENT adapter feeds one surface — the
  // stream and the transcript can never disagree, and message ids stay unique
  // and lexicographically ordered across the whole session.
  const compiledPayload = (globalThis as Record<string, unknown>).__KORTIX_COMPILED__ as
    | {
        manifest?: {
          agent_config_etag?: string | null;
          command_config_etag?: string | null;
          skill_config_etag?: string | null;
          default_agent?: string | null;
        };
        agentConfig?: {
          model?: string;
          agent?: Record<
            string,
            {
              description?: string;
              mode?: 'primary' | 'subagent' | 'all';
              model?: string;
              variant?: string;
              temperature?: number;
              top_p?: number;
              prompt?: string;
              disable?: boolean;
              hidden?: boolean;
              options?: Record<string, unknown>;
              color?: string;
              steps?: number;
              permission?: PermissionConfig;
            }
          >;
        } | null;
        commands?: PiCommand[];
        skills?: PiSkill[];
      }
    | undefined;
  const runtimeAgent =
    process.env.KORTIX_AGENT ?? compiledPayload?.manifest?.default_agent ?? 'build';
  const configuredRuntimeModel = cfg.modelId ?? compiledPayload?.agentConfig?.model ?? null;
  const effectiveRuntime = configuredRuntimeModel
    ? promptRuntime(runtimeAgent, configuredRuntimeModel)
    : ({ agent: runtimeAgent, model: resolvedModel } satisfies CompiledPromptRuntime);
  const runtimeModel = effectiveRuntime.model
    ? `${effectiveRuntime.model.providerID}/${effectiveRuntime.model.modelID}`
    : null;
  let deleteAdmittedTurn:
    | ((messageId: string) => Promise<'deleted' | 'running' | 'missing'>)
    | null = null;
  let stopPendingAdmissions = async (): Promise<void> => {};
  let surface!: RuntimeSurface;
  let recoveryProjectionCount = 0;
  let recoveryProjectionPending = false;
  const selectedAgentConfig = compiledPayload?.agentConfig?.agent?.[runtimeAgent];
  const configuredVariant = selectedAgentConfig?.variant || undefined;
  applyGenerationSettings(agent, selectedAgentConfig);
  effectiveRuntime.variants = supportedReasoningVariants(agent);
  const resumeAgentSteps = applyAgentSteps(agent, selectedAgentConfig?.steps);
  const permissions = new PermissionBroker({
    sessionId: mintRootId(cfg.sessionId ?? 'session-local'),
    permission: selectedAgentConfig?.permission,
    state: () => ({ rules: permissionApprovals.sessionRules(), approved: permissionApprovals.approved() }),
    refresh: () => permissionApprovals.refresh(),
    saveApproval: (approval) => permissionApprovals.save(approval),
    ...(sessionLog ? {
      persistence: {
        open: async (request, toolCallId, stage) => {
          const messageId = surface.turnEndIdentity().messageId;
          if (!messageId) throw new Error('permission requires an active turn');
          await persistCurrentMessages();
          return permissionCheckpoints.open(messageId, toolCallId, stage, request);
        },
        resolve: (requestId, resolution) => permissionCheckpoints.resolve(requestId, resolution),
        release: (toolCallId, tool) => {
          const messageId = surface.turnEndIdentity().messageId;
          if (!messageId) throw new Error('permission release requires an active turn');
          return permissionCheckpoints.release(messageId, toolCallId, tool);
        },
      },
    } : {}),
    publish: (event) => surface.publishWire(event),
  });
  const questions = new QuestionBroker({
    sessionId: mintRootId(cfg.sessionId ?? 'session-local'),
    publish: (event) => surface.publishWire(event),
    ...(sessionLog ? {
      persistence: {
        open: async (request, toolCallId) => {
          const messageId = surface.turnEndIdentity().messageId;
          if (!messageId) throw new Error('question requires an active turn');
          await persistCurrentMessages();
          return questionCheckpoints.open(messageId, toolCallId, request);
        },
        resolve: (requestId, resolution) => questionCheckpoints.resolve(requestId, resolution),
        release: (requestId) => questionCheckpoints.release(requestId),
      },
    } : {}),
  });
  const todos = createTodoTools({
    sessionId: mintRootId(cfg.sessionId ?? 'session-local'),
    messages: () => agent.state.messages,
    publish: (event) => surface.publishWire(event),
  });
  agent.state.tools = protectToolsWithPermissions(
    [
      ...agent.state.tools,
      createQuestionTool(questions, (toolCallId) => wireAdapter.toolContext(toolCallId)),
      ...todos.tools,
      createWebSearchTool(),
      createWebFetchTool({ authorizeRedirect: (url) => permissions.requirePreauthorized('webfetch', url) }),
      createSkillTool(compiledPayload?.skills ?? [], cfg.envCwd),
      ...(cfg.apiUrl && cfg.projectId && cfg.kortixToken
        ? createConnectorTools({ apiUrl: cfg.apiUrl, projectId: cfg.projectId, token: cfg.kortixToken })
        : []),
    ],
    permissions,
    cfg.envCwd,
    (toolCallId) => wireAdapter.toolContext(toolCallId),
    () => agent.abort(),
  );
  agent.state.systemPrompt = appendRuntimeToolGuidance(agent.state.systemPrompt, agent.state.tools);
  surface = new RuntimeSurface({
    registerAttachment: attachments.registerPart,
    sessionId: cfg.sessionId ?? 'session-local',
    projectId: cfg.projectId,
    token: cfg.kortixToken,
    agentName: runtimeAgent,
    agentConfigEtag: compiledPayload?.manifest?.agent_config_etag ?? null,
    commandConfigEtag: compiledPayload?.manifest?.command_config_etag ?? null,
    skillConfigEtag: compiledPayload?.manifest?.skill_config_etag ?? null,
    agents: compiledPayload?.agentConfig?.agent ?? {},
    commands: compiledPayload?.commands ?? [],
    skills: compiledPayload?.skills ?? [],
    tools: agent.state.tools,
    defaultModel: runtimeModel,
    resolvedModel: effectiveRuntime.model ?? resolvedModel,
    reasoningVariants: effectiveRuntime.variants,
    imageAttachments: !!agent.state.model?.input.includes("image"),
    workspace: cfg.envCwd,
    permissions,
    permissionConfig: selectedAgentConfig?.permission,
    sessionPermission: () => permissionApprovals.sessionRules(),
    refreshSessionPermission: () => permissionApprovals.refresh(),
    updateSessionPermission: (rules) => permissionApprovals.setRules(rules),
    questions,
    suspendedTools: () => [
      ...resumableQuestions.values(),
      ...[...resumablePermissions.values()].map(stages => stages.at(-1)!),
    ].map(checkpoint => ({
      messageId: checkpoint.request.tool!.messageID,
      toolCallId: checkpoint.toolCallId,
    })),
    todos: todos.list,
    // The Stop button. `session.abort` on the runtime client is POST
    // `session/:id/abort`, which this surface answered with its catch-all 404
    // until now — so the UI showed "Interrupted" from its own optimistic
    // receipt while the agent kept generating (reported 2026-08-29, pi).
    //
    // Guarded: `abort()` on an idle agent is a no-op, and a throw here must not
    // take down the request — the caller has already decided to stop.
    onAbort: () => {
      return (async () => {
        await stopPendingAdmissions();
        await turnJournal.refresh();
        let active = turnJournal.oldestNonterminal();
        if (active?.state === 'pending') {
          if (await turnJournal.cancel(active.messageId)) return;
          await turnJournal.refresh();
          active = turnJournal.oldestNonterminal();
        }
        if (active?.state === 'started') {
          await turnJournal.requestAbort(active.messageId);
          const deadline =
            Date.now() +
            Math.max(1, cfg.turnAbortAckTimeoutMs ?? DEFAULT_TURN_ABORT_ACK_TIMEOUT_MS);
          while (Date.now() < deadline) {
            await turnJournal.refresh();
            if (
              turnJournal.abortAcknowledged(active.messageId) ||
              turnJournal.state(active.messageId) === 'completed'
            ) {
              break;
            }
            await new Promise<void>((resolve) =>
              setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))),
            );
          }
          await turnJournal.refresh();
          if (
            turnJournal.state(active.messageId) === 'started' &&
            !turnJournal.abortAcknowledged(active.messageId)
          ) {
            throw new Error(`turn ${active.messageId} did not acknowledge Stop`);
          }
        }
        try {
          (agent as { abort?: () => void }).abort?.();
        } catch (e) {
          console.error(
            JSON.stringify({
              msg: 'agent abort failed',
              error: String((e as Error)?.message ?? e),
            }),
          );
        }
        await env.waitForAbortSettled();
      })();
    },
    onStatus: async () => {
      if (surface.turnProbe(null).turn_in_flight || recoveryProjectionCount > 0) return { type: 'busy' };
      if (recoveryProjectionPending) await hydrateDurableState();
      await turnJournal.refresh();
      return { type: turnJournal.oldestNonterminal() || recoveryProjectionCount > 0 ? 'busy' : 'idle' };
    },
    onDeleteMessage: (messageId) => deleteAdmittedTurn?.(messageId) ?? Promise.resolve('missing'),
  });
  setPersistenceTurnIdentity(() => surface.turnEndIdentity().messageId);

  // The relay's turn identity. Set here because the surface is the only holder
  // of the `ses_pi…` session id and the live user message id, and it does not
  // exist until after the harness that owns the relay subscription.
  setBootReconcileState(() => {
    // Journal-owned completions have their own durable relay drain. This pass
    // repairs pre-journal history only, once per exact user-message identity.
    const completed = surface
      .completedTurnIdentities()
      .filter((candidate) => turnJournal.admission(candidate.messageId) === null);
    const candidates = completed.map(({ status, ...identity }) => ({ status, identity }));
    const latest = completed.at(-1) ?? null;
    return {
      status: latest?.status ?? 'idle',
      identity: latest
        ? { opencodeSessionId: latest.opencodeSessionId, messageId: latest.messageId }
        : null,
      candidates,
    };
  });
  // A resumed box must come back with the SAME conversation: one pi instance is
  // one session. Seed BEFORE the adapter is wired so every id this turn mints
  // sorts above the restored transcript instead of back inside it.
  const seededMessages = surface.seedRestoredMessages(restoredMessages);
  if (seededMessages > 0) {
    console.log(
      JSON.stringify({
        msg: 'transcript restored',
        messages: seededMessages,
        entries: restoredEntries,
      }),
    );
  }
  // The admission journal carries exact envelopes for completed and queued
  // turns. Applying them after Pi's tree repairs any legacy projection drift
  // and restores a queued user message that never reached the model.
  surface.seedWireMessages(turnJournal.wireMessages);

  const hydrateDurableState = async (): Promise<void> => {
    const messages = await refreshDurableTranscript();
    const journal = await turnJournal.refresh();
    await permissionApprovals.refresh();
    surface.replaceDurableMessages(messages, journal.wireMessages);
    recoveryProjectionPending = false;
  };
  const recoverAndProjectTurn = async (messageId: string): Promise<void> => {
    recoveryProjectionCount++;
    recoveryProjectionPending = true;
    try {
      await recoverAbandonedTurn(messageId);
      await hydrateDurableState();
    } finally {
      recoveryProjectionCount--;
    }
  };

  const waitForRemoteTurn = async (messageId: string): Promise<TurnCompletion> => {
    while (true) {
      await turnJournal.refresh();
      const state = turnJournal.state(messageId);
      if (state === 'completed') {
        await hydrateDurableState();
        return 'completed';
      }
      if (state === 'cancelled' || state === 'missing') {
        return state === 'cancelled' ? 'cancelled' : 'interrupted';
      }
      if (state === 'started' && sessionLog) {
        await recoverAbandonedTurn(messageId);
        await hydrateDurableState();
        if (hasResumableTurn(messageId)) {
          const admission = turnJournal.admission(messageId);
          if (!admission) throw new Error('recovered interaction lost its admission');
          return queueAdmission(admission);
        }
        continue;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  };
  const wireAdapter = new ChatEventAdapter({
    registerAttachment: attachments.registerPart,
    sessionID: surface.rootId,
    mintMessageId: surface.mintMessageId,
    parentMessageId: () => surface.turnEndIdentity().messageId,
    model: effectiveRuntime.model ?? resolvedModel,
    agent: runtimeAgent,
    mode: runtimeAgent,
    workspace: cfg.envCwd,
  });
  const relayDrain = createTurnEndRelayDrain({
    pending: () => turnJournal.unrelayed,
    relay: relayTurnEnd,
    markRelayed: (messageId) => turnJournal.markRelayed(messageId),
    identity: (messageId) => ({ opencodeSessionId: surface.rootId, messageId, ownerId: turnJournal.turnOwnerId(messageId) }),
  });
  let lastAgentEndStatus: 'idle' | 'error' = 'idle';
  const runContextCompaction = async (compactUser: any) => {
    bootReconcile.noteTurnStarted();
    const assistantId = surface.mintMessageId();
    surface.publishWire({
      type: "session.status",
      properties: { sessionID: surface.rootId, status: { type: "busy" } },
    });
    surface.publishWire({
      type: "message.updated",
      properties: {
        info: {
          id: assistantId,
          role: "assistant",
          parentID: compactUser.kortixWireMessageId,
          sessionID: surface.rootId,
          summary: true,
          time: { created: Date.now() },
          ...(effectiveRuntime.model ?? resolvedModel),
          ...assistantContractFields(undefined, {
            agent: runtimeAgent,
            mode: runtimeAgent,
            workspace: cfg.envCwd,
          }),
        },
      },
    });
    const messages = await compactContext(compactUser, assistantId);
    const status = terminalAgentStatus(messages.slice(-1));
    surface.replaceDurableMessages(messages, turnJournal.wireMessages);
    if (status === "idle")
      surface.publishWire({
        type: "session.compacted",
        properties: { sessionID: surface.rootId },
      });
    return { messages, status };
  };
  const runAutomaticContextCompaction = async () => {
    const compactUser = {
      role: "user",
      content: [
        { type: "text", text: "Compact conversation context." },
      ],
      timestamp: Date.now(),
      kortixWireMessageId: surface.mintMessageId(),
      kortixCompactionAuto: true,
    };
    const compactInfo = {
      id: compactUser.kortixWireMessageId,
      role: "user",
      sessionID: surface.rootId,
      time: { created: compactUser.timestamp },
      agent: runtimeAgent,
      model: effectiveRuntime.model ?? resolvedModel,
    };
    surface.publishWire({
      type: "message.updated",
      properties: { info: compactInfo },
    });
    surface.publishWire({
      type: "message.part.updated",
      properties: {
        part: {
          id: `${compactInfo.id}-p0`,
          messageID: compactInfo.id,
          sessionID: surface.rootId,
          type: "compaction",
          auto: true,
        },
      },
    });
    return runContextCompaction(compactUser);
  };
  setToolRoundCompaction(async (signal) => {
    signal?.throwIfAborted();
    const result = await runAutomaticContextCompaction();
    signal?.throwIfAborted();
    if (result.status === 'error') {
      throw new Error(result.messages.at(-1)?.errorMessage ?? 'Context compaction failed');
    }
  });
  agent.subscribe((event: any) => {
    try {
      for (const wire of wireAdapter.translate(event)) {
        if (event.kortixCachedToolReplay) continue;
        if (event.type === 'agent_end' && surface.turnProbe(null).turn_in_flight) continue;
        surface.publishWire(wire);
      }
      // A pi `turn_end` is one provider round. Only `agent_end` describes the
      // complete run and therefore the control-plane turn result.
      if (event.type !== 'agent_end') return;
      lastAgentEndStatus = terminalAgentStatus(Array.isArray(event.messages) ? event.messages : []);
    } catch (e: any) {
      console.error(JSON.stringify({ msg: 'wire adapter failed', error: String(e?.message ?? e) }));
    }
  });
  type WorkerTurn = TurnAdmission & {
    cancelBarrier: Promise<boolean> | null;
    modelStarted: boolean;
    recovered?: boolean;
  };

  const publishUserMessage = (turn: TurnAdmission): void => {
    surface.noteUserText(turn.text);
    const { info, parts } = turn.wireUserMessage;
    surface.publishWire({
      type: 'message.updated',
      properties: { sessionID: surface.rootId, info },
    });
    for (const part of parts) {
      surface.publishWire({
        type: 'message.part.updated',
        properties: { sessionID: surface.rootId, time: Date.now(), part },
      });
    }
  };

  type PromptOptions = { files?: PromptAttachment[]; system?: string; noReply?: boolean; tools?: Record<string, boolean>; variant?: string; format?: OutputFormat; compaction?: boolean; compactionAuto?: boolean };
  const admissionOptions = (options: PromptOptions): JsonObject => ({
    ...(options.files?.length ? { files: options.files as unknown as JsonObject[] } : {}),
    ...(effectiveRuntime.agent ? { agent: effectiveRuntime.agent } : {}),
    ...(effectiveRuntime.model ? { model: effectiveRuntime.model } : {}),
    ...(options.system === undefined ? {} : { system: options.system }),
    ...(options.format === undefined ? {} : { format: options.format as unknown as JsonObject }),
    ...((options.variant ?? configuredVariant) === undefined ? {} : { variant: (options.variant ?? configuredVariant)! }),
    ...(options.noReply === true ? { noReply: true } : {}),
    ...(options.compaction === true ? { compaction: true, compactionAuto: options.compactionAuto === true } : {}),
    ...(options.tools === undefined
      ? {}
      : { tools: options.tools, toolsOrder: Object.keys(options.tools) }),
  });
  const turns = new Map<string, WorkerTurn>();
  const admissionRetries = new Map<string, ReturnType<typeof setTimeout>>();
  let closing = false;
  const removeCancelledTurn = (messageId: string): TurnCompletion => {
    if (surface.transcript.messageById(messageId)) {
      surface.publishWire({
        type: 'message.removed',
        properties: { messageID: messageId, sessionID: surface.rootId },
      });
    }
    return 'cancelled';
  };
  const turnQueue = new TurnQueue<WorkerTurn>({
    id: (turn) => turn.messageId,
    run: async function runOwnedTurn(turn) {
      if (closing) return 'interrupted';
      // A durable cancellation can be in flight while the preceding turn
      // finishes. Wait for its commit before this input crosses the model
      // boundary. This closes the queue-drain/cancel race.
      if (turn.cancelBarrier && (await turn.cancelBarrier)) {
        return removeCancelledTurn(turn.messageId);
      }
      // Any unresolved transcript append means local Pi state may differ from
      // the control plane. No later turn may cross the model boundary until a
      // the exact pending writes reconcile and the durable log is restored.
      sessionLog?.assertWritable();
      let resumingInteraction = false;
      while (true) {
        if (closing) return 'interrupted';
        if (hasResumableTurn(turn.messageId) && await turnJournal.heartbeat(turn.messageId)) {
          resumingInteraction = true;
          break;
        }
        if (await turnJournal.start(turn.messageId)) break;
        const state = turnJournal.state(turn.messageId);
        if (state === 'cancelled') return removeCancelledTurn(turn.messageId);
        if (state === 'completed') {
          await hydrateDurableState();
          return 'completed';
        }
        if (state === 'started' && sessionLog) {
          await recoverAndProjectTurn(turn.messageId);
          continue;
        }
        if (state === 'started') return waitForRemoteTurn(turn.messageId);
        if (state !== 'pending') return 'interrupted';
        const durableHead = turnJournal.oldestNonterminal();
        if (
          durableHead?.state === 'started' &&
          durableHead.messageId !== turn.messageId &&
          sessionLog
        ) {
          await recoverAndProjectTurn(durableHead.messageId);
          if (hasResumableTurn(durableHead.messageId)) {
            const admission = turnJournal.admission(durableHead.messageId);
            if (!admission) throw new Error('recovered interaction lost its admission');
            await runOwnedTurn({ ...admission, cancelBarrier: null, modelStarted: true });
          }
          continue;
        }
        if (turn.cancelBarrier && (await turn.cancelBarrier)) {
          return removeCancelledTurn(turn.messageId);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        sessionLog?.assertWritable();
      }
      // A different process can complete a preceding durable turn at any time
      // after this worker boots. Reload Pi's tree before every durable model
      // start, otherwise this model can omit that remote answer.
      if (sessionLog) {
        await hydrateDurableState();
        // Hydration is a remote read and can outlive the complete owner-lease
        // interval. Revalidate after it finishes, at the last boundary before
        // model or tool execution. A replacement that reclaimed this turn
        // while the read was blocked must fence this worker out.
        if (!(await turnJournal.heartbeat(turn.messageId))) {
          throw new TurnOwnerLeaseLostError(`turn ${turn.messageId} lost its durable owner lease`);
        }
        if (!resumingInteraction && await rewindAcceptedInputForReplay(turn.messageId)) {
          await hydrateDurableState();
          if (!(await turnJournal.heartbeat(turn.messageId))) {
            throw new TurnOwnerLeaseLostError(`turn ${turn.messageId} lost its durable owner lease`);
          }
        }
      }
      if (closing) return 'interrupted';
      if (sessionLog && (resumingInteraction || turn.recovered)) {
        const lease = turnJournal.startedLease(turn.messageId);
        if (!lease?.ownerId) throw new TurnOwnerLeaseLostError('Recovered turn has no durable owner');
        try {
          await relayTurnResume({ opencodeSessionId: surface.rootId, messageId: turn.messageId, ownerId: lease.ownerId });
        } catch (error) {
          if (error instanceof TurnResumeRejectedError) {
            await turnJournal.requestAbort(turn.messageId, { ownLeaseOnly: true });
            await recoverAndProjectTurn(turn.messageId);
            return 'interrupted';
          }
          throw new SessionLogReadUnavailableError('Recovered turn authority is unavailable', { cause: error });
        }
        if (!(await turnJournal.heartbeat(turn.messageId))) {
          throw new TurnOwnerLeaseLostError('Recovered turn lost its owner during authority restoration');
        }
      }
      turn.modelStarted = turn.options.noReply !== true;
      // The at-most-once boundary committed above. A process that restarts with
      // this state interrupts model turns instead of replaying unknown tool
      // side effects. Context-only turns can finish storing their user input.
      if (turn.modelStarted && !turn.options.compaction && lazy && cfg.environmentStartup === 'prewarm') lazy.prewarm();
      surface.markTurn(turn.messageId, true);
      lastAgentEndStatus = 'idle';
      const heartbeatMs = Math.max(1, cfg.turnOwnerHeartbeatMs ?? DEFAULT_TURN_OWNER_HEARTBEAT_MS);
      let ownerLost = false;
      let settling = false;
      const leaseMs = Math.max(1, cfg.turnOwnerLeaseMs ?? DEFAULT_TURN_OWNER_LEASE_MS);
      let leaseDeadline = performance.now() + leaseMs;
      const expireLease = () => {
        if (settling || ownerLost) return;
        ownerLost = true;
        agent.abort();
      };
      let leaseTimer = setTimeout(expireLease, leaseMs);
      const renewLease = () => {
        if (ownerLost || performance.now() >= leaseDeadline) {
          expireLease();
          return;
        }
        leaseDeadline = performance.now() + leaseMs;
        clearTimeout(leaseTimer);
        leaseTimer = setTimeout(expireLease, leaseMs);
      };
      let heartbeatInFlight: Promise<void> | null = null;
      const heartbeatTimer = setInterval(() => {
        if (settling || ownerLost || heartbeatInFlight) return;
        const heartbeat = (async () => {
          try {
            if (!(await turnJournal.heartbeat(turn.messageId))) {
              expireLease();
            } else {
              renewLease();
            }
          } catch (error) {
            if (!(error instanceof SessionLogReadUnavailableError)) expireLease();
            console.error(
              JSON.stringify({
                msg: 'turn owner heartbeat failed',
                messageId: turn.messageId,
                error: String((error as Error)?.message ?? error),
              }),
            );
          }
        })();
        heartbeatInFlight = heartbeat;
        void heartbeat.finally(() => {
          if (heartbeatInFlight === heartbeat) heartbeatInFlight = null;
        });
      }, heartbeatMs);
      const abortPollMs = Math.max(1, cfg.turnAbortPollMs ?? DEFAULT_TURN_ABORT_POLL_MS);
      let abortPollInFlight: Promise<void> | null = null;
      const abortPollTimer = setInterval(() => {
        if (settling || ownerLost || abortPollInFlight) return;
        const poll = (async () => {
          try {
            await turnJournal.refresh();
            if (turnJournal.abortRequested(turn.messageId)) {
              agent.abort();
              await env.waitForAbortSettled();
              await turnJournal.acknowledgeAbort(turn.messageId);
            }
          } catch (error) {
            if (!(error instanceof SessionLogReadUnavailableError)) expireLease();
            console.error(
              JSON.stringify({
                msg: 'turn abort poll failed',
                messageId: turn.messageId,
                error: String((error as Error)?.message ?? error),
              }),
            );
          }
        })();
        abortPollInFlight = poll;
        void poll.finally(() => {
          if (abortPollInFlight === poll) abortPollInFlight = null;
        });
      }, abortPollMs);
      let completedDurably = false;
      const originalSystemPrompt = agent.state.systemPrompt;
      const originalThinkingLevel = agent.state.thinkingLevel;
      const originalTools = agent.state.tools;
      let toolReplay: ReturnType<typeof installToolReplay> | null = null;
      if (typeof turn.options.system === 'string' && turn.options.system) {
        agent.state.systemPrompt = [originalSystemPrompt, turn.options.system]
          .filter(Boolean)
          .join('\n');
      }
      try {
        if (typeof turn.options.variant === 'string') applyReasoningVariant(agent, turn.options.variant);
        await permissionApprovals.refresh();
        if (closing) return 'interrupted';
        agent.state.tools = originalTools.filter((tool) => permissions.toolEnabled(tool.name));
        const inputIndex = agent.state.messages.findLastIndex((message: any) => message.kortixWireMessageId === turn.messageId);
        structuredOutput.begin(turn.options.format as OutputFormat | undefined,
          inputIndex >= 0 ? agent.state.messages.slice(inputIndex) : []);
        const created = Number(
          (turn.wireUserMessage.info.time as { created?: unknown } | undefined)?.created ??
            Date.now(),
        );
        const userMessage = {
          role: 'user',
          content: attachmentUserContent(turn.text, turn.options.files),
          ...(turn.options.files ? { kortixWireUserParts: turn.wireUserMessage.parts } : {}),
          timestamp: Number.isFinite(created) ? created : Date.now(),
          // Persisted with Pi's own message entry. The restore projection uses
          // it instead of inventing a different wire id after every restart.
          kortixWireMessageId: turn.messageId,
          ...(turn.options.format === undefined ? {} : { kortixOutputFormat: turn.options.format }),
          ...(turn.options.compaction ? { kortixCompactionAuto: turn.options.compactionAuto === true } : {}),
        };
        if (turn.options.compaction === true) {
          lastAgentEndStatus = (await runContextCompaction(userMessage)).status;
        } else if (turn.options.noReply === true) {
          bootReconcile.noteTurnStarted();
          const durableSession = sessionRef();
          if (durableSession) await durableSession.appendMessage(toDurable(userMessage) as any);
          agent.state.messages = [...agent.state.messages, userMessage as any];
        } else if (resumingInteraction) {
          const checkpoint = resumableQuestions.get(turn.messageId);
          const stages = resumablePermissions.get(turn.messageId) ?? [];
          const plan = checkpoint
            ? planQuestionReplay(agent.state.messages, checkpoint)
            : planToolReplay(agent.state.messages, stages.at(-1)!);
          permissions.restoreCheckpoints(stages);
          permissions.restoreToolHistory(
            completedToolCalls(agent.state.messages.slice(0, plan.assistantIndex)),
          );
          toolReplay = installToolReplay(agent, plan,
            (name, input) => permissions.recordToolCall(name, input));
          setToolReplayEventHandler(toolReplay.normalizeEvent);
          resumeAgentSteps(plan.completedSteps);
          resumableQuestions.delete(turn.messageId);
          resumablePermissions.delete(turn.messageId);
          if (closing) return 'interrupted';
          await agent.continue();
        } else {
          let compactionFailure: any = null;
          if (needsContextCompaction(userMessage)) {
            const compacted = await runAutomaticContextCompaction();
            await turnJournal.refresh();
            if (
              compacted.status === "error" ||
              turnJournal.abortRequested(turn.messageId)
            ) {
              const summary = compacted.messages.at(-1);
              compactionFailure = {
                ...fauxAssistantMessage([], {
                  stopReason: turnJournal.abortRequested(turn.messageId)
                    ? "aborted"
                    : "error",
                  errorMessage:
                    summary?.errorMessage ?? "Context compaction was stopped",
                }),
                api: agent.state.model!.api,
                provider: agent.state.model!.provider,
                model: agent.state.model!.id,
                kortixWireMessageId: surface.mintMessageId(),
                kortixParentMessageId: turn.messageId,
              };
            }
          }
          if (compactionFailure) {
            agent.state.messages = [
              ...agent.state.messages,
              userMessage as any,
              compactionFailure,
            ];
            await persistCurrentMessages();
            surface.replaceDurableMessages(
              agent.state.messages,
              turnJournal.wireMessages,
            );
            lastAgentEndStatus = "error";
          } else {
            permissions.restoreToolHistory([]);
            if (closing) return 'interrupted';
            await agent.prompt(userMessage as any);
          }
        }
        const missingStructured = !turn.options.noReply && !turn.options.compaction ? structuredOutput.missingError() : null;
        if (missingStructured) {
          agent.state.messages.push({
            ...fauxAssistantMessage([], { stopReason: 'error', errorMessage: missingStructured.data.message }),
            kortixWireMessageId: surface.mintMessageId(),
            kortixParentMessageId: turn.messageId,
            kortixStructuredOutputError: missingStructured,
          } as any);
          await persistCurrentMessages();
          surface.replaceDurableMessages(agent.state.messages, turnJournal.wireMessages);
          lastAgentEndStatus = 'error';
        }
        settling = true;
        clearTimeout(leaseTimer);
        clearInterval(heartbeatTimer);
        clearInterval(abortPollTimer);
        await heartbeatInFlight;
        await abortPollInFlight;
        await turnJournal.refresh();
        if (turnJournal.abortRequested(turn.messageId)) {
          agent.abort();
          await env.waitForAbortSettled();
          if (!(await turnJournal.acknowledgeAbort(turn.messageId))) {
            throw new TurnOwnerLeaseLostError(`turn ${turn.messageId} lost its durable owner lease`);
          }
          lastAgentEndStatus = 'error';
        }
        if (ownerLost) {
          throw new TurnOwnerLeaseLostError(`turn ${turn.messageId} lost its durable owner lease`);
        }
        const assistant = toDurable(
          surface.assistantMessagesForParent(turn.messageId),
        ) as unknown as WireMessageEnvelope[];
        let completed = await turnJournal.complete(turn.messageId, assistant, lastAgentEndStatus);
        if (!completed) {
          await turnJournal.refresh();
          if (turnJournal.abortRequested(turn.messageId)) {
            agent.abort();
            await env.waitForAbortSettled();
            if (!(await turnJournal.acknowledgeAbort(turn.messageId))) {
              throw new TurnOwnerLeaseLostError(`turn ${turn.messageId} lost its durable owner lease`);
            }
            lastAgentEndStatus = 'error';
            completed = await turnJournal.complete(turn.messageId, assistant, lastAgentEndStatus);
          }
        }
        if (!completed) {
          throw new TurnOwnerLeaseLostError(`turn ${turn.messageId} lost its durable owner lease`);
        }
        completedDurably = true;
        // Start bookkeeping only after the terminal journal record commits.
        // A successful relay gets its own durable marker. A process that dies
        // between completion and relay leaves the turn in `unrelayed`, which
        // the next worker drains by exact message id.
        relayDrain.wake();
      } finally {
        structuredOutput.end();
        setToolReplayEventHandler(null);
        toolReplay?.close();
        permissions.restoreCheckpoints([]);
        agent.state.systemPrompt = originalSystemPrompt;
        agent.state.thinkingLevel = originalThinkingLevel;
        agent.state.tools = originalTools;
        settling = true;
        clearTimeout(leaseTimer);
        clearInterval(heartbeatTimer);
        clearInterval(abortPollTimer);
        await heartbeatInFlight;
        await abortPollInFlight;
        if (sessionLog && !completedDurably) {
          try {
            await hydrateDurableState();
          } catch (error) {
            console.error(
              JSON.stringify({
                msg: 'durable transcript reconciliation failed after turn error',
                messageId: turn.messageId,
                error: String((error as Error)?.message ?? error),
              }),
            );
          }
        }
        surface.markTurn(turn.messageId, false);
        const busy = turnJournal.oldestNonterminal() !== null;
        surface.publishWire({
          type: 'session.status',
          properties: { sessionID: surface.rootId, status: { type: busy ? 'busy' : 'idle' } },
        });
        if (!busy) surface.publishWire({ type: 'session.idle', properties: { sessionID: surface.rootId } });
      }
    },
  });

  const queueAdmission = (admission: TurnAdmission, recovered = false): Promise<TurnCompletion> => {
    const retry = admissionRetries.get(admission.messageId);
    if (retry) clearTimeout(retry);
    admissionRetries.delete(admission.messageId);
    const existing = turns.get(admission.messageId);
    if (existing) return turnQueue.enqueue(existing).done;
    const turn: WorkerTurn = {
      ...admission,
      cancelBarrier: null,
      modelStarted: false,
      recovered,
    };
    turns.set(turn.messageId, turn);
    const queued = turnQueue.enqueue(turn);
    void queued.done.then(
      () => turns.delete(turn.messageId),
      (error) => {
        turns.delete(turn.messageId);
        if (
          closing ||
          !sessionLog ||
          (sessionLog.error && !sessionLog.canRecoverPendingAppends) ||
          !(error instanceof SessionLogReadUnavailableError ||
            error instanceof TurnOwnerLeaseLostError ||
            sessionLog.canRecoverPendingAppends) ||
          !['pending', 'started'].includes(turnJournal.state(turn.messageId))
        ) return;
        const delay = Math.max(1, Math.min(1000, cfg.turnOwnerHeartbeatMs ?? DEFAULT_TURN_OWNER_HEARTBEAT_MS));
        let interruptRecoveredTurn = sessionLog.canRecoverPendingAppends;
        const schedule = () => {
          const timer = setTimeout(async () => {
            admissionRetries.delete(turn.messageId);
            if (closing) return;
            if (sessionLog.error) {
              const recovered = await sessionLog.recoverPendingAppends();
              console.error(JSON.stringify({
                msg: 'turn storage recovery', messageId: turn.messageId,
                recovered, retryable: sessionLog.canRecoverPendingAppends,
              }));
              if (!recovered) {
                if (!closing && sessionLog.canRecoverPendingAppends) schedule();
                return;
              }
            }
            if (closing) return;
            if (interruptRecoveredTurn) {
              try {
                await turnJournal.requestAbort(turn.messageId, { ownLeaseOnly: true });
                interruptRecoveredTurn = false;
              } catch (error) {
                console.error(JSON.stringify({ msg: 'recovered turn interruption failed', messageId: turn.messageId, error: String(error) }));
                if (!closing && (!sessionLog.error || sessionLog.canRecoverPendingAppends)) schedule();
                return;
              }
            }
            const current = turnJournal.admission(turn.messageId);
            if (current) queueAdmission(current, turn.recovered);
          }, delay);
          timer.unref();
          admissionRetries.set(turn.messageId, timer);
        };
        schedule();
      },
    );
    return queued.done;
  };

  const makeAdmission = (
    text: string,
    explicitId: string | undefined,
    options: PromptOptions,
  ): TurnAdmission => {
    const messageId = explicitId ?? surface.mintMessageId();
    const created = Date.now();
    return {
      messageId,
      text,
      options: admissionOptions(options),
      wireUserMessage: {
        info: {
          id: messageId,
          role: 'user',
          sessionID: surface.rootId,
          time: { created },
          agent: runtimeAgent,
          model: effectiveRuntime.model ?? resolvedModel,
          ...(options.system === undefined ? {} : { system: options.system }),
          ...(options.format === undefined ? {} : { format: options.format as unknown as JsonObject }),
          ...((options.variant ?? configuredVariant) === undefined ? {} : { variant: (options.variant ?? configuredVariant)! }),
          ...(options.tools === undefined ? {} : { tools: options.tools }),
        },
        parts: [
          {
            id: `${messageId}-p0`,
            messageID: messageId,
            sessionID: surface.rootId,
            ...(options.compaction ? { type: 'compaction', auto: options.compactionAuto === true } : { type: 'text', text }),
          },
          ...(options.files ?? []).map((file, index) => ({ ...file, id: `${messageId}-p${index + 1}`, messageID: messageId, sessionID: surface.rootId,
            url: `/kortix/part/${surface.rootId}/${messageId}/${messageId}-p${index + 1}` })),
        ],
      },
    };
  };

  type AdmittedTurn = {
    admission: TurnAdmission;
    done: Promise<TurnCompletion>;
    state: string;
  };
  const admissionFlights = new Map<string, Promise<AdmittedTurn>>();
  const assertSameAdmission = (admission: TurnAdmission, text: string, options: PromptOptions): void => {
    if (admission.text !== text || !isDeepStrictEqual(admission.options, admissionOptions(options))) {
      throw new TurnAdmissionConflictError(admission.messageId);
    }
  };

  const admitTurnCore = async (
    text: string,
    explicitId: string | undefined,
    options: PromptOptions,
    signal: AbortSignal,
  ): Promise<AdmittedTurn> => {
    signal.throwIfAborted();
    sessionLog?.assertWritable();
    if (sessionLog) {
      const durable = await turnJournal.refresh();
      surface.seedWireMessages(durable.wireMessages);
    }
    // Delivery retries reuse messageID. Reuse the first durable envelope too:
    // rebuilding it would stamp a new creation time and turn a valid retry
    // into a conflicting admission. Different content under one identity fails
    // closed instead of executing two logical inputs as one message.
    const persisted = explicitId ? turnJournal.admission(explicitId) : null;
    if (persisted) {
      assertSameAdmission(persisted, text, options);
      const state = turnJournal.state(persisted.messageId);
      if (state === 'completed') await hydrateDurableState();
      return {
        admission: persisted,
        done:
          state === 'pending' || turns.has(persisted.messageId)
            ? queueAdmission(persisted)
            : state === 'started'
              ? waitForRemoteTurn(persisted.messageId)
              : Promise.resolve(state === 'cancelled' ? 'cancelled' : 'completed'),
        state,
      };
    }

    if (explicitId && !surface.canAdmitMessageId(explicitId)) {
      throw new TurnMessageOrderError();
    }

    if (options.files?.length) {
      if (!agent.state.model?.input.includes('image')) throw new AttachmentInputError('the selected model does not accept image attachments');
      await attachments.validate(options.files, signal);
    }
    signal.throwIfAborted();
    if (closing) throw new TurnAdmissionStoppedError();
    const admission = makeAdmission(text, explicitId, options);
    let accepted: boolean;
    try {
      accepted = await turnJournal.accept(admission);
    } catch (error) {
      if (error instanceof TurnJournalAdmissionConflictError) {
        throw new TurnAdmissionConflictError(admission.messageId);
      }
      if (error instanceof TurnJournalMessageOrderError) throw new TurnMessageOrderError();
      throw error;
    }
    if (accepted) {
      // A 204 is emitted only after the append above commits. Publish after
      // durability so an observer cannot see input that admission later loses.
      surface.observeMessageId(admission.messageId);
      publishUserMessage(admission);
      return { admission, done: queueAdmission(admission), state: 'pending' };
    }

    await hydrateDurableState();
    const persistedAdmission = turnJournal.admission(admission.messageId);
    if (!persistedAdmission) {
      throw new Error(`turn ${admission.messageId} lost admission without durable state`);
    }
    assertSameAdmission(persistedAdmission, text, options);
    const state = turnJournal.state(admission.messageId);
    if (state === 'pending') {
      return {
        admission: persistedAdmission,
        done: queueAdmission(persistedAdmission),
        state,
      };
    }
    return {
      admission: persistedAdmission,
      done:
        state === 'started'
          ? waitForRemoteTurn(admission.messageId)
          : Promise.resolve(state === 'cancelled' ? 'cancelled' : 'completed'),
      state,
    };
  };

  let admissionMutationTail: Promise<void> = Promise.resolve();
  const serializeAdmission = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = admissionMutationTail.then(operation, operation);
    admissionMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const pendingAdmissions = new Set<AbortController>();
  stopPendingAdmissions = async () => {
    for (const controller of pendingAdmissions) controller.abort(new TurnAdmissionStoppedError());
    await admissionMutationTail;
  };
  const prepareAdmission = (text: string, explicitId: string | undefined, options: PromptOptions) => {
    const controller = new AbortController();
    pendingAdmissions.add(controller);
    return serializeAdmission(() => admitTurnCore(text, explicitId, options, controller.signal))
      .finally(() => pendingAdmissions.delete(controller));
  };

  const admitTurn = async (
    text: string,
    explicitId?: string,
    options: PromptOptions = {},
  ): Promise<AdmittedTurn> => {
    if (!explicitId) return prepareAdmission(text, undefined, options);
    const active = admissionFlights.get(explicitId);
    if (active) {
      const admitted = await active;
      assertSameAdmission(admitted.admission, text, options);
      return admitted;
    }
    const operation = prepareAdmission(text, explicitId, options);
    admissionFlights.set(explicitId, operation);
    try {
      return await operation;
    } finally {
      if (admissionFlights.get(explicitId) === operation) admissionFlights.delete(explicitId);
    }
  };

  deleteAdmittedTurn = (messageId) =>
    serializeAdmission(async () => {
      const turn = turns.get(messageId);
      if (turn?.modelStarted) return 'running';

      // The prompt can have been admitted through another live worker. The
      // durable journal, not this process's `turns` map, owns cancellation.
      // `cancel()` reloads the shared log before it appends its transition, so
      // a remote start that wins this race returns `running` instead of a false
      // local 404.
      const cancellation = turn?.cancelBarrier ?? turnJournal.cancel(messageId);
      if (turn && !turn.cancelBarrier) turn.cancelBarrier = cancellation;
      const cancelled = await cancellation;
      if (!cancelled) {
        const state = turnJournal.state(messageId);
        return turn?.modelStarted || state === 'started' ? 'running' : 'missing';
      }

      // If drain has not selected a local copy, remove it now. If drain
      // selected it while the journal append was in flight, its run callback
      // awaits the same barrier and returns before calling the model.
      turnQueue.cancel(messageId);
      return 'deleted';
    });

  // Replay accepted, non-terminal turns in durable acceptance order. Their
  // exact user envelopes were seeded above; old data is not emitted as news.
  for (const admission of turnJournal.started) {
    if (hasResumableTurn(admission.messageId)) queueAdmission(admission, true);
  }
  for (const admission of turnJournal.pending) queueAdmission(admission, true);

  const runTurn = async (text: string, opts?: { userMessageId?: string }) => {
    const admitted = await admitTurn(text, opts?.userMessageId);
    return admitted.done;
  };
  const compiledCommands = new Map(
    (compiledPayload?.commands ?? []).map((command) => [command.name, command]),
  );

  const promptCompletionHeaders = (messageId: string): Record<string, string> => {
    const status = sessionLog ? turnJournal.completionStatus(messageId) : null;
    return status
      ? {
          'x-kortix-prompt-message-id': messageId,
          'x-kortix-prompt-completed': status,
        }
      : {};
  };

  activate(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (sessionLog) res.setHeader('x-kortix-prompt-admission', 'durable-message-id-v1');
    if (url.pathname.startsWith('/kortix/part/') && req.method === 'GET') {
      if (!surface.authorize(req, url)) { res.writeHead(401).end(); return; }
      const match = url.pathname.match(/^\/kortix\/part\/([^/]+)\/([^/]+)\/([^/]+)$/);
      const admission = match && match[1] === surface.rootId ? turnJournal.admission(match[2]!) : null;
      const index = admission?.wireUserMessage.parts.findIndex(part => part.id === match?.[3]) ?? -1;
      const message = match && match[1] === surface.rootId ? surface.transcript.messageById(match[2]!) : null;
      const visible = message?.parts.some((part: any) => part.id === match?.[3] ||
        (part.type === 'tool' && part.state?.status === 'completed' && part.state.attachments?.some((file: any) => file.id === match?.[3])));
      const file = index > 0 ? (admission?.options.files as unknown as PromptAttachment[] | undefined)?.[index - 1] : attachments.referenceForPart(url.pathname);
      if (!file || !visible) { res.writeHead(404).end(); return; }
      try {
        const bytes = await attachments.read(file);
        res.writeHead(200, { 'content-type': file.mime, 'content-length': String(bytes.length), 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', etag: `"${attachmentDigest(file.url)}"`, vary: 'Authorization, Cookie' }).end(bytes);
      } catch { res.writeHead(503).end(); }
      return;
    }


    if (url.pathname.startsWith('/kortix/opencode/')) {
      if (surface.handle(req, res, url)) return;
    }
    if (
      url.pathname === '/global/event' ||
      url.pathname === '/global/config' ||
      url.pathname === '/config' ||
      url.pathname === '/lsp/diagnostics' ||
      url.pathname === '/agent' ||
      url.pathname === '/command' ||
      url.pathname === '/skill' ||
      url.pathname === '/tool' ||
      url.pathname === '/tool/ids' ||
      url.pathname === '/experimental/tool' ||
      url.pathname === '/experimental/tool/ids' ||
      url.pathname === '/permission' ||
      url.pathname.startsWith('/permission/') ||
      url.pathname === '/question' ||
      url.pathname.startsWith('/question/') ||
      url.pathname === '/session' ||
      url.pathname.startsWith('/session/')
    ) {
      const summarizeRoute = url.pathname.match(/^\/session\/([^/]+)\/summarize$/);
      if (summarizeRoute && req.method === 'POST') {
        if (!surface.authorize(req, url)) {
          res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const target = decodePathSegment(summarizeRoute[1]!);
        if (target !== surface.rootId) {
          res.writeHead(target === null ? 400 : 404, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: target === null ? 'malformed session id' : 'unknown session' }));
          return;
        }
        try {
          const input = JSON.parse(await readBoundedRequestBody(req));
          if (!input || typeof input !== 'object' || Array.isArray(input))
            throw new RequestBodyValidationError('request body must be a JSON object');
          if (Object.keys(input).some(key => !['providerID', 'modelID', 'auto', 'messageID'].includes(key)))
            throw new RequestBodyValidationError('unsupported compaction option');
          const identity = effectiveRuntime.model ?? resolvedModel;
          if (input.providerID !== identity.providerID || input.modelID !== identity.modelID)
            throw new RequestBodyValidationError('compaction must use the configured session model');
          if (input.auto !== undefined && typeof input.auto !== 'boolean')
            throw new RequestBodyValidationError('auto must be a boolean');
          if (input.messageID !== undefined && (typeof input.messageID !== 'string' || !input.messageID.trim()))
            throw new RequestBodyValidationError('messageID must be a non-empty string');
          for (const key of ['directory', 'workspace']) {
            if (url.searchParams.getAll(key).some(value => value !== cfg.envCwd))
              throw new RequestBodyValidationError('compaction workspace must equal the session workspace');
          }
          if (modelError || !sessionRef()) {
            res.writeHead(503, { 'content-type': 'application/json' })
              .end(JSON.stringify({ error: modelError ?? 'context compaction requires durable session storage' }));
            return;
          }
          const admitted = await admitTurn('Compact conversation context.', input.messageID, { compaction: true, compactionAuto: input.auto === true });
          await admitted.done;
          const completed = turnJournal.completionStatus(admitted.admission.messageId);
          if (completed !== 'idle') {
            res.writeHead(409, { 'content-type': 'application/json' })
              .end(JSON.stringify({ error: 'context compaction did not complete; the conversation is preserved' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json', ...promptCompletionHeaders(admitted.admission.messageId) }).end('true');
        } catch (error) {
          const code = error instanceof RequestBodyTooLargeError ? 413
            : error instanceof SyntaxError || error instanceof RequestBodyValidationError ? 400
            : error instanceof TurnAdmissionConflictError || error instanceof TurnMessageOrderError ? 409 : 503;
          res.writeHead(code, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: String((error as Error)?.message ?? error) }));
        }
        return;
      }
      if (surface.handleRawSessionList(req, res, url)) return;
    }

    // ── OpenCode project command route ─────────────────────────────────────
    // Commands are compiled into this artifact at the session's exact Git SHA.
    // The worker never reads a moving branch or scans the environment for them.
    {
      const commandRoute = url.pathname.match(/^\/session\/([^/]+)\/command$/);
      if (commandRoute && req.method === 'POST') {
        if (!surface.authorize(req, url)) {
          res
            .writeHead(401, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const sessionId = decodePathSegment(commandRoute[1]!);
        if (sessionId === null) {
          res
            .writeHead(400, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: 'path contains malformed percent-encoding' }));
          return;
        }
        if (sessionId !== surface.rootId) {
          res
            .writeHead(404, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: 'unknown session' }));
          return;
        }
        const commandWorkspaces = [
          ...url.searchParams.getAll('directory'),
          ...url.searchParams.getAll('workspace'),
        ];
        if (commandWorkspaces.some((workspace) => workspace !== cfg.envCwd)) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              error: 'command workspace must equal the compiled environment workspace',
            }),
          );
          return;
        }
        try {
          const body = JSON.parse(await readBoundedRequestBody(req)) as unknown;
          if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw new RequestBodyValidationError('request body must be a JSON object');
          }
          const input = body as Record<string, unknown>;
          if (typeof input.command !== 'string' || !input.command) {
            throw new RequestBodyValidationError('command must be a non-empty string');
          }
          if (input.arguments !== undefined && typeof input.arguments !== 'string') {
            throw new RequestBodyValidationError('arguments must be a string');
          }
          const argumentsText = input.arguments ?? '';
          if (input.messageID !== undefined && typeof input.messageID !== 'string') {
            throw new RequestBodyValidationError('messageID must be a string');
          }
          for (const field of ['agent', 'model', 'variant', 'subtask'] as const) {
            if (!Object.hasOwn(input, field)) continue;
            if (
              field === 'agent' &&
              typeof input.agent === 'string' &&
              input.agent &&
              input.agent === effectiveRuntime.agent
            ) continue;
            if (field === 'model' && runtimeModel && input.model === runtimeModel) continue;
            if (field === 'variant' && typeof input.variant === 'string' &&
              effectiveRuntime.variants?.includes(input.variant)) continue;
            res.writeHead(409, { 'content-type': 'application/json' }).end(
              JSON.stringify({
                code: 'PI_COMMAND_RUNTIME_OVERRIDE_UNSUPPORTED',
                error: `Pi command request field "${field}" is not supported by the compiled session runtime`,
                field,
              }),
            );
            return;
          }
          const command = compiledCommands.get(input.command);
          if (!command) {
            res.writeHead(404, { 'content-type': 'application/json' }).end(
              JSON.stringify({
                code: 'PI_COMMAND_NOT_FOUND',
                error: `Command not found: "${input.command}".`,
              }),
            );
            return;
          }
          if (
            Object.hasOwn(input, 'parts') &&
            (!Array.isArray(input.parts) || input.parts.length > 0)
          ) {
            const error = new PiCommandUnsupportedError('file parts', command.name);
            res.writeHead(422, { 'content-type': 'application/json' }).end(
              JSON.stringify({ code: error.code, error: error.message, feature: error.feature }),
            );
            return;
          }
          const selectedCommand = {
            ...command,
            ...(typeof input.variant === 'string' ? { variant: input.variant } : {}),
          };
          const prompt = preparePiCommand(selectedCommand, argumentsText, effectiveRuntime);
          const admitted = await admitTurn(prompt, input.messageID as string | undefined, {
            ...(selectedCommand.variant !== undefined ? { variant: selectedCommand.variant } : {}),
          });
          const completion = await admitted.done;
          if (completion === 'cancelled') {
            res
              .writeHead(409, { 'content-type': 'application/json' })
              .end(JSON.stringify({ error: 'command was cancelled before execution' }));
            return;
          }
          if (completion === 'interrupted') {
            res.writeHead(409, { 'content-type': 'application/json' }).end(
              JSON.stringify({
                error:
                  'command outcome is unknown after restart; run it again only after checking its effects',
              }),
            );
            return;
          }
          const assistant = surface.assistantMessagesForParent(admitted.admission.messageId);
          const last = assistant.at(-1);
          if (!last) {
            res
              .writeHead(500, { 'content-type': 'application/json' })
              .end(JSON.stringify({ error: 'command completed without an assistant message' }));
            return;
          }
          surface.publishWire({
            type: 'command.executed',
            properties: {
              name: command.name,
              sessionID: surface.rootId,
              arguments: argumentsText,
              messageID: last.info.id,
            },
            busOnly: true,
          });
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(last));
        } catch (error) {
          const unsupported = error instanceof PiCommandUnsupportedError;
          const conflict =
            error instanceof TurnAdmissionConflictError || error instanceof TurnMessageOrderError || error instanceof TurnAdmissionStoppedError;
          const tooLarge =
            error instanceof RequestBodyTooLargeError || error instanceof SessionLogItemTooLargeError;
          const invalid =
            error instanceof SyntaxError || error instanceof RequestBodyValidationError;
          res
            .writeHead(unsupported ? 422 : conflict ? 409 : tooLarge ? 413 : invalid ? 400 : 503, {
              'content-type': 'application/json',
              ...(tooLarge ? { connection: 'close' } : {}),
            })
            .end(
              JSON.stringify(
                unsupported
                  ? { code: error.code, error: error.message, feature: error.feature }
                  : { error: String((error as Error)?.message ?? error) },
              ),
              tooLarge ? () => req.destroy() : undefined,
            );
        }
        return;
      }
    }

    // ── OpenCode prompt routes ──────────────────────────────────────────────
    // The API's session lifecycle delivers EVERY composer send and queued
    // prompt with POST /session/:rootId/prompt_async (engine.ts postPrompt),
    // NOT the worker's own /say|/turn. OpenCode answers 204 and runs the turn
    // in the background, streaming events; the worker matches that contract, so
    // a send reaches the pi agent and the response streams back through the
    // /events SSE. Without this route the prompt 404s, the delivery loop retries
    // to `pending`, and the composer's Stop button spins forever with no reply.
    {
      const m = url.pathname.match(/^\/session\/([^/]+)\/(prompt_async|message)$/);
      if (m && req.method === 'POST') {
        // Auth FIRST, and before the session-id probe: an unauthenticated
        // caller must not be able to distinguish "wrong session" from "right
        // session" on this box. This route runs the agent with bash/read/
        // write/edit/glob/grep against the session's environment and secrets; every
        // `/kortix/opencode/*` sibling has always been gated and this one was
        // not, purely because it is served here rather than by RuntimeSurface.
        if (!surface.authorize(req, url)) {
          res
            .writeHead(401, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const sid = decodePathSegment(m[1]!);
        if (sid === null) {
          res
            .writeHead(400, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: 'path contains malformed percent-encoding' }));
          return;
        }
        if (sid !== surface.rootId) {
          res
            .writeHead(404, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: 'unknown session' }));
          return;
        }
        const promptWorkspaces = [
          ...url.searchParams.getAll('directory'),
          ...url.searchParams.getAll('workspace'),
        ];
        if (promptWorkspaces.some((workspace) => workspace !== cfg.envCwd)) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              error: 'prompt workspace must equal the compiled environment workspace',
            }),
          );
          return;
        }
        let bodyChunks: Buffer[] = [];
        let bodyBytes = 0;
        let bodyTooLarge = false;
        const rejectPromptBody = () => {
          if (bodyTooLarge) return;
          bodyChunks = [];
          bodyTooLarge = true;
          res
            .writeHead(413, {
              'content-type': 'application/json',
              connection: 'close',
            })
            .end(
              JSON.stringify({
                error: `prompt body exceeds ${MAX_SESSION_LOG_ITEM_BYTES} bytes`,
              }),
              () => req.destroy(),
            );
          req.resume();
        };
        const declaredBodyBytes = Number(req.headers['content-length']);
        if (Number.isFinite(declaredBodyBytes) && declaredBodyBytes > MAX_SESSION_LOG_ITEM_BYTES) {
          rejectPromptBody();
          return;
        }
        req.on('data', (chunk) => {
          if (bodyTooLarge) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bodyBytes += bytes.byteLength;
          if (bodyBytes > MAX_SESSION_LOG_ITEM_BYTES) {
            rejectPromptBody();
            return;
          }
          bodyChunks.push(bytes);
        });
        req.on('end', async () => {
          if (bodyTooLarge) return;
          const body = Buffer.concat(bodyChunks, bodyBytes).toString('utf8');
          const parsed = parsePromptInput(body, effectiveRuntime);
          if (!parsed.ok) {
            res
              .writeHead(400, { 'content-type': 'application/json' })
              .end(JSON.stringify({ error: parsed.error }));
            return;
          }
          try {
            const admitted = await admitTurn(parsed.value.text, parsed.value.messageID, {
              system: parsed.value.system,
              noReply: parsed.value.noReply,
              tools: parsed.value.tools,
              variant: parsed.value.variant,
              format: parsed.value.format,
              files: parsed.value.files,
            });
            if (admitted.state === 'cancelled') {
              res.writeHead(409, { 'content-type': 'application/json' }).end(
                JSON.stringify({ error: 'message was cancelled before execution' }),
              );
              return;
            }
            if (m[2] === 'prompt_async') {
              // The acceptance append has committed. Execution continues on
              // the serial queue and all output arrives over the event stream.
              res.writeHead(204, promptCompletionHeaders(admitted.admission.messageId)).end();
              void admitted.done.catch((error) =>
                console.error(
                  JSON.stringify({
                    msg: 'prompt_async turn failed',
                    messageId: admitted.admission.messageId,
                    error: String((error as Error)?.message ?? error),
                  }),
                ),
              );
              return;
            }

            const completion = await admitted.done;
            if (completion === 'cancelled') {
              res
                .writeHead(409, { 'content-type': 'application/json' })
                .end(JSON.stringify({ error: 'message was cancelled before execution' }));
              return;
            }
            if (completion === 'interrupted') {
              res.writeHead(409, { 'content-type': 'application/json' }).end(
                JSON.stringify({
                  error:
                    'turn outcome is unknown after restart; send a new message with a new messageID',
                }),
              );
              return;
            }
            if (admitted.admission.options.noReply === true) {
              res.writeHead(200, {
                'content-type': 'application/json',
                ...promptCompletionHeaders(admitted.admission.messageId),
              }).end(
                JSON.stringify(admitted.admission.wireUserMessage),
              );
              return;
            }
            const assistant = surface.assistantMessagesForParent(admitted.admission.messageId);
            const last = assistant[assistant.length - 1];
            if (!last) {
              res
                .writeHead(500, { 'content-type': 'application/json' })
                .end(JSON.stringify({ error: 'turn completed without an assistant message' }));
              return;
            }
            res.writeHead(200, {
              'content-type': 'application/json',
              ...promptCompletionHeaders(admitted.admission.messageId),
            }).end(JSON.stringify(last));
          } catch (error) {
            const conflict =
              error instanceof TurnAdmissionConflictError || error instanceof TurnMessageOrderError || error instanceof TurnAdmissionStoppedError;
            const tooLarge = error instanceof SessionLogItemTooLargeError;
            res
              .writeHead(error instanceof AttachmentInputError ? 400 : conflict ? 409 : tooLarge ? 413 : 503, {
                'content-type': 'application/json',
              })
              .end(
                JSON.stringify({
                  error: conflict
                    ? String((error as Error).message)
                    : tooLarge
                      ? String((error as Error).message)
                      : `turn admission failed: ${String((error as Error)?.message ?? error)}`,
                }),
              );
          }
        });
        return;
      }
    }

    // ── Platform compatibility surface ─────────────────────────────────────
    // The session lifecycle (start envelope, wake fences, env fan-out) speaks
    // kortixd's /kortix/* contract. The worker answers just enough of it that
    // a pi session reads as ready without a daemon in the box.
    if (url.pathname === '/kortix/health') {
      const compiled = (globalThis as Record<string, unknown>).__KORTIX_COMPILED__ as
        | { manifest?: { agent_config_etag?: string | null; source_sha?: string; ref?: string } }
        | undefined;
      // Turn probe: the API's turn-lifecycle polls ?turn=1 to renew the box's
      // deadline while a turn runs and to settle it when done. Answer from the
      // surface's live turn state so the reaper never stops the box mid-turn.
      const turnProbe =
        url.searchParams.get('turn') === '1'
          ? surface.turnProbe(url.searchParams.get('turn_message_id')?.trim() || null)
          : null;
      const activeStoreError = sessionLog?.error?.message ?? storeError;
      const body = JSON.stringify({
        daemon: activeStoreError ? 'error' : 'ok',
        status: activeStoreError ? 'error' : 'ok',
        runtimeReady: !activeStoreError,
        workload: 'session',
        opencode: activeStoreError ? 'error' : 'ok',
        engine: 'pi',
        uptime_s: Math.floor((Date.now() - BOOT_T0) / 1000),
        repo_required: false,
        repo_ready: true,
        boot_error: activeStoreError,
        // null = the transcript is durable. A string means this session is
        // answering but its history will NOT survive the process.
        store_error: activeStoreError,
        // Which provider is actually answering, and why if it is not the real
        // one. `model_error` mirrors `store_error`: null = fine, a string means
        // this session answers but the answers are worthless.
        model_mode: modelError ? 'faux' : cfg.modelMode,
        model_error: modelError,
        model_context_window: agent.state.model?.contextWindow || null,
        model_max_output: agent.state.model?.maxTokens ?? null,
        // The pi worker has no OpenCode store to pin — the start path must not
        // wait for one.
        opencode_session_id: surface.rootId,
        opencode_session_required: false,
        agent_config_etag: compiled?.manifest?.agent_config_etag ?? null,
        commit_sha: compiled?.manifest?.source_sha ?? null,
        branch: compiled?.manifest?.ref ?? null,
        boot_timeline: [{ label: 'worker-listening', atMs: LISTEN_MS ?? 0 }],
        runtime: { build: null, at: null, components: {}, agentSwapPending: false, pinned: false },
        ...(turnProbe ?? {}),
      });
      res.writeHead(200, { 'content-type': 'application/json' }).end(body);
      return;
    }

    // Env fan-out and config refresh land here on secret writes and reloads.
    // Acknowledged, not applied: a pi worker's config is immutable per artifact
    // — a new commit compiles a new artifact. Refusing (non-200) would surface
    // every flagged session as a sync failure in the fan-out's logs.
    if (
      (url.pathname === '/kortix/env' || url.pathname === '/kortix/refresh') &&
      req.method === 'POST'
    ) {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: true, changed: false, engine: 'pi' }));
      return;
    }

    if (url.pathname === '/health') {
      const activeStoreError = sessionLog?.error?.message ?? storeError;
      const body = JSON.stringify({
        ok: !activeStoreError,
        // Requirement 8, observable from outside: true when this process runs
        // under node's permission model with fs writes denied (the entrypoint
        // and park.mjs both start it that way — piWorkerNodeArgs in the API's
        // build-context.ts). `process.permission` exists only under
        // --permission, so a worker started bare reports false, honestly.
        confined: isConfined(),
        bootMs: LISTEN_MS,
        processAgeMs: Date.now() - BOOT_T0,
        vmUptimeAtListenMs: LISTEN_UPTIME_MS,
        vmUptimeNowMs: vmUptimeMs(),
        modelMode: cfg.modelMode,
        storeError: activeStoreError,
        environment:
          env instanceof LazyKortixEnv
            ? {
                mode: 'lazy',
                attached: env.attached,
                external_id: env.externalId,
                cwd: cfg.envCwd,
                rpcCalls: env.calls.length,
              }
            : { mode: 'url', url: cfg.envUrl, cwd: cfg.envCwd, rpcCalls: env.calls.length },
        store: cfg.storeUrl
          ? { url: cfg.storeUrl, sessionId: cfg.sessionId, restoredEntries }
          : null,
      });
      res.writeHead(200, { 'content-type': 'application/json' }).end(body);
      return;
    }

    if (url.pathname === '/events') {
      if (surface.requiresAuth() && !surface.authorize(req, url)) {
        res
          .writeHead(401, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const send = (c: string) => res.write(c);
      listeners.add(send);
      req.on('close', () => listeners.delete(send));
      return;
    }

    if (
      cfg.projectId &&
      req.method === 'POST' &&
      (url.pathname === '/prompt' || url.pathname === '/turn' || url.pathname === '/say')
    ) {
      res
        .writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'benchmark routes are disabled in deployed workers' }));
      return;
    }

    if (url.pathname === '/prompt' && req.method === 'POST') {
      if (surface.requiresAuth() && !surface.authorize(req, url)) {
        res
          .writeHead(401, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      try {
        const body = await readBoundedRequestBody(req);
        const { text, script } = parseBenchmarkPromptBody(body, true);
        // The faux provider is scripted per prompt so a test can drive an
        // exact tool call without a model in the loop. Compact wire form:
        //   [{ "tool": "write", "args": {...} }, { "text": "done" }]
        if (faux && Array.isArray(script)) {
          setFauxScriptResponses(faux, script);
        }
        await runTurn(text);
        const result = { messages: agent.state.messages.length };
        const payload = JSON.stringify({
          ok: true,
          result,
          rpcCalls: env.calls.map((c) => c.op),
        });
        res.writeHead(200, { 'content-type': 'application/json' }).end(payload);
      } catch (e: any) {
        const status =
          e instanceof RequestBodyTooLargeError
            ? 413
            : e instanceof SyntaxError || e instanceof RequestBodyValidationError
              ? 400
              : 500;
        const payload = JSON.stringify({ ok: false, error: String(e?.message ?? e) });
        res
          .writeHead(status, {
            'content-type': 'application/json',
            ...(status === 413 ? { connection: 'close' } : {}),
          })
          .end(payload, status === 413 ? () => req.destroy() : undefined);
      }
      return;
    }

    // Streaming turn. The benchmark measures time-to-first-token off the first
    // chunk that carries assistant text, which is what a user actually waits
    // for — not when the turn finishes.
    if (url.pathname === '/turn' && req.method === 'POST') {
      if (surface.requiresAuth() && !surface.authorize(req, url)) {
        res
          .writeHead(401, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      try {
        const body = await readBoundedRequestBody(req);
        const { text, script } = parseBenchmarkPromptBody(body, true);
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        if (faux && Array.isArray(script)) {
          setFauxScriptResponses(faux, script);
        }
        const unsub = agent.subscribe((event: any) => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        });
        try {
          await runTurn(text);
          res.write(
            `event: done\ndata: ${JSON.stringify({ rpcCalls: env.calls.map((c) => c.op) })}\n\n`,
          );
        } catch (e: any) {
          res.write(
            `event: error\ndata: ${JSON.stringify({ error: String(e?.message ?? e) })}\n\n`,
          );
        } finally {
          unsub();
          res.end();
        }
      } catch (e: any) {
        const status =
          e instanceof RequestBodyTooLargeError
            ? 413
            : e instanceof SyntaxError || e instanceof RequestBodyValidationError
              ? 400
              : 500;
        const payload = JSON.stringify({ ok: false, error: String(e?.message ?? e) });
        res
          .writeHead(status, {
            'content-type': 'application/json',
            ...(status === 413 ? { connection: 'close' } : {}),
          })
          .end(payload, status === 413 ? () => req.destroy() : undefined);
      }
      return;
    }

    // One real turn, answer + timings, as JSON. This is the endpoint the
    // comparison benchmark calls, and the one to curl by hand.
    if (url.pathname === '/say' && req.method === 'POST') {
      if (surface.requiresAuth() && !surface.authorize(req, url)) {
        res
          .writeHead(401, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      try {
        const body = await readBoundedRequestBody(req);
        const { text } = parseBenchmarkPromptBody(body, false);
        timing.firstTokenMs = null;
        const t0 = process.hrtime.bigint();
        await runTurn(text);
        const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
        const last = agent.state.messages.filter((m: any) => m.role === 'assistant').pop() as
          | AssistantMessage
          | undefined;
        const answer = (last?.content ?? [])
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('');
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            ok: true,
            answer,
            firstTokenMs: timing.firstTokenMs,
            totalMs,
            model: (last as any)?.model ?? null,
            rpcCalls: env.calls.map((c) => c.op),
          }),
        );
      } catch (e: any) {
        const status =
          e instanceof RequestBodyTooLargeError
            ? 413
            : e instanceof SyntaxError || e instanceof RequestBodyValidationError
              ? 400
              : 500;
        const payload = JSON.stringify({ ok: false, error: String(e?.message ?? e) });
        res
          .writeHead(status, {
            'content-type': 'application/json',
            ...(status === 413 ? { connection: 'close' } : {}),
          })
          .end(payload, status === 413 ? () => req.destroy() : undefined);
      }
      return;
    }

    // History straight from the durable tree. Present here for convenience;
    // the real point is that the SAME data is readable from the store with no
    // worker running at all — see bench/read-transcript.ts.
    if (url.pathname === '/history') {
      if (surface.requiresAuth() && !surface.authorize(req, url)) {
        res
          .writeHead(401, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const session = sessionRef();
      if (!session) {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"messages":[]}');
        return;
      }
      const leaf = await session.getLeafId();
      const entries = leaf ? await session.findEntriesOnBranch({ start: leaf } as any) : [];
      const payload = JSON.stringify({
        restoredEntries,
        messages: restoredMessagesFromEntries(entries),
      });
      res.writeHead(200, { 'content-type': 'application/json' }).end(payload);
      return;
    }

    if (url.pathname === '/interrupt' && req.method === 'POST') {
      if (surface.requiresAuth() && !surface.authorize(req, url)) {
        res
          .writeHead(401, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      await stopPendingAdmissions();
      agent.abort();
      try {
        await env.waitForAbortSettled();
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      } catch (error) {
        res
          .writeHead(503, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: String((error as Error)?.message ?? error) }));
      }
      return;
    }

    res.writeHead(404).end();
  });

  LISTEN_UPTIME_MS = vmUptimeMs();
  LISTEN_MS = Date.now() - BOOT_T0;
  const port = (server.address() as any).port;
  console.log(
    JSON.stringify({
      msg: 'worker listening',
      port,
      bootMs: LISTEN_MS,
      vmUptimeAtListenMs: LISTEN_UPTIME_MS,
      modelMode: cfg.modelMode,
      env: cfg.envUrl,
    }),
  );
  // Fire-and-forget, AFTER listen. Durable identified relays are independent
  // from the generic idle-row guard: a pending turn may start immediately and
  // cancel that guard, but it must never cancel reconciliation for an earlier
  // completed or interrupted turn.
  if (turnJournal.unrelayed.length > 0) relayDrain.wake();
  void bootReconcile.run();
  return {
    server,
    agent,
    env,
    faux,
    port,
    close: async () => {
      closing = true;
      await stopPendingAdmissions();
      for (const timer of admissionRetries.values()) clearTimeout(timer);
      admissionRetries.clear();
      relayDrain.close();
      try {
        agent.abort();
        await agent.waitForIdle();
        await turnQueue.waitForIdle();
        await customAgent.close();
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    },
  };
}

// No self-start guard here: src/main.ts is the bundle's sole entrypoint and
// owns startup. In the compiled artifact every module shares one
// import.meta.url, so a guard here fired ALONGSIDE main's start — two binds on
// one port, EADDRINUSE ~1s after boot, dead worker. Found on the first
// dev-served artifact; the api test now asserts survival past that window.
