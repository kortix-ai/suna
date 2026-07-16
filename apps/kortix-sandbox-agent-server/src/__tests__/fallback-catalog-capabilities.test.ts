import { describe, expect, test } from 'bun:test'
import { MINIMAL_FALLBACK_MODELS } from '../opencode'

describe('MINIMAL_FALLBACK_MODELS capability metadata', () => {
  test('openai/gpt-5.5 does not advertise temperature support', () => {
    expect(MINIMAL_FALLBACK_MODELS['openai/gpt-5.5']?.temperature).toBe(false)
  })

  test('no OpenAI reasoning model in the fallback catalog claims temperature support', () => {
    const offenders = Object.entries(MINIMAL_FALLBACK_MODELS)
      .filter(([id, model]) => id.startsWith('openai/') && model.reasoning && model.temperature)
      .map(([id]) => id)
    expect(offenders).toEqual([])
  })
})
