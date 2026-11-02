import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessageEventStream, type AssistantMessageEvent, type Message } from '@earendil-works/pi-ai'
import runtimeVersions from '../../../../packages/shared/src/runtime-versions.json' with { type: 'json' }
import { claudeModelFor } from '@/harness/pi/claude/provider'
import { CLAUDE_AGENT_SDK_VERSION, CLAUDE_CODE_INTEGRITY, ensureClaudeExecutable, installedClaudeExecutable } from '@/harness/pi/claude/install'
import { CLAUDE_GATEWAY_PLACEHOLDER_TOKEN, claudeEnv, claudeLoginKey, ClaudeLoginMissing } from '@/harness/pi/claude/sdk'
import { ClaudeReply } from '@/harness/pi/claude/stream'
import { catchUp, checkpoints, collectResults, decide, type SessionRecord } from '@/harness/pi/claude/sync'

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
const user = (text: string): Message => ({ role: 'user', content: text, timestamp: 1 })
const assistant = (text: string, calls: Array<{ id: string; name: string }> = []): Message => ({
  role: 'assistant',
  content: [{ type: 'text', text }, ...calls.map((call) => ({ type: 'toolCall' as const, id: call.id, name: call.name, arguments: { key: 'a' } }))],
  api: 'claude-agent',
  provider: 'claude-agent',
  model: 'haiku',
  usage,
  stopReason: calls.length ? 'toolUse' : 'stop',
  timestamp: 2,
})
const result = (id: string, text: string): Message => ({ role: 'toolResult', toolCallId: id, toolName: 'lookup', content: [{ type: 'text', text }], isError: false, timestamp: 3 })

/** The record a finished request leaves: pi's context, then the reply, each with a Claude message id. */
function recordOf(messages: Message[], reply: Message): SessionRecord {
  return { claudeSessionID: 'claude-session', history: checkpoints({ messages, userID: 'u1', reply, replyID: 'a1', toolMessages: new Map() }) }
}

describe('Claude history sync', () => {
  test('no record is a fresh Claude session from the first message', () => {
    expect(decide([user('hi')])).toEqual({ kind: 'fresh', start: 0 })
  })

  test('a new user message after what Claude saw continues the session with that message only', () => {
    const first = [user('hi')]
    const reply = assistant('hello')
    const next = [...first, reply, user('again')]
    expect(decide(next, recordOf(first, reply))).toEqual({ kind: 'continue', start: 2 })
    const blocks = catchUp(next, 2)
    expect(blocks).toEqual([{ type: 'text', text: 'again' }])
  })

  test('turns another model wrote after Claude reach Claude as one conversation checkpoint', () => {
    const first = [user('hi')]
    const reply = assistant('hello')
    const next = [...first, reply, user('switch'), { ...assistant('teal, from another model'), provider: 'kortix' } as Message, user('back to Claude')]
    const decision = decide(next, recordOf(first, reply))
    expect(decision).toEqual({ kind: 'catch-up', start: 2 })
    const text = catchUp(next, decision.start).map((block) => (block.type === 'text' ? block.text : '[image]')).join('\n')
    expect(text).toContain('<conversation-checkpoint>')
    expect(text).toContain('teal, from another model')
    expect(text.indexOf('back to Claude')).toBeGreaterThan(text.indexOf('</conversation-checkpoint>'))
  })

  test('an earlier message that changed (a compaction, a rewind) is a changed history', () => {
    const first = [user('hi')]
    const reply = assistant('hello')
    expect(decide([user('summary of everything'), assistant('ok'), user('next')], recordOf(first, reply)).kind).toBe('fresh')
    expect(decide([user('hi'), assistant('a different reply'), user('next')], recordOf(first, reply)).kind).toBe('changed')
  })

  test('thinking does not change what Claude saw', () => {
    const first = [user('hi')]
    const reply = assistant('hello')
    const withThinking = { ...reply, content: [{ type: 'thinking' as const, thinking: 'hmm' }, ...((reply as unknown as { content: never[] }).content)] } as Message
    expect(decide([...first, withThinking, user('next')], recordOf(first, reply)).kind).toBe('continue')
  })

  test('tool results after a reply that called tools are collected by call id', () => {
    const messages = [user('hi'), assistant('', [{ id: 't1', name: 'lookup' }, { id: 't2', name: 'lookup' }]), result('t1', 'one'), result('t2', 'two'), user('steer')]
    const collected = collectResults(messages, 2)
    expect([...collected.results.keys()]).toEqual(['t1', 't2'])
    expect(collected.end).toBe(4)
  })
})

