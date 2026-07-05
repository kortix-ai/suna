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
})
