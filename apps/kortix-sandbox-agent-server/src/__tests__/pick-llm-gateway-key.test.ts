import { describe, expect, test } from 'bun:test'
import { pickLlmGatewayKey } from '../opencode'

describe('pickLlmGatewayKey', () => {
  test('current box: the session PAT in KORTIX_TOKEN wins', () => {
    expect(pickLlmGatewayKey({ KORTIX_TOKEN: 'kortix_pat_new', KORTIX_LLM_API_KEY: 'kortix_pat_old' })).toBe('kortix_pat_new')
  })
  test('2026-07 box: service key in KORTIX_TOKEN, PAT under KORTIX_LLM_API_KEY', () => {
    expect(pickLlmGatewayKey({ KORTIX_TOKEN: 'kortix_sb_x', KORTIX_LLM_API_KEY: 'kortix_pat_legacy' })).toBe('kortix_pat_legacy')
  })
  test('nothing PAT-shaped: fall back to KORTIX_TOKEN, then the legacy key, then undefined', () => {
    expect(pickLlmGatewayKey({ KORTIX_TOKEN: 'kortix_sb_x' })).toBe('kortix_sb_x')
    expect(pickLlmGatewayKey({ KORTIX_LLM_API_KEY: 'something' })).toBe('something')
    expect(pickLlmGatewayKey({})).toBeUndefined()
  })
})
