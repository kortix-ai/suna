import { describe, expect, test } from 'bun:test'

import { withModelLimits } from '../opencode'

describe('withModelLimits', () => {
  test('backfills a context window for a gateway model that arrives without one', () => {
    const out = withModelLimits({ 'deepseek/deepseek-v4-flash': { name: 'DeepSeek V4 Flash' } })
    expect(out['deepseek/deepseek-v4-flash']!.limit?.context).toBeGreaterThan(0)
  })

  test('resolves a known model served under a different provider prefix by its bare id', () => {
    const out = withModelLimits({ 'alibaba-cn/deepseek-v4-flash': { name: 'DeepSeek V4 Flash' } })
    expect(out['alibaba-cn/deepseek-v4-flash']!.limit?.context).toBe(1_048_576)
  })

  test('gives the flagship default model its real window, not the fallback default', () => {
    const out = withModelLimits({ 'claude-sonnet-4.6': { name: 'Claude Sonnet 4.6' } })
    expect(out['claude-sonnet-4.6']!.limit?.context).toBe(1_000_000)
  })

  test('applies a conservative default for a model with no known limit', () => {
    const out = withModelLimits({ 'who/knows-9': { name: 'Mystery' } })
    expect(out['who/knows-9']!.limit).toEqual({ context: 200_000, output: 32_000 })
  })

  test('leaves a usable gateway-provided limit untouched', () => {
    const out = withModelLimits({ 'x/y': { name: 'Y', limit: { context: 333_000, output: 7_000 } } })
    expect(out['x/y']!.limit).toEqual({ context: 333_000, output: 7_000 })
  })

  test('treats a zero context limit as missing and backfills it', () => {
    const out = withModelLimits({ 'deepseek/deepseek-v4-pro': { name: 'Pro', limit: { context: 0 } } })
    expect(out['deepseek/deepseek-v4-pro']!.limit?.context).toBe(1_048_576)
  })
})
