import type { Readable, Writable } from 'node:stream'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'

export type JsonRpcEnvelope = Record<string, unknown> & { jsonrpc: '2.0' }

export type AcpStreamEvent = {
  id: number
  envelope: JsonRpcEnvelope
}

export type OpenCodeTransport = 'acp' | 'rest'

type PendingRequest = {
  resolve(value: JsonRpcEnvelope): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

type PendingClientRequest = {
  handle(response: JsonRpcEnvelope): Promise<void>
  envelope: JsonRpcEnvelope
  timer: ReturnType<typeof setTimeout> | null
}

type Subscriber = {
  event(value: AcpStreamEvent): void
  close(): void
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
const DEFAULT_MAX_REPLAY_EVENTS = 2_000
const SENSITIVE_ENV_NAME = /(TOKEN|KEY|SECRET|PASSWORD|AUTH)/i
const MAX_DIAGNOSTIC_CHARS = 600

/**
 * Requests that give a session permission to speak. `session/prompt` starts a
 * new turn; `session/load` and `session/resume` replay an existing transcript.
 * Until one of these is sent for a session, nothing the harness says about that
 * session is conversation.
 */
const CONVERSATION_OPENING_METHODS = new Set([
  'session/prompt',
  'session/load',
  'session/resume',
])

/** `session/update` kinds a client renders as assistant-authored content. */
const AGENT_CONTENT_UPDATES = new Set([
  'agent_message_chunk',
  'agent_thought_chunk',
])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function truncateForDiagnostic(value: string): string {
  return value.length > MAX_DIAGNOSTIC_CHARS
    ? `${value.slice(0, MAX_DIAGNOSTIC_CHARS)}… (+${value.length - MAX_DIAGNOSTIC_CHARS} chars)`
    : value
}

function envelopeSessionId(envelope: JsonRpcEnvelope): string | null {
  const params = envelope.params
  if (!isObject(params)) return null
  return typeof params.sessionId === 'string' && params.sessionId
    ? params.sessionId
    : null
}

/** The `sessionUpdate` kind when this envelope carries assistant content. */
function agentContentKind(envelope: JsonRpcEnvelope): string | null {
  if (envelope.method !== 'session/update') return null
  const params = envelope.params
  if (!isObject(params)) return null
  const update = params.update
  if (!isObject(update)) return null
  const kind = update.sessionUpdate
  return typeof kind === 'string' && AGENT_CONTENT_UPDATES.has(kind)
    ? kind
    : null
}

/**
 * Startup text an adapter declares on a response, e.g. pi-acp's
 * `result._meta.piAcp.startupInfo`. The adapter is telling us this string is a
 * banner, so the same string arriving as assistant content is never
 * conversation — no matter when it arrives.
 */
function declaredStartupInfo(envelope: JsonRpcEnvelope): string | null {
  const result = envelope.result
  if (!isObject(result)) return null
  const meta = result._meta
  if (!isObject(meta)) return null
  for (const namespace of Object.values(meta)) {
    if (!isObject(namespace)) continue
    const info = namespace.startupInfo
    if (typeof info === 'string' && info.trim()) return info.trim()
  }
  return null
}

function agentContentText(envelope: JsonRpcEnvelope): string {
  const params = envelope.params
  if (!isObject(params)) return ''
  const update = params.update
  if (!isObject(update)) return ''
  const content = update.content
  if (isObject(content) && typeof content.text === 'string') return content.text
  return JSON.stringify(update)
}

function rpcIdKey(value: unknown): string {
  return JSON.stringify(value)
}

export function resolveOpenCodeTransport(
  env: NodeJS.ProcessEnv,
): OpenCodeTransport {
  const value =
    env.KORTIX_OPENCODE_PROCESS_TRANSPORT?.trim().toLowerCase() || 'acp'
  if (value === 'acp' || value === 'rest') return value
  throw new Error(
    "KORTIX_OPENCODE_PROCESS_TRANSPORT must be 'acp' or 'rest'",
  )
}

export function buildOpenCodeLaunch(
  transport: OpenCodeTransport,
  port: number,
  cwd: string,
): {
  args: string[]
  stdio: ['pipe', 'pipe', 'pipe'] | ['ignore', 'inherit', 'inherit']
  env: Record<string, string>
} {
  if (transport === 'rest') {
    return {
      args: ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {},
    }
  }
  return {
    args: [
      'acp',
      '--port',
      String(port),
      '--hostname',
      '127.0.0.1',
      '--cwd',
      cwd,
    ],
    stdio: ['pipe', 'pipe', 'pipe'],
    // OpenCode excludes its interactive question tool for non-TUI clients
    // unless this explicit compatibility flag is set. The daemon bridges
    // question.asked events into ACP session/request_input requests.
    env: { OPENCODE_ENABLE_QUESTION_TOOL: '1' },
  }
}

export function parseJsonRpcEnvelope(value: unknown): JsonRpcEnvelope {
  if (!isObject(value) || value.jsonrpc !== '2.0') {
    throw new Error('request body must be a JSON-RPC 2.0 object')
  }
  const hasMethod = typeof value.method === 'string' && value.method.length > 0
  const hasId = Object.prototype.hasOwnProperty.call(value, 'id')
  const isResponse =
    hasId &&
    (Object.prototype.hasOwnProperty.call(value, 'result') ||
      Object.prototype.hasOwnProperty.call(value, 'error'))
  if (!hasMethod && !isResponse) {
    throw new Error(
      'JSON-RPC envelope must be a request, notification, or response',
    )
  }
  return value as JsonRpcEnvelope
}

export function redactAcpDiagnostic(
  line: string,
  env: NodeJS.ProcessEnv,
): string {
  let redacted = line
  for (const [name, value] of Object.entries(env)) {
    if (!SENSITIVE_ENV_NAME.test(name) || !value || value.length < 6) continue
    redacted = redacted.replaceAll(value, '[REDACTED]')
  }
  return redacted
}

export class AcpProtocolError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'AcpProtocolError'
  }
}

