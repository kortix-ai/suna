import { describe, expect, it } from 'bun:test'

import { upstreamErrorDetail } from './runtime'

// Guards the tight rule behind the codex "error delivered as message content"
// detector: it must fire on the proven-live Codex/ChatGPT rejection envelope
// and NEVER on a real answer, even one that happens to be JSON.
describe('upstreamErrorDetail', () => {
  it('extracts the detail from the exact ChatGPT unsupported-model rejection', () => {
    const text =
      '{"detail":"The \'openai/gpt-5.4\' model is not supported when using Codex with a ChatGPT account."}\n\n'
    expect(upstreamErrorDetail(text)).toBe(
      "The 'openai/gpt-5.4' model is not supported when using Codex with a ChatGPT account.",
    )
  })

  it('tolerates leading/trailing whitespace around the envelope', () => {
    expect(upstreamErrorDetail('   {"detail":"boom"}   ')).toBe('boom')
  })

  it('accepts an error envelope with extra error-shaped keys', () => {
    expect(upstreamErrorDetail('{"detail":"nope","code":"model_not_supported","status":400}')).toBe('nope')
  })

  it('returns null for a real answer that merely contains JSON', () => {
    expect(
      upstreamErrorDetail('Here is the config you asked for: {"detail":"a field named detail"} — done.'),
    ).toBeNull()
  })

  it('returns null for a JSON answer with domain keys (no error shape)', () => {
    expect(upstreamErrorDetail('{"result":"ok","value":42}')).toBeNull()
  })

  it('returns null for a JSON object that has detail plus a domain key', () => {
    expect(upstreamErrorDetail('{"detail":"the summary","chapters":["one","two"]}')).toBeNull()
  })

  it('returns null when detail is empty or not a string', () => {
    expect(upstreamErrorDetail('{"detail":""}')).toBeNull()
    expect(upstreamErrorDetail('{"detail":123}')).toBeNull()
  })

  it('returns null for plain prose, empty text, and non-object JSON', () => {
    expect(upstreamErrorDetail('The model could not be reached.')).toBeNull()
    expect(upstreamErrorDetail('')).toBeNull()
    expect(upstreamErrorDetail('["detail"]')).toBeNull()
    expect(upstreamErrorDetail('"detail"')).toBeNull()
  })
})
