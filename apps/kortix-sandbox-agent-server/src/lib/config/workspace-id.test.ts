import { describe, expect, test } from 'bun:test'
import { loadHostConfig } from './config'
import { workspaceIdFromEnv } from './workspace-id'

// Synthetic ids.
const WS = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

describe('workspaceIdFromEnv', () => {
  test('reads KORTIX_WORKSPACE_ID', () => {
    expect(workspaceIdFromEnv({ KORTIX_WORKSPACE_ID: WS })).toBe(WS)
  })

  test('falls back to KORTIX_PROJECT_ID, the older name a box started before workspaces carries', () => {
    expect(workspaceIdFromEnv({ KORTIX_PROJECT_ID: WS })).toBe(WS)
  })

  test('KORTIX_WORKSPACE_ID wins when both are set (the CLI rule)', () => {
    expect(workspaceIdFromEnv({ KORTIX_WORKSPACE_ID: WS, KORTIX_PROJECT_ID: OTHER })).toBe(WS)
  })

  test('trims, and a blank value is unset', () => {
    expect(workspaceIdFromEnv({ KORTIX_WORKSPACE_ID: '  ', KORTIX_PROJECT_ID: ` ${WS} ` })).toBe(WS)
    expect(workspaceIdFromEnv({})).toBe('')
  })

  test('is not KORTIX_WORKSPACE, the /workspace directory path', () => {
    expect(workspaceIdFromEnv({ KORTIX_WORKSPACE: '/workspace' })).toBe('')
  })
})

describe('loadHostConfig projectId', () => {
  test('a box with only KORTIX_WORKSPACE_ID knows its workspace', () => {
    expect(loadHostConfig({ KORTIX_WORKSPACE_ID: WS }).projectId).toBe(WS)
  })

  test('a box with only KORTIX_PROJECT_ID is unchanged', () => {
    expect(loadHostConfig({ KORTIX_PROJECT_ID: WS }).projectId).toBe(WS)
  })

  test('neither set: undefined, as before', () => {
    expect(loadHostConfig({}).projectId).toBeUndefined()
  })
})
