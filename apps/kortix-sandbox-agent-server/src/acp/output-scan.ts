import { existsSync } from 'node:fs'
import path from 'node:path'
import { collectChangedFiles, isDeniedChangeName, type ChangedScanResult } from './changed-files'
import type { JsonRpcEnvelope } from './runtime'
import { gitWorkingStatus } from '../routes/files'
import { logger } from '../logger'

/** Watches one AcpProcess's ACP traffic and publishes durable synthetic
 * `show` tool calls for workspace files changed during a prompt. Provider-
 * neutral: it reads only ACP-standard fields (method, update.kind, status). */

const PROMPT_START_ALLOWANCE_MS = 2_000
const MAX_ITEMS = 500
const TERMINAL = new Set(['completed', 'failed'])
const RECOVERY_TOOL_CALL_ID = 'kortix-outputs:recovery'

type Scan = (workspace: string, sinceMs: number, isIgnored: (p: string[]) => Promise<Set<string>>) => Promise<ChangedScanResult>
/** Only the field the recovery scan actually reads — real `gitWorkingStatus`
 * (which returns the richer `GitFileStatus[]`) satisfies this structurally. */
type GitStatusEntry = { path: string }
type GitStatusFn = (workspace: string) => Promise<GitStatusEntry[]>
type HasGitDirFn = (workspace: string) => boolean

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
  private recoveryDone = false

  constructor(
    private readonly options: {
      workspace: string
      publish(envelope: JsonRpcEnvelope): void
      isIgnored(absPaths: string[]): Promise<Set<string>>
      scan?: Scan
      now?: () => number
      debounceMs?: number
      gitWorkingStatus?: GitStatusFn
      hasGitDir?: HasGitDirFn
    },
  ) {}

  noteOutbound(envelope: JsonRpcEnvelope): void {
    if (envelope.method === 'session/load' && !this.recoveryDone) {
      this.recoveryDone = true
      const loadParams = isRecord(envelope.params) ? envelope.params : {}
      const sessionId = typeof loadParams.sessionId === 'string' ? loadParams.sessionId : ''
      void this.runRecoveryScan(sessionId)
    }
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

  /** One-shot recovery for pre-feature sessions resumed via `session/load`:
   * surface the work product that already exists on disk (never fires for
   * `session/new` — a fresh workspace has nothing to recover). Git workspace →
   * untracked+modified files from git status (filtered through the same
   * lockfile/hidden deny list as the bounded walk, capped at MAX_ITEMS);
   * non-git workspace → the same bounded walk used by the delta scanner,
   * `since 0`. Empty result → no event. */
  private async runRecoveryScan(sessionId: string): Promise<void> {
    if (this.disposed) return
    try {
      const { items, truncated } = await this.collectRecoveryItems()
      if (!items.length) return
      this.options.publish({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: RECOVERY_TOOL_CALL_ID,
            title: 'Show',
            kind: 'other',
            status: 'completed',
            tool: 'show',
            rawInput: { items: items.map((absolute) => ({ path: absolute })) },
            _meta: { kortix: { synthetic: 'workspace-recovery', schemaVersion: 1, truncated } },
          },
        },
      })
    } catch (error) {
      logger.warn('[acp] workspace recovery scan failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  private async collectRecoveryItems(): Promise<{ items: string[]; truncated: boolean }> {
    const workspace = this.options.workspace
    const readGitStatus = this.options.gitWorkingStatus ?? gitWorkingStatus
    const hasGitDir = this.options.hasGitDir ?? ((ws: string) => existsSync(path.join(ws, '.git')))
    const statuses = await readGitStatus(workspace).catch(() => [] as GitStatusEntry[])
    const isGitWorkspace = statuses.length > 0 || hasGitDir(workspace)
    if (isGitWorkspace) {
      const absolutes = statuses
        .map((entry) => path.join(workspace, entry.path))
        .filter((absolute) => !isDeniedChangeName(path.basename(absolute)))
      const truncated = absolutes.length > MAX_ITEMS
      return { items: absolutes.slice(0, MAX_ITEMS), truncated }
    }
    const scan = this.options.scan ?? collectChangedFiles
    const result = await scan(workspace, 0, this.options.isIgnored)
    return {
      items: result.files.slice(0, MAX_ITEMS).map((file) => file.absolute),
      truncated: result.truncated || result.files.length > MAX_ITEMS,
    }
  }
}