export class AcpConnection {
  readonly instanceId = randomUUID()
  private readonly input: Writable
  private readonly pending = new Map<string, PendingRequest>()
  private readonly pendingClientRequests = new Map<string, PendingClientRequest>()
  private readonly completedClientRequestIds = new Set<string>()
  private readonly completedClientRequestOrder: string[] = []
  private readonly subscribers = new Set<Subscriber>()
  private readonly promptedSessions = new Set<string>()
  private readonly declaredStartupBanners = new Set<string>()
  private conversationOpenForAllSessions = false
  private readonly replay: AcpStreamEvent[] = []
  private readonly requestTimeoutMs: number
  private readonly maxReplayEvents: number
  private readonly onDiagnostic: (line: string) => void
  private readonly onFirstOutput: () => void
  private nextRequestId = 1
  private nextEventId: number
  private writeQueue = Promise.resolve()
  private closed = false
  private initialized = false
  private initialization: Promise<JsonRpcEnvelope> | null = null
  private initializationResult: Record<string, unknown> | null = null
  private receivedOutput = false

  constructor(options: {
    input: Writable
    output: Readable
    requestTimeoutMs?: number
    maxReplayEvents?: number
    initialEventId?: number
    onDiagnostic?: (line: string) => void
    onFirstOutput?: () => void
  }) {
    this.input = options.input
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.maxReplayEvents =
      options.maxReplayEvents ?? DEFAULT_MAX_REPLAY_EVENTS
    this.nextEventId = options.initialEventId ?? 1
    if (!Number.isSafeInteger(this.nextEventId) || this.nextEventId < 1) {
      throw new Error('initialEventId must be a positive safe integer')
    }
    this.onDiagnostic = options.onDiagnostic ?? (() => {})
    this.onFirstOutput = options.onFirstOutput ?? (() => {})

    const lines = createInterface({ input: options.output })
    lines.on('line', (line) => {
      if (!this.receivedOutput) {
        this.receivedOutput = true
        this.onFirstOutput()
      }
      this.onLine(line)
    })
    lines.once('close', () => this.close(new AcpProtocolError('ACP output closed')))
    options.output.once('error', (error) => this.close(error))
    options.input.once('error', (error) => this.close(error))
  }

  get ready(): boolean {
    return this.initialized && !this.closed
  }

  get lastEventId(): number {
    return this.nextEventId - 1
  }

  get busy(): boolean {
    return this.pending.size > 0
  }

