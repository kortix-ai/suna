import { afterEach, describe, expect, test } from 'bun:test'

import { buildInitialPromptBody, resolveOpencodeModel } from '../harness/open-code/boot'

const ORIGINAL_MODEL = process.env.KORTIX_OPENCODE_MODEL
const ORIGINAL_LLM_BASE_URL = process.env.KORTIX_LLM_BASE_URL
const ORIGINAL_LLM_API_KEY = process.env.KORTIX_TOKEN
const ORIGINAL_LLM_PROXY_URL = process.env.KORTIX_LLM_PROXY_URL
const ORIGINAL_AGENT = process.env.KORTIX_AGENT_NAME

afterEach(() => {
  if (ORIGINAL_MODEL === undefined) delete process.env.KORTIX_OPENCODE_MODEL
  else process.env.KORTIX_OPENCODE_MODEL = ORIGINAL_MODEL
  if (ORIGINAL_LLM_BASE_URL === undefined) delete process.env.KORTIX_LLM_BASE_URL
  else process.env.KORTIX_LLM_BASE_URL = ORIGINAL_LLM_BASE_URL
  if (ORIGINAL_LLM_API_KEY === undefined) delete process.env.KORTIX_TOKEN
  else process.env.KORTIX_TOKEN = ORIGINAL_LLM_API_KEY
  if (ORIGINAL_LLM_PROXY_URL === undefined) delete process.env.KORTIX_LLM_PROXY_URL
  else process.env.KORTIX_LLM_PROXY_URL = ORIGINAL_LLM_PROXY_URL
  if (ORIGINAL_AGENT === undefined) delete process.env.KORTIX_AGENT_NAME
  else process.env.KORTIX_AGENT_NAME = ORIGINAL_AGENT
})

describe('resolveOpencodeModel', () => {
  // Native mode: no gateway env at all. Ambient KORTIX_LLM_* in the shell or a
  // prior test would silently switch these rows to gateway mode.
  test.each([
    ['a prefixed OpenCode Zen model', 'opencode/deepseek-v4-flash-free', { providerID: 'opencode', modelID: 'deepseek-v4-flash-free' }],
    ['a bare OpenCode Zen id', 'deepseek-v4-flash-free', { providerID: 'opencode', modelID: 'deepseek-v4-flash-free' }],
    ['a provider/model override', 'anthropic/claude-sonnet-4-6', { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' }],
    // A pin stored while the gateway was ON can survive a live toggle to
    // native mode: a nested ref unwraps to the provider it wraps.
    ['a stale kortix/<provider>/<model> pin', 'kortix/anthropic/claude-sonnet-4-6', { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' }],
  ])('native mode resolves %s', (_name, model, expected) => {
    delete process.env.KORTIX_LLM_BASE_URL
    delete process.env.KORTIX_LLM_PROXY_URL
    process.env.KORTIX_OPENCODE_MODEL = model

    expect(resolveOpencodeModel()).toEqual(expected)
  })

  test('native mode drops a stale bare kortix/<managed-id> pin', () => {
    // A bare managed id has no native provider; OpenCode's own default applies
    // instead of a prompt against the nonexistent `kortix` provider.
    delete process.env.KORTIX_LLM_BASE_URL
    delete process.env.KORTIX_LLM_PROXY_URL
    process.env.KORTIX_OPENCODE_MODEL = 'kortix/glm-5.3-flash'

    expect(resolveOpencodeModel()).toBeUndefined()
  })

  // Gateway mode keeps the whole wire ref as the Kortix model id: `codex` read
  // as an OpenCode provider answers ModelNotFound.
  test.each(['codex/gpt-5.6-sol', 'anthropic/claude-sonnet-4-6'])(
    'gateway mode routes the wire model %j through the Kortix provider',
    (model) => {
      delete process.env.KORTIX_LLM_PROXY_URL
      process.env.KORTIX_LLM_BASE_URL = 'https://api.kortix.test/v1/llm'
      process.env.KORTIX_TOKEN = 'test-key'
      process.env.KORTIX_OPENCODE_MODEL = model

      expect(resolveOpencodeModel()).toEqual({ providerID: 'kortix', modelID: model })
    },
  )

  test('routes a bare managed model through the Kortix provider when only the LLM proxy is set', () => {
    delete process.env.KORTIX_LLM_BASE_URL
    process.env.KORTIX_LLM_PROXY_URL = 'http://127.0.0.1:4319'
    process.env.KORTIX_OPENCODE_MODEL = 'glm-5.3-flash'

    expect(resolveOpencodeModel()).toEqual({
      providerID: 'kortix',
      modelID: 'glm-5.3-flash',
    })
  })

  test('accepts an explicit Kortix OpenCode model reference in gateway mode', () => {
    process.env.KORTIX_LLM_PROXY_URL = 'http://127.0.0.1:4319'
    process.env.KORTIX_OPENCODE_MODEL = 'kortix/codex/gpt-5.6-sol'

    expect(resolveOpencodeModel()).toEqual({
      providerID: 'kortix',
      modelID: 'codex/gpt-5.6-sol',
    })
  })
})

describe('buildInitialPromptBody', () => {
  test('uses the control-plane message identity for the daemon-delivered turn', () => {
    delete process.env.KORTIX_OPENCODE_MODEL
    process.env.KORTIX_AGENT_NAME = 'default'
    expect(buildInitialPromptBody('Run for 90 seconds.', 'msg_initial_turn')).toEqual({
      messageID: 'msg_initial_turn',
      parts: [{ type: 'text', text: 'Run for 90 seconds.' }],
    })
  })

  test('applies the session model and concrete selected agent to an automated first turn', () => {
    process.env.KORTIX_LLM_PROXY_URL = 'http://127.0.0.1:4319'
    process.env.KORTIX_OPENCODE_MODEL = 'anthropic/claude-sonnet-4-6'
    process.env.KORTIX_AGENT_NAME = 'asana-refresher'

    expect(buildInitialPromptBody('Refresh the Asana snapshot.')).toEqual({
      parts: [{ type: 'text', text: 'Refresh the Asana snapshot.' }],
      model: {
        providerID: 'kortix',
        modelID: 'anthropic/claude-sonnet-4-6',
      },
      agent: 'asana-refresher',
    })
  })
})
