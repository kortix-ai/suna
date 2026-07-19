import { collectChangedFiles, type ChangedScanResult } from './changed-files'
import type { JsonRpcEnvelope } from './runtime'
import { logger } from '../logger'

/** Watches one AcpProcess's ACP traffic and publishes durable synthetic
 * `show` tool calls for workspace files changed during a prompt. Provider-
 * neutral: it reads only ACP-standard fields (method, update.kind, status). */

const PROMPT_START_ALLOWANCE_MS = 2_000
const MAX_ITEMS = 500
const TERMINAL = new Set(['completed', 'failed'])

type Scan = (workspace: string, sinceMs: number, isIgnored: (p: string[]) => Promise<Set<string>>) => Promise<ChangedScanResult>

type PromptState = {
  seq: number
  sessionId: string
  startMs: number
  responseKey: string | null
  kinds: Map<string, string>
  lastSignature: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class OutputScanTracker {
  private prompt: PromptState | null = null
  private seq = 0
  private scanning = false
  private rescanWanted = false
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(
    private readonly options: {
      workspace: string
      publish(envelope: JsonRpcEnvelope): void
      isIgnored(absPaths: string[]): Promise<Set<string>>
      scan?: Scan
      now?: () => number
      debounceMs?: number
    },
  ) {}

  noteOutbound(envelope: JsonRpcEnvelope): void {
    if (envelope.method !== 'session/prompt') return
    const params = isRecord(envelope.params) ? envelope.params : {}
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
    const now = this.options.now?.() ?? Date.now()
    this.prompt = {
      seq: ++this.seq,
      sessionId,
      startMs: now - PROMPT_START_ALLOWANCE_MS,
      responseKey: Object.prototype.hasOwnProperty.call(envelope, 'id') ? JSON.stringify(envelope.id) : null,
      kinds: new Map(),
      lastSignature: '',
    }
  }

  noteInbound(envelope: JsonRpcEnvelope): void {
    if (!this.prompt || envelope.method !== 'session/update') return
    const params = isRecord(envelope.params) ? envelope.params : {}
    const update = isRecord(params.update) ? params.update : {}
    const kind = update.sessionUpdate ?? update.type
    if (kind !== 'tool_call' && kind !== 'tool_call_update') return
    const id = typeof update.toolCallId === 'string' ? update.toolCallId : typeof update.id === 'string' ? update.id : ''
    if (!id) return
    const toolKind = typeof update.kind === 'string' ? update.kind : ''
    if (toolKind && !this.prompt.kinds.has(id)) this.prompt.kinds.set(id, toolKind)
    const status = typeof update.status === 'string' ? update.status : ''
    if (TERMINAL.has(status) && this.prompt.kinds.get(id) === 'execute') this.requestScan()
  }

  noteResponse(envelope: JsonRpcEnvelope): void {
    if (!this.prompt || this.prompt.responseKey === null) return
    if (JSON.stringify(envelope.id) !== this.prompt.responseKey) return
    if (Object.prototype.hasOwnProperty.call(envelope, 'error')) return
    const result = isRecord(envelope.result) ? envelope.result : {}
    if (result.stopReason === 'cancelled') return
    this.requestScan()
  }

  dispose(): void {
    this.disposed = true
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
  }

  private requestScan(): void {
    if (this.disposed) return
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => void this.runScan(), this.options.debounceMs ?? 500)
  }

  private async runScan(): Promise<void> {
    if (this.disposed || !this.prompt) return
    if (this.scanning) { this.rescanWanted = true; return }
    this.scanning = true
    const prompt = this.prompt
    try {
      const scan = this.options.scan ?? collectChangedFiles
      const result = await scan(this.options.workspace, prompt.startMs, this.options.isIgnored)
      if (this.disposed || this.prompt !== prompt) return
      const items = result.files.slice(0, MAX_ITEMS).map((file) => ({ path: file.absolute }))
      if (!items.length) return
      const signature = items.map((item) => item.path).join('\n')
      if (signature === prompt.lastSignature) return
      prompt.lastSignature = signature
      this.options.publish({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: prompt.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: `kortix-outputs:${prompt.seq}`,
            title: 'Show',
            kind: 'other',
            status: 'completed',
            tool: 'show',
            rawInput: { items },
            _meta: { kortix: { synthetic: 'filesystem-delta', schemaVersion: 1, truncated: result.truncated || result.files.length > MAX_ITEMS } },
          },
        },
      })
    } catch (error) {
      logger.warn('[acp] output scan failed', { error: error instanceof Error ? error.message : String(error) })
    } finally {
      this.scanning = false
      if (this.rescanWanted) {
        this.rescanWanted = false
        this.requestScan()
      }
    }
  }
}