  async initialize(input: {
    clientInfo: { name: string; version: string }
  }): Promise<Record<string, unknown>> {
    const envelope = await this.initializeEnvelope(
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
        clientInfo: input.clientInfo,
      },
      'kortix:initialize',
    )
    if (Object.prototype.hasOwnProperty.call(envelope, 'error')) {
      const error = isObject(envelope.error) ? envelope.error : {}
      throw new AcpProtocolError(
        typeof error.message === 'string'
          ? error.message
          : 'ACP harness returned an error',
        typeof error.code === 'number' ? error.code : undefined,
        error.data,
      )
    }
    const result = envelope.result
    if (!isObject(result) || result.protocolVersion !== 1) {
      throw new AcpProtocolError('ACP harness did not negotiate protocol version 1')
    }
    return result
  }

  async initializeEnvelope(
    params: unknown,
    id: string | number,
  ): Promise<JsonRpcEnvelope> {
    if (this.initializationResult) {
      return {
        jsonrpc: '2.0',
        id,
        result: this.initializationResult,
      }
    }
    if (!this.initialization) {
      this.initialization = this.requestEnvelope('initialize', params, id)
        .then((envelope) => {
          if (!Object.prototype.hasOwnProperty.call(envelope, 'error')) {
            if (!isObject(envelope.result) || envelope.result.protocolVersion !== 1) {
              throw new AcpProtocolError('ACP harness did not negotiate protocol version 1')
            }
            this.initializationResult = envelope.result
            this.initialized = true
          }
          return envelope
        })
        .finally(() => {
          this.initialization = null
        })
    }
    const envelope = await this.initialization
    return {
      ...envelope,
      id,
    }
  }

  async request(
    method: string,
    params: unknown,
    id: string | number = `kortix:${this.nextRequestId++}`,
  ): Promise<unknown> {
    const envelope = await this.requestEnvelope(method, params, id)
    if (Object.prototype.hasOwnProperty.call(envelope, 'error')) {
      const error = isObject(envelope.error) ? envelope.error : {}
      throw new AcpProtocolError(
        typeof error.message === 'string'
          ? error.message
          : 'ACP harness returned an error',
        typeof error.code === 'number' ? error.code : undefined,
        error.data,
      )
    }
    return envelope.result
  }

  async requestEnvelope(
    method: string,
    params: unknown,
    id: string | number,
  ): Promise<JsonRpcEnvelope> {
    if (this.closed) throw new AcpProtocolError('ACP output closed')
    const key = rpcIdKey(id)
    if (this.pending.has(key)) {
      throw new AcpProtocolError(`duplicate in-flight JSON-RPC id ${key}`)
    }

    const response = new Promise<JsonRpcEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key)
        reject(
          new AcpProtocolError(
            `timed out waiting for ACP response to id ${key}`,
          ),
        )
      }, this.requestTimeoutMs)
      this.pending.set(key, { resolve, reject, timer })
    })

    try {
      await this.write({
        jsonrpc: '2.0',
        id,
        method,
        params,
      })
    } catch (error) {
      const pending = this.pending.get(key)
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(key)
        pending.reject(
          error instanceof Error
            ? error
            : new AcpProtocolError(String(error)),
        )
      }
    }
    return response
  }

  async notify(method: string, params: unknown): Promise<void> {
    await this.write({ jsonrpc: '2.0', method, params })
  }

  async post(envelope: JsonRpcEnvelope): Promise<void> {
    if (!('method' in envelope) && Object.prototype.hasOwnProperty.call(envelope, 'id')) {
      const key = rpcIdKey(envelope.id)
      const pending = this.pendingClientRequests.get(key)
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer)
        this.pendingClientRequests.delete(key)
        this.rememberCompletedClientRequest(key)
        await pending.handle(envelope)
        return
      }
      if (this.completedClientRequestIds.has(key)) return
    }
    await this.write(envelope)
  }

  requestClient(
    method: string,
    params: unknown,
    id: string | number,
    handle: (response: JsonRpcEnvelope) => Promise<void>,
    options: { timeoutMs?: number | null } = {},
  ): void {
    if (this.closed) throw new AcpProtocolError('ACP output closed')
    const key = rpcIdKey(id)
    if (
      this.pendingClientRequests.has(key) ||
      this.completedClientRequestIds.has(key)
    ) {
      return
    }
    const envelope: JsonRpcEnvelope = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    }
    const timeoutMs =
      options.timeoutMs === undefined
        ? this.requestTimeoutMs
        : options.timeoutMs
    const timer =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            this.pendingClientRequests.delete(key)
            this.rememberCompletedClientRequest(key)
            this.onDiagnostic(
              `timed out waiting for ACP client response to id ${key}`,
            )
          }, timeoutMs)
    this.pendingClientRequests.set(key, { handle, envelope, timer })
    this.publish(envelope)
  }

  notifyClient(method: string, params?: unknown): void {
    this.publish({
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    })
  }

  subscribe(
    afterEventId: number,
    event: Subscriber['event'],
    close: Subscriber['close'] = () => {},
  ): () => void {
    const replayedPendingRequests = new Set<string>()
    for (const replayed of this.replay) {
      if (replayed.id <= afterEventId) continue
      event(replayed)
      if (
        Object.prototype.hasOwnProperty.call(replayed.envelope, 'id') &&
        'method' in replayed.envelope
      ) {
        const key = rpcIdKey(replayed.envelope.id)
        if (this.pendingClientRequests.has(key)) {
          replayedPendingRequests.add(key)
        }
      }
    }
    for (const [key, pending] of this.pendingClientRequests) {
      if (replayedPendingRequests.has(key)) continue
      event({
        id: this.nextEventId++,
        envelope: pending.envelope,
      })
    }
    if (this.closed) {
      close()
      return () => {}
    }
    const subscriber = { event, close }
    this.subscribers.add(subscriber)
    return () => this.subscribers.delete(subscriber)
  }

  dispose(message = 'ACP connection disposed'): void {
    this.close(new AcpProtocolError(message))
  }

  private async write(envelope: JsonRpcEnvelope): Promise<void> {
    if (this.closed) throw new AcpProtocolError('ACP output closed')
    this.noteConversationOpened(envelope)
    const line = `${JSON.stringify(envelope)}\n`
    const write = async () => {
      await new Promise<void>((resolve, reject) => {
        this.input.write(line, (error) => (error ? reject(error) : resolve()))
      })
    }
    const queued = this.writeQueue.then(write, write)
    this.writeQueue = queued.catch(() => {})
    return queued
  }

  private onLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return

    let envelope: JsonRpcEnvelope
    try {
      envelope = parseJsonRpcEnvelope(JSON.parse(trimmed))
    } catch (error) {
      // Harness CLIs print banners, upgrade nags, and warnings on the same
      // stdout that carries ACP framing. None of it is conversation, so it
      // stops here — but it is logged verbatim, because an adapter that talks
      // out of band is exactly what we need to see when one misbehaves.
      const cause = error instanceof Error ? error.message : String(error)
      this.onDiagnostic(
        `ignored unframed ACP output: ${truncateForDiagnostic(trimmed)} (${cause})`,
      )
      return
    }

    const startupInfo = declaredStartupInfo(envelope)
    if (startupInfo) this.rememberStartupBanner(startupInfo)

    const hasMethod = typeof envelope.method === 'string'
    const hasId = Object.prototype.hasOwnProperty.call(envelope, 'id')
    if (!hasMethod && hasId) {
      const key = rpcIdKey(envelope.id)
      const pending = this.pending.get(key)
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(key)
        pending.resolve(envelope)
        return
      }
    }

    // A well-framed `session/update` is still not conversation when the harness
    // is only announcing itself. pi-acp ships its CLI banner and upgrade nag as
    // an `agent_message_chunk` right after `session/new`, which rendered as the
    // assistant's first message. Two independent reasons to divert one to the
    // log: the adapter declared that exact text as startup info, or no turn is
    // open for the session yet.
    const contentKind = agentContentKind(envelope)
    if (contentKind) {
      const text = agentContentText(envelope)
      const reason = this.declaredStartupBanners.has(text.trim())
        ? 'declared startup info'
        : this.conversationIsOpen(envelope)
          ? null
          : 'no open turn'
      if (reason) {
        const detail = truncateForDiagnostic(text)
        this.onDiagnostic(
          `suppressed harness ${contentKind} (${reason}): ${detail}`,
        )
        return
      }
    }

    this.publish(envelope)
  }

  private rememberStartupBanner(text: string): void {
    if (this.declaredStartupBanners.size >= 8) {
      const oldest = this.declaredStartupBanners.values().next().value
      if (oldest !== undefined) this.declaredStartupBanners.delete(oldest)
    }
    this.declaredStartupBanners.add(text)
  }

  private noteConversationOpened(envelope: JsonRpcEnvelope): void {
    if (typeof envelope.method !== 'string') return
    if (!CONVERSATION_OPENING_METHODS.has(envelope.method)) return
    const sessionId = envelopeSessionId(envelope)
    if (sessionId) this.promptedSessions.add(sessionId)
    // A conversation-opening request we cannot attribute to a session opens
    // every session. Losing real assistant text is worse than showing chatter.
    else this.conversationOpenForAllSessions = true
  }

  private conversationIsOpen(envelope: JsonRpcEnvelope): boolean {
    if (this.conversationOpenForAllSessions) return true
    const sessionId = envelopeSessionId(envelope)
    if (!sessionId) return true
    return this.promptedSessions.has(sessionId)
  }

  private publish(envelope: JsonRpcEnvelope): void {
    const event = { id: this.nextEventId++, envelope }
    this.replay.push(event)
    if (this.replay.length > this.maxReplayEvents) this.replay.shift()
    for (const subscriber of this.subscribers) subscriber.event(event)
  }

  private rememberCompletedClientRequest(key: string): void {
    if (this.completedClientRequestIds.has(key)) return
    this.completedClientRequestIds.add(key)
    this.completedClientRequestOrder.push(key)
    while (this.completedClientRequestOrder.length > this.maxReplayEvents) {
      const oldest = this.completedClientRequestOrder.shift()
      if (oldest !== undefined) this.completedClientRequestIds.delete(oldest)
    }
  }

  private close(error: Error): void {
    if (this.closed) return
    this.closed = true
    this.initialized = false
    this.initializationResult = null
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    for (const pending of this.pendingClientRequests.values()) {
      if (pending.timer) clearTimeout(pending.timer)
    }
    this.pendingClientRequests.clear()
    this.completedClientRequestIds.clear()
    this.completedClientRequestOrder.length = 0
    for (const subscriber of this.subscribers) subscriber.close()
    this.subscribers.clear()
  }
}
