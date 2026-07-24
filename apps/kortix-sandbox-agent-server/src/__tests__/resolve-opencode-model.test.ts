import { afterEach, describe, expect, test } from 'bun:test'

import { buildInitialPromptBody, resolveOpencodeModel } from '../main'

const ORIGINAL_MODEL = process.env.KORTIX_OPENCODE_MODEL
const ORIGINAL_LLM_BASE_URL = process.env.KORTIX_LLM_BASE_URL
const ORIGINAL_LLM_API_KEY = process.env.KORTIX_LLM_API_KEY
const ORIGINAL_LLM_PROXY_URL = process.env.KORTIX_LLM_PROXY_URL
const ORIGINAL_AGENT = process.env.KORTIX_AGENT_NAME

afterEach(() => {
  if (ORIGINAL_MODEL === undefined) delete process.env.KORTIX_OPENCODE_MODEL
  else process.env.KORTIX_OPENCODE_MODEL = ORIGINAL_MODEL
  if (ORIGINAL_LLM_BASE_URL === undefined) delete process.env.KORTIX_LLM_BASE_URL
  else process.env.KORTIX_LLM_BASE_URL = ORIGINAL_LLM_BASE_URL
  if (ORIGINAL_LLM_API_KEY === undefined) delete process.env.KORTIX_LLM_API_KEY
  else process.env.KORTIX_LLM_API_KEY = ORIGINAL_LLM_API_KEY
  if (ORIGINAL_LLM_PROXY_URL === undefined) delete process.env.KORTIX_LLM_PROXY_URL
  else process.env.KORTIX_LLM_PROXY_URL = ORIGINAL_LLM_PROXY_URL
  if (ORIGINAL_AGENT === undefined) delete process.env.KORTIX_AGENT_NAME
  else process.env.KORTIX_AGENT_NAME = ORIGINAL_AGENT
})

describe('resolveOpencodeModel', () => {
  test('normalizes prefixed native OpenCode Zen free models for prompt_async', () => {
    process.env.KORTIX_OPENCODE_MODEL = 'opencode/deepseek-v4-flash-free'

    expect(resolveOpencodeModel()).toEqual({
      providerID: 'opencode',
      modelID: 'deepseek-v4-flash-free',
    })
  })

  test('accepts bare native OpenCode Zen free model ids', () => {
    process.env.KORTIX_OPENCODE_MODEL = 'deepseek-v4-flash-free'

    expect(resolveOpencodeModel()).toEqual({
      providerID: 'opencode',
      modelID: 'deepseek-v4-flash-free',
    })
  })

  test('keeps normal provider/model overrides as OpenCode model objects', () => {
    process.env.KORTIX_OPENCODE_MODEL = 'anthropic/claude-sonnet-4-6'

    expect(resolveOpencodeModel()).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-6',
    })
  })

  test('routes a Codex wire model through the Kortix provider in gateway mode', () => {
    process.env.KORTIX_LLM_BASE_URL = 'https://api.kortix.test/v1/llm'
    process.env.KORTIX_LLM_API_KEY = 'test-key'
    process.env.KORTIX_OPENCODE_MODEL = 'codex/gpt-5.6-sol'

    expect(resolveOpencodeModel()).toEqual({
      providerID: 'kortix',
      modelID: 'codex/gpt-5.6-sol',
    })
  })

  test('routes a BYOK wire model through the Kortix provider in gateway mode', () => {
    process.env.KORTIX_LLM_BASE_URL = 'https://api.kortix.test/v1/llm'
    process.env.KORTIX_LLM_API_KEY = 'test-key'
    process.env.KORTIX_OPENCODE_MODEL = 'anthropic/claude-sonnet-4-6'

    expect(resolveOpencodeModel()).toEqual({
      providerID: 'kortix',
      modelID: 'anthropic/claude-sonnet-4-6',
    })
  })

  test('routes a bare managed model through the Kortix provider in gateway mode', () => {
    process.env.KORTIX_LLM_PROXY_URL = 'http://127.0.0.1:4319'
    process.env.KORTIX_OPENCODE_MODEL = 'glm-5.2'

    expect(resolveOpencodeModel()).toEqual({
      providerID: 'kortix',
      modelID: 'glm-5.2',
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

  // Regression guard for the agent-first compiler (compile-agent-config.ts):
  // the compiled agent map can now bake a default `model` onto an agent (or
  // the top-level config), but that's ONLY a fallback for when no explicit
  // model is passed on a request. KORTIX_OPENCODE_MODEL (an explicit session/
  // trigger override, resolved server-side from DB model-preferences) is
  // threaded through as the literal `model` on the boot prompt call — this
  // resolver must keep working exactly as before, independent of whatever
  // KORTIX_COMPILED_AGENT_CONFIG carries, so that explicit override still
  // wins over the manifest agent's declarative default.
  test('is unaffected by a server-compiled agent config being present alongside it', () => {
    process.env.KORTIX_OPENCODE_MODEL = 'anthropic/claude-opus-4-8'
    process.env.KORTIX_COMPILED_AGENT_CONFIG = JSON.stringify({
      model: 'anthropic/claude-sonnet-5',
      agent: { support: { model: 'anthropic/claude-sonnet-5' } },
    })

    try {
      expect(resolveOpencodeModel()).toEqual({
        providerID: 'anthropic',
        modelID: 'claude-opus-4-8',
      })
    } finally {
      delete process.env.KORTIX_COMPILED_AGENT_CONFIG
    }
  })
})

describe('buildInitialPromptBody', () => {
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

  test('omits the legacy default agent sentinel', () => {
    delete process.env.KORTIX_OPENCODE_MODEL
    process.env.KORTIX_AGENT_NAME = 'default'

    expect(buildInitialPromptBody('Run.')).toEqual({
      parts: [{ type: 'text', text: 'Run.' }],
    })
  })
})
