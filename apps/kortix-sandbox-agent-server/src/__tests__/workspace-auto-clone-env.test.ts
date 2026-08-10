import { describe, expect, test } from 'bun:test'

import { loadConfig } from '../config'

describe('Workspace auto-clone environment compatibility', () => {
  test('reads the canonical Workspace variable', () => {
    expect(loadConfig({ KORTIX_WORKSPACE_AUTO_CLONE: '1' }).autoClone).toBe(true)
  })

  test('falls back to the legacy Project variable', () => {
    expect(loadConfig({ KORTIX_PROJECT_AUTO_CLONE: '1' }).autoClone).toBe(true)
  })

  test('prefers the canonical value when both variables exist', () => {
    expect(
      loadConfig({
        KORTIX_WORKSPACE_AUTO_CLONE: '0',
        KORTIX_PROJECT_AUTO_CLONE: '1',
      }).autoClone,
    ).toBe(false)
  })
})
