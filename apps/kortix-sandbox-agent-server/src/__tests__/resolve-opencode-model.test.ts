import { afterEach, describe, expect, test } from 'bun:test'

import { resolveOpencodeModel } from '../main'

const ORIGINAL_MODEL = process.env.KORTIX_OPENCODE_MODEL

afterEach(() => {
  if (ORIGINAL_MODEL === undefined) delete process.env.KORTIX_OPENCODE_MODEL
  else process.env.KORTIX_OPENCODE_MODEL = ORIGINAL_MODEL
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
