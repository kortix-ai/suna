/**
 * The `claude-agent` provider: Claude models on the session user's own Claude subscription.
 *
 * pi stays the harness. Each pi model step runs as a step of Claude Code: the unmodified
 * `claude` program makes the model call with the user's own login, straight to Anthropic (never
 * through the Kortix LLM gateway). Claude Code's own tools are off; pi's tools reach Claude
 * through an in-process MCP server, and pi runs every call (permission gate, extensions,
 * questions, subagents, the transcript), so a Claude reply looks like any model's reply and
 * the session can switch models freely.
 */
import type { Api, AssistantMessageEvent, AssistantMessageEventStream, Model, Provider, SimpleStreamOptions, StreamOptions, TranscriptContext } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream, createProvider, getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai'
import { CLAUDE_AGENT_MODELS, CLAUDE_AGENT_PROVIDER_ID, CLAUDE_AGENT_PROVIDER_NAME, type ClaudeAgentModel } from '@kortix/api-contract/claude-agent'
import { logger } from '@/lib/log/logger'
import { ClaudeLoginMissing, claudeGateway } from './sdk'
import { ClaudeSessions, type Effort } from './sessions'
import { ClaudeReply } from './stream'

export const CLAUDE_API = 'claude-agent' as const

export function claudeModel(entry: ClaudeAgentModel): Model<Api> {
  return {
    id: entry.id,
    name: entry.name,
    api: CLAUDE_API,
    provider: CLAUDE_AGENT_PROVIDER_ID,
    baseUrl: '',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.context,
    maxTokens: entry.output,
    // Claude Code takes `xhigh` and `max` itself.
    thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
  }
}

/** A model ref of this provider that Claude Code does not list still runs: Claude Code resolves aliases and full ids. */
export function claudeModelFor(id: string): Model<Api> {
  const entry = CLAUDE_AGENT_MODELS.find((model) => model.id === id)
  return claudeModel(entry ?? { id, name: id, resolved: id, description: '', context: 200_000, output: 32_000 })
}

/** pi's thinking level as Claude Code's effort. pi's `minimal` has no Claude Code level. */
function effortFor(level: string | undefined): Effort | undefined {
  if (!level || level === 'off') return undefined
  if (level === 'minimal') return 'low'
  return (['low', 'medium', 'high', 'xhigh', 'max'] as const).find((effort) => effort === level)
}

let sessions: ClaudeSessions | null = null
let subscription = true

/** The process registry of this daemon, once a runtime set it up. */
export function claudeSessions(): ClaudeSessions | null {
  return sessions
}

export interface ClaudeProviderOptions {
  readonly stateDir: string
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
  /**
   * Runs a step through the LLM gateway under the same `claude-agent/<id>` ref. The gateway
   * cannot serve the ref itself: it answers with the project's fallback model (Routing).
   */
  readonly gatewayStep?: (model: Model<Api>, context: TranscriptContext, options: StreamOptions) => AssistantMessageEventStream
}

/**
 * Relays the fallback's step from `source` into `out`. False, with nothing relayed, when it failed
 * before any output: no fallback served it (the project has no Routing chain, or every link
 * failed), so the step keeps Claude's own limit message and reset time.
 */
export async function relayFallbackStep(source: AssistantMessageEventStream, out: AssistantMessageEventStream): Promise<boolean> {
  const held: AssistantMessageEvent[] = []
  let flowing = false
  for await (const event of source) {
    if (flowing) {
      out.push(event)
      continue
    }
    if (event.type === 'error') return false
    held.push(event)
    if (event.type === 'start') continue
    flowing = true
    for (const queued of held) out.push(queued)
  }
  if (!flowing) return false
  out.end(await source.result())
  return true
}

