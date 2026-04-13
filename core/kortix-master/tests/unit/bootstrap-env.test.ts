import { beforeEach, describe, expect, test } from 'bun:test'

const ORIGINAL = {
  KORTIX_TOKEN: process.env.KORTIX_TOKEN,
  INTERNAL_SERVICE_KEY: process.env.INTERNAL_SERVICE_KEY,
  TUNNEL_TOKEN: process.env.TUNNEL_TOKEN,
}

beforeEach(() => {
  process.env.KORTIX_TOKEN = ORIGINAL.KORTIX_TOKEN
  process.env.INTERNAL_SERVICE_KEY = ORIGINAL.INTERNAL_SERVICE_KEY
  process.env.TUNNEL_TOKEN = ORIGINAL.TUNNEL_TOKEN
})

describe('normalizeBootstrapAuthAliases', () => {
  test('forces INTERNAL_SERVICE_KEY and TUNNEL_TOKEN to match KORTIX_TOKEN', async () => {
    const { normalizeBootstrapAuthAliases } = await import('../../src/services/bootstrap-env')

    process.env.KORTIX_TOKEN = 'kortix_sb_canonical'
    process.env.INTERNAL_SERVICE_KEY = 'stale-inbound-key'
    process.env.TUNNEL_TOKEN = 'stale-tunnel-key'

    const updated = normalizeBootstrapAuthAliases()

    expect(updated).toBe(2)
    expect(process.env.INTERNAL_SERVICE_KEY).toBe('kortix_sb_canonical')
    expect(process.env.TUNNEL_TOKEN).toBe('kortix_sb_canonical')
  })
})
