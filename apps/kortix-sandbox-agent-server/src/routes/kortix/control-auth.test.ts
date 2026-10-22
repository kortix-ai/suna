import { describe, expect, test } from 'bun:test'
import { bearerMatches } from './control-auth'

describe('bearerMatches', () => {
  test('accepts only the exact bearer', () => {
    expect(bearerMatches('Bearer s3cret', 's3cret')).toBe(true)
    expect(bearerMatches('Bearer s3cre', 's3cret')).toBe(false)
    expect(bearerMatches('Bearer s3cret-longer', 's3cret')).toBe(false)
    expect(bearerMatches('Basic s3cret', 's3cret')).toBe(false)
    expect(bearerMatches(undefined, 's3cret')).toBe(false)
    expect(bearerMatches('Bearer ', 's3cret')).toBe(false)
  })
})
