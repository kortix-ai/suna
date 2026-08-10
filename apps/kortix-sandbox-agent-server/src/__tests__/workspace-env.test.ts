import { describe, expect, test } from 'bun:test'

import { loadConfig } from '../config'
import { workspaceIdFromEnv } from '../workspace-env'

describe('Workspace environment compatibility', () => {
  test('uses the canonical Workspace id', () => {
    const env = { KORTIX_WORKSPACE_ID: 'workspace-canonical' }
    expect(workspaceIdFromEnv(env)).toBe('workspace-canonical')
    expect(loadConfig(env).workspaceId).toBe('workspace-canonical')
  })

  test('keeps the legacy Project id as a fallback', () => {
    const env = { KORTIX_PROJECT_ID: 'workspace-legacy' }
    expect(workspaceIdFromEnv(env)).toBe('workspace-legacy')
    expect(loadConfig(env).workspaceId).toBe('workspace-legacy')
  })

  test('canonical Workspace id wins during a rolling deployment', () => {
    const env = {
      KORTIX_WORKSPACE_ID: 'workspace-canonical',
      KORTIX_PROJECT_ID: 'workspace-legacy',
    }
    expect(workspaceIdFromEnv(env)).toBe('workspace-canonical')
    expect(loadConfig(env).workspaceId).toBe('workspace-canonical')
  })
})
