/** A queued Quick Queue prompt may interrupt only after the active tool finishes. */
export interface QuickQueueArm {
  promptId: string
  opencodeSessionId: string
  messageId: string
}

export interface QuickQueueSnapshot {
  state: 'active' | 'idle' | 'stale' | 'unknown'
  runningTool: boolean
}

interface MessageWithTools {
  info: { id?: unknown; role?: unknown; parentID?: unknown }
  parts: Array<{ type?: unknown; state?: { status?: unknown } }>
}

/** Match the active root before stopping it; a late arm cannot stop its successor. */
export function quickQueueSnapshotFromPage(
  inFlight: boolean | null,
  messages: MessageWithTools[] | null,
  expectedMessageId: string,
): QuickQueueSnapshot {
  if (inFlight === false) return { state: 'idle', runningTool: false }
  if (inFlight === null || !messages) return { state: 'unknown', runningTool: false }
  // A reverse scan, not `findLast`. This file compiles under TWO programs: the
  // sandbox agent's own tsconfig (`lib: ['ESNext']`, where `findLast` exists)
  // and `apps/api`'s, which extends `tsconfig.base.json` at `target: ES2022`
  // and therefore gets ES2022 libs where `Array.prototype.findLast` does NOT
  // exist. The API typechecks this file through a cross-package import, so
  // `findLast` passed the agent's own check and broke `API typecheck` on main
  // (TS2550, plus TS7006 as the callback param fell to implicit any). Widening
  // the API's `lib` to accommodate one call would move a whole program's
  // assumptions; a reverse scan is valid under both and allocates nothing.
  let latestUser: MessageWithTools | undefined
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = messages[i]
    if (candidate && candidate.info.role === 'user') {
      latestUser = candidate
      break
    }
  }
  if (latestUser && latestUser.info.id !== expectedMessageId) {
    return { state: 'stale', runningTool: false }
  }
  const assistantSteps = messages.filter(
    (message) => message.info.role === 'assistant' && message.info.parentID === expectedMessageId,
  )
  if (!latestUser && assistantSteps.length === 0) {
    return { state: 'unknown', runningTool: false }
  }
  return {
    state: 'active',
    runningTool: assistantSteps.some((message) =>
      message.parts.some((part) => part.type === 'tool' && part.state?.status === 'running'),
    ),
  }
}

interface QuickQueueInterruptDeps {
  readSnapshot: (armed: QuickQueueArm) => Promise<QuickQueueSnapshot>
  abort: (armed: QuickQueueArm) => Promise<boolean>
}

interface BoundaryEvent {
  type: string
  session?: string
  payload: unknown
}

export class QuickQueueInterrupt {
  private pending: QuickQueueArm | null = null
  private checking: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly deps: QuickQueueInterruptDeps,
    private readonly retryMs = 1_000,
  ) {}

  async arm(input: QuickQueueArm): Promise<void> {
    if (!this.pending || this.pending.promptId !== input.promptId ||
        this.pending.messageId !== input.messageId) {
      this.pending = input
    }
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), this.retryMs)
      this.timer.unref?.()
    }
    await this.tick()
  }

  disarm(promptId?: string): void {
    if (promptId && this.pending?.promptId !== promptId) return
    this.pending = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  stop(): void {
    this.disarm()
  }

  async observe(event: BoundaryEvent): Promise<void> {
    const pending = this.pending
    if (!pending || event.session !== pending.opencodeSessionId) return
    if (event.type === 'session.idle' || event.type === 'session.error') {
      this.disarm(pending.promptId)
      return
    }
    if (event.type !== 'message.part.updated') return
    const part = (event.payload as { part?: { type?: unknown; state?: { status?: unknown } } } | null)?.part
    if (part?.type !== 'tool') return
    if (part.state?.status !== 'completed' && part.state?.status !== 'error') return
    await this.tick()
  }

  tick(): Promise<void> {
    if (!this.pending) return Promise.resolve()
    if (this.checking) return this.checking
    this.checking = this.check().finally(() => {
      this.checking = null
    })
    return this.checking
  }

  private async check(): Promise<void> {
    const pending = this.pending
    if (!pending) return
    let snapshot: QuickQueueSnapshot
    try {
      snapshot = await this.deps.readSnapshot(pending)
    } catch {
      return
    }
    if (this.pending !== pending) return
    if (snapshot.state === 'idle' || snapshot.state === 'stale') {
      this.disarm(pending.promptId)
      return
    }
    if (snapshot.state !== 'active' || snapshot.runningTool) return
    try {
      if (await this.deps.abort(pending) && this.pending === pending) {
        this.disarm(pending.promptId)
      }
    } catch {
      // Keep the arm; the retry timer or terminal turn relay resolves it.
    }
  }
}