describe('Claude Code output as a pi response', () => {
  const tools = [{ name: 'lookup' }]
  const events = (feed: (reply: ClaudeReply) => void) => {
    const stream = createAssistantMessageEventStream()
    const seen: AssistantMessageEvent[] = []
    const reply = new ClaudeReply(stream, claudeModelFor('haiku'), tools, () => true)
    void (async () => {
      for await (const event of stream) seen.push(event)
    })()
    feed(reply)
    return { reply, seen }
  }
  const streamEvent = (event: unknown) => ({ type: 'stream_event', event, parent_tool_use_id: null, uuid: 'x', session_id: 's' }) as never

  test('text streams as deltas, a Kortix tool call becomes a pi tool call, and another tool is left out', async () => {
    const { reply, seen } = events((r) => {
      r.push(streamEvent({ type: 'message_start', message: { id: 'm1', model: 'claude-haiku-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 100 } } }))
      r.push(streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      r.push(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Look' } }))
      r.push(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ing' } }))
      r.push(streamEvent({ type: 'content_block_stop', index: 0 }))
      r.push(streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'mcp__kortix__lookup' } }))
      r.push(streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"key":"a"}' } }))
      r.push(streamEvent({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't2', name: 'Bash' } }))
      r.push({ type: 'assistant', parent_tool_use_id: null, uuid: 'a1', session_id: 's', message: { id: 'm1', content: [{ type: 'text', text: 'Looking' }, { type: 'tool_use', id: 't1', name: 'mcp__kortix__lookup', input: { key: 'a' } }, { type: 'tool_use', id: 't2', name: 'Bash', input: {} }], usage: { input_tokens: 10, output_tokens: 7 } } } as never)
      r.push(streamEvent({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }))
      r.finishTools()
    })
    await Bun.sleep(0)
    expect(reply.message.content).toEqual([{ type: 'text', text: 'Looking' }, { type: 'toolCall', id: 't1', name: 'lookup', arguments: { key: 'a' } }])
    expect(reply.message.stopReason).toBe('toolUse')
    expect(reply.claudeMessageID).toBe('a1')
    expect(seen.filter((e) => e.type === 'text_delta').map((e) => (e as { delta: string }).delta)).toEqual(['Look', 'ing'])
    expect(seen.map((e) => e.type)).toContain('toolcall_end')
    expect(seen.at(-1)?.type).toBe('done')
    // The highest count Claude Code reported, never a sum of repeats.
    expect(reply.message.usage).toMatchObject({ input: 10, cacheRead: 100, output: 9, cost: { total: 0 } })
  })

  test("the last step of a parked Claude turn reports its own call's context, not the turn's total", async () => {
    // One Claude turn spans every pi step since the user's message (tool calls
    // park it), and Claude Code's `result.usage` sums all of that turn's calls.
    const { reply } = events((r) => {
      r.push(streamEvent({ type: 'message_start', message: { id: 'm6', model: 'claude-opus-5-5', usage: { input_tokens: 2, cache_read_input_tokens: 172_969, cache_creation_input_tokens: 495 } } }))
      r.push(streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      r.push(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } }))
      r.push(streamEvent({ type: 'content_block_stop', index: 0 }))
      r.push(streamEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4014 } }))
      r.finishResult({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', num_turns: 6, usage: { input_tokens: 14, cache_read_input_tokens: 997_995, cache_creation_input_tokens: 175_002, output_tokens: 7_395 } } as never)
    })
    await Bun.sleep(0)
    expect(reply.message.usage).toMatchObject({ input: 2, cacheRead: 172_969, cacheWrite: 495, output: 4014 })
    expect(reply.message.usage.totalTokens).toBeLessThan(200_000)
  })

  test('a reply whose calls streamed no usage takes the result usage only for a one-call turn', async () => {
    const one = events((r) => r.finishResult({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, usage: { input_tokens: 5, cache_read_input_tokens: 1000, output_tokens: 20 } } as never))
    const many = events((r) => r.finishResult({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 6, usage: { input_tokens: 14, cache_read_input_tokens: 997_995, output_tokens: 7_395 } } as never))
    await Bun.sleep(0)
    expect(one.reply.message.usage).toMatchObject({ input: 5, cacheRead: 1000, output: 20 })
    expect(many.reply.message.usage).toMatchObject({ input: 0, cacheRead: 0, cacheWrite: 0 })
  })

  test('a subscription limit ends the turn with the limit and its reset time', async () => {
    const { reply } = events((r) => {
      r.push({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_900_000_000 } } as never)
      r.push({ type: 'assistant', parent_tool_use_id: null, uuid: 'a1', session_id: 's', error: 'rate_limit', message: { id: 'm1', content: [] } } as never)
      r.finishResult({ type: 'result', subtype: 'success', is_error: true, result: '', api_error_status: 429, usage: {} } as never)
    })
    await Bun.sleep(0)
    expect(reply.message.stopReason).toBe('error')
    expect(reply.message.errorMessage).toBe('Your Claude subscription limit is reached (five hour). It resets at 2030-03-17T17:46:40.000Z.')
  })
})

