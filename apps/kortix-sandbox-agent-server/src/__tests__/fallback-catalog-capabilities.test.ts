import { describe, expect, test } from 'bun:test'
import { MINIMAL_FALLBACK_MODELS, withModelLimits } from '../opencode'

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

  // Regression coverage for the "every provider shows as Kortix" picker bug —
  // every fallback model must carry the REAL upstream provider explicitly
  // (managed models -> 'kortix', BYOK entries -> their real provider id), the
  // same field the served /v1/models catalog carries (catalog-models.ts).
  test('every fallback model carries an explicit `provider` field matching its wire id', () => {
    expect(MINIMAL_FALLBACK_MODELS['claude-opus-4.8']?.provider).toBe('kortix')
    expect(MINIMAL_FALLBACK_MODELS['glm-5.2']?.provider).toBe('kortix')
    expect(MINIMAL_FALLBACK_MODELS['openai/gpt-5.5']?.provider).toBe('openai')
    expect(MINIMAL_FALLBACK_MODELS['google/gemini-3.5-flash']?.provider).toBe('google')
    expect(MINIMAL_FALLBACK_MODELS['deepseek/deepseek-v4-flash']?.provider).toBe('deepseek')

    const missing = Object.entries(MINIMAL_FALLBACK_MODELS)
      .filter(([, model]) => typeof model.provider !== 'string' || model.provider.length === 0)
      .map(([id]) => id)
    expect(missing).toEqual([])
  })

  // Regression: the grok fallback entry's `provider` field used to be
  // 'x-ai' (a hyphenated id that has no PROVIDER_LABELS entry), while
  // @kortix/llm-catalog's PROVIDER_LABELS and the served /v1/models catalog
  // (catalog-models.ts) both key xAI as 'xai' (models.dev's real, hyphen-
  // free provider id). The mismatch made pickerGroupLabel miss the lookup
  // and fall back to the raw (always "Kortix") providerName for this one
  // fallback-only entry — reintroducing the "every provider = Kortix" bug
  // for exactly the models served when the gateway catalog fetch fails.
  test('grok fallback entry carries `provider: "xai"`, matching PROVIDER_LABELS + gatewayModelsAll', () => {
    expect(MINIMAL_FALLBACK_MODELS['x-ai/grok-4.3']?.provider).toBe('xai')
  })

  test('withModelLimits preserves the `provider` field while backfilling limits', () => {
    const withLimits = withModelLimits({
      'anthropic/claude-sonnet-4-6': { name: 'Claude Sonnet 4.6', provider: 'anthropic' },
    })
    expect(withLimits['anthropic/claude-sonnet-4-6']?.provider).toBe('anthropic')
    expect(withLimits['anthropic/claude-sonnet-4-6']?.limit?.context).toBeGreaterThan(0)
  })
})