function ensureSessions(opts: ClaudeProviderOptions): ClaudeSessions {
  if (sessions) return sessions
  const created = new ClaudeSessions({
    stateDir: opts.stateDir,
    cwd: opts.cwd,
    env: opts.env,
    onReady: (init) => {
      subscription = init.account?.tokenSource !== undefined && init.account.tokenSource !== 'none' && !init.account.apiKeySource
      logger.info('[claude] Claude Code ready', { version: init.version, subscription: init.account?.subscriptionType ?? null, tokenSource: init.account?.tokenSource ?? null })
    },
  })
  sessions = created
  return created
}

function stream(opts: ClaudeProviderOptions, model: Model<Api>, context: TranscriptContext, options: StreamOptions & { reasoning?: string } = {}): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream()
  const tools = getCurrentTools(context.messages)
  const reply = new ClaudeReply(out, model, tools, () => subscription)
  void (async () => {
    try {
      if (!claudeGateway(opts.env)) throw new ClaudeLoginMissing()
      const registry = ensureSessions(opts)
      const outcome = await registry.run({
        // A step with tools is a step of a thread. One without (pi's compaction summary) is a side call.
        key: tools.length > 0 ? options.sessionId : undefined,
        model: model.id,
        effort: effortFor(options.reasoning),
        system: getCurrentSystemPrompt(context.messages),
        messages: context.messages.filter((message) => message.role !== 'system'),
        tools,
        emit: (message) => reply.push(message),
        reply: () => reply.message,
        signal: options.signal,
      })
      if (outcome.kind === 'tools') reply.finishTools()
      else if (outcome.kind === 'result' && opts.gatewayStep && reply.limitedBeforeOutput(outcome.result)) {
        // Every Claude account is at its limit: the project's fallback model takes the step.
        logger.warn('[claude] every Claude account is at its usage limit; the step goes to the gateway fallback', { model: model.id })
        if (await relayFallbackStep(opts.gatewayStep(model, context, options), out)) return
        if (options.signal?.aborted) reply.fail(new Error('Request was aborted'), 'aborted')
        else reply.finishResult(outcome.result)
      } else if (outcome.kind === 'result') reply.finishResult(outcome.result)
      else reply.fail(new Error('Request was aborted'), 'aborted')
    } catch (err) {
      if (options.signal?.aborted) reply.fail(new Error('Request was aborted'), 'aborted')
      else reply.fail(processDied(err) ?? err)
    }
  })()
  return out
}

/**
 * The SDK's error for a `claude` process that died (`Claude Code process terminated by signal
 * SIGKILL`, `... exited with code 137`) says nothing a person can act on. The session itself is
 * intact: the next message resumes it in a new process.
 */
export function processDied(err: unknown): Error | undefined {
  const message = err instanceof Error ? err.message : String(err)
  const died = /Claude Code process (terminated by signal (SIG[A-Z0-9]+)|exited with code (\d+))/.exec(message)
  if (!died) return undefined
  const why = died[2] === 'SIGKILL' || died[3] === '137' ? ' (it was killed, most likely because the sandbox ran out of memory)' : ''
  return new Error(`Claude Code stopped unexpectedly${why}. Your session is intact: send a message to continue.`, { cause: err })
}

/** The pi-ai provider. Claude Code owns the login, so pi resolves no credential for it. */
export function createClaudeProvider(opts: ClaudeProviderOptions): Provider<Api> {
  const streams = {
    stream: (model: Model<Api>, context: TranscriptContext, options?: StreamOptions) => stream(opts, model, context, options),
    streamSimple: (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => stream(opts, model, context, options),
  }
  return createProvider({
    id: CLAUDE_AGENT_PROVIDER_ID,
    name: CLAUDE_AGENT_PROVIDER_NAME,
    auth: {
      apiKey: {
        name: 'Claude subscription (Claude Code)',
        resolve: async () => ({ auth: { apiKey: 'claude-code' }, source: 'Claude Code' }),
      },
    },
    models: CLAUDE_AGENT_MODELS.map(claudeModel),
    api: streams,
  }) as Provider<Api>
}