describe('the Claude login', () => {
  test('Claude Code calls the gateway through the localhost proxy with a placeholder, and no Kortix credential', () => {
    const env: NodeJS.ProcessEnv = {
      KORTIX_LLM_PROXY_URL: 'http://127.0.0.1:4111/', KORTIX_LLM_BASE_URL: 'https://gateway.test/v1/llm',
      PATH: '/usr/bin', ANTHROPIC_API_KEY: 'project-key', ANTHROPIC_BASE_URL: 'https://elsewhere.test', KORTIX_TOKEN: 'kortix-token', HOME: '/home/kortix',
    }
    const state = mkdtempSync(join(tmpdir(), 'kortixd-claude-'))
    const child = claudeEnv(state, env)
    expect(child.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:4111/claude-code')
    expect(child.CLAUDE_CODE_OAUTH_TOKEN).toBe(CLAUDE_GATEWAY_PLACEHOLDER_TOKEN)
    // A project secret named ANTHROPIC_API_KEY would bill an API key instead of the subscription.
    expect(child.ANTHROPIC_API_KEY).toBeUndefined()
    expect(child.KORTIX_TOKEN).toBeUndefined()
    expect(child.KORTIX_LLM_PROXY_URL).toBeUndefined()
    expect(child.PATH).toBe('/usr/bin')
    expect(child.DISABLE_AUTO_COMPACT).toBe('1')
  })

  test('without the proxy Claude Code calls the gateway with the session credential; without a gateway it cannot run', () => {
    const state = mkdtempSync(join(tmpdir(), 'kortixd-claude-'))
    const direct: NodeJS.ProcessEnv = { KORTIX_LLM_PROXY_URL: 'http://127.0.0.1:4111', KORTIX_LLM_PROXY_DISABLE: '1', KORTIX_LLM_BASE_URL: 'https://gateway.test/v1/llm/', KORTIX_TOKEN: 'kortix-token' }
    const child = claudeEnv(state, direct)
    expect(child.ANTHROPIC_BASE_URL).toBe('https://gateway.test/v1/llm/claude-code')
    expect(child.CLAUDE_CODE_OAUTH_TOKEN).toBe('kortix-token')
    // A changed session credential starts a new claude process.
    expect(claudeLoginKey(direct)).not.toBe(claudeLoginKey({ ...direct, KORTIX_TOKEN: 'rotated' }))
    expect(() => claudeEnv(state, { PATH: '/usr/bin' })).toThrow(ClaudeLoginMissing)
  })

  test('kortixd pins the Claude Agent SDK every image installs Claude Code from', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '../../package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(pkg.dependencies['@anthropic-ai/claude-agent-sdk']).toBe(runtimeVersions.claudeAgentSdk)
    const sdk = JSON.parse(readFileSync(join(import.meta.dir, '../../node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8')) as { claudeCodeVersion: string }
    expect(sdk.claudeCodeVersion).toBe(runtimeVersions.claudeCode)
  })
})

describe('Claude Code on a box whose image lacks it', () => {
  test('installs only the pinned package the lockfile records', () => {
    const lock = readFileSync(join(import.meta.dir, '../../bun.lock'), 'utf8')
    for (const target of ['x64', 'arm64'] as const) {
      expect(lock).toContain(`"@anthropic-ai/claude-agent-sdk-linux-${target}@${CLAUDE_AGENT_SDK_VERSION}", "", { "os": "linux", "cpu": "${target}" }, "${CLAUDE_CODE_INTEGRITY[target]}"`)
    }
  })

  test('refuses a download whose checksum is not the pin, and installs nothing', async () => {
    const registry = Bun.serve({ port: 0, fetch: () => new Response(new Uint8Array([1, 2, 3])) })
    const state = mkdtempSync(join(tmpdir(), 'kortixd-claude-install-'))
    // No image binary and no `claude` on PATH: the install path runs.
    const env = { PATH: mkdtempSync(join(tmpdir(), 'empty-path-')), KORTIX_NPM_REGISTRY: `http://127.0.0.1:${registry.port}` }
    try {
      await expect(ensureClaudeExecutable(state, env)).rejects.toThrow('does not match its pinned checksum')
      expect(installedClaudeExecutable(state)).toBeUndefined()
    } finally {
      registry.stop(true)
    }
  })
})
