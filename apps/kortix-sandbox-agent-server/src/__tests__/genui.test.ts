import { describe, expect, test } from 'bun:test'
import { genuiEnabled } from '@/lib/config/genui'

describe('genui flag', () => {
  test('only KORTIX_GENUI=1 enables it; missing means off', () => {
    expect(genuiEnabled({ KORTIX_GENUI: '1' })).toBe(true)
    expect(genuiEnabled({ KORTIX_GENUI: '0' })).toBe(false)
    expect(genuiEnabled({ KORTIX_GENUI: 'true' })).toBe(false)
    expect(genuiEnabled({})).toBe(false)
  })
})
