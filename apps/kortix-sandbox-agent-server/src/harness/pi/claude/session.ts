/**
 * One running `claude` process: the Agent SDK's streaming-input query.
 *
 * A turn starts with `begin`. `readStep` reads it up to the next point where pi must act: a
 * reply that called Kortix tools (Claude waits for their results), or the end of the turn.
 * `addUser` steers a running turn. One reader drains the SDK iterator for the life of the
 * process, so an interrupt still drains and flushes Claude's transcript.
 */
import type { Options, SDKMessage, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ContentBlock } from './messages'
import { original } from './names'
import { loadClaudeSdk } from './sdk'

interface Turn {
  readonly drained: PromiseWithResolvers<void>
  readonly messages: SDKMessage[]
  wake?: () => void
  finished: boolean
}

export interface ClaudeInit {
  readonly version: string | undefined
  readonly account: { tokenSource?: string; apiKeySource?: string; subscriptionType?: string } | undefined
  readonly models: readonly { value: string; displayName?: string; supportedEffortLevels?: string[] }[]
}

/** Older binaries ignore `verbatimPrompts` and can read user text as Claude Code commands. */
const MINIMUM_VERSION = '2.1.248'

export function versionError(version: string | undefined): Error | undefined {
  const parse = (value: string) => value.split(/[-+]/)[0]!.split('.').map(Number)
  if (version) {
    const current = parse(version)
    const required = parse(MINIMUM_VERSION)
    const index = required.findIndex((part, position) => (current[position] ?? 0) !== part)
    if (index === -1 || (current[index] ?? 0) > required[index]!) return undefined
  }
  return new Error(
    version
      ? `Claude Code ${version} is too old for Kortix; ${MINIMUM_VERSION} or later is required.`
      : 'Claude Code did not report its version, so Kortix could not check that it is compatible.',
  )
}

export type ClaudeSession = Awaited<ReturnType<typeof startClaudeSession>>

export async function startClaudeSession(options: Options) {
  const { query } = await loadClaudeSdk()
  let input!: ReadableStreamDefaultController<SDKUserMessage>
  const prompt = new ReadableStream<SDKUserMessage>({ start: (controller) => void (input = controller) })
  const session = query({ prompt: prompt as unknown as AsyncIterable<SDKUserMessage>, options })
  let turn: Turn | undefined
  let initialized = false
  let ended = false
  let failure: unknown
  let stopping: Promise<void> | undefined
  let persisted = false
  const ready = session.initializationResult().then((init): ClaudeInit => {
    const error = versionError(init.claude_code_version)
    if (error) throw error
    initialized = true
    return { version: init.claude_code_version, account: init.account, models: init.models ?? [] }
  })
  // A stop during startup can end the session before anything awaits `ready`.
  ready.catch(() => {})

  const finishTurn = () => {
    if (!turn) return
    turn.finished = true
    turn.drained.resolve()
  }

  const pump = (async () => {
    try {
      for await (const message of session) {
        if (turn) {
          turn.messages.push(message)
          turn.wake?.()
        }
        if (message.type === 'assistant' || message.type === 'result') persisted = true
        if (message.type === 'result') finishTurn()
      }
    } catch (error) {
      failure = error
    } finally {
      ended = true
      finishTurn()
      turn?.wake?.()
    }
  })()

  async function interrupt(): Promise<void> {
    const active = turn
    if (!active || active.finished || ended) return
    await session.interrupt()
    // interrupt() resolves before the result and the transcript flush: wait for the drain.
    await active.drained.promise
  }

  async function shutdown(): Promise<void> {
    try {
      if (initialized && !ended) {
        await session.interrupt().catch(() => {})
        if (turn && !turn.finished) await turn.drained.promise
      }
      input.close()
      // A process that never initialized has no conversation to flush.
      if (!initialized) session.close()
      await pump
    } finally {
      session.close()
    }
  }

  return {
    id: options.resume ?? options.sessionId!,
    ready,
    get ended() {
      return ended
    },
    get persisted() {
      return persisted
    },
    get running() {
      return !!turn && !turn.finished
    },
    begin(content: ContentBlock[], uuid: string = crypto.randomUUID()) {
      if (ended || stopping) throw failure instanceof Error ? failure : new Error('Claude Code stopped')
      if (turn && !turn.finished) throw new Error('Claude Code is still finishing the previous turn')
      turn = { drained: Promise.withResolvers<void>(), messages: [], finished: false }
      input.enqueue({ type: 'user', uuid: uuid as SDKUserMessage['uuid'], message: { role: 'user', content: content as never }, parent_tool_use_id: null })
    },
    /** Read the turn up to a reply that called Kortix tools ('tools') or its result. */
    async readStep(emit: (message: SDKMessage) => void, tools: readonly { name: string }[]): Promise<SDKResultMessage | 'tools'> {
      const active = turn
      if (!active) throw new Error('No Claude turn to read')
      let calledTools = false
      while (true) {
        const message = active.messages.shift()
        if (!message) {
          if (ended) throw failure instanceof Error ? failure : new Error('Claude Code stopped before it finished its reply')
          await new Promise<void>((resolve) => (active.wake = resolve))
          continue
        }
        emit(message)
        if (message.type === 'assistant' && message.parent_tool_use_id === null) {
          for (const part of message.message.content) {
            // A tool Kortix did not offer gets Claude Code's own error, and the turn goes on without pi.
            if (part.type === 'tool_use' && original(part.name, tools)) calledTools = true
          }
        }
        const replyEnded = message.type === 'stream_event' && message.parent_tool_use_id === null && message.event.type === 'message_stop'
        if (calledTools && replyEnded) return 'tools'
        if (message.type === 'result') return message
      }
    },
    addUser(content: ContentBlock[], uuid: string) {
      input.enqueue({ type: 'user', uuid: uuid as SDKUserMessage['uuid'], priority: 'next', message: { role: 'user', content: content as never }, parent_tool_use_id: null })
    },
    interrupt,
    stop(): Promise<void> {
      stopping ??= shutdown()
      return stopping
    },
    setModel: (model: string) => session.setModel(model),
    setEffort: (effort: Options['effort']) => session.applyFlagSettings({ effortLevel: effort ?? null } as never),
  }
}
