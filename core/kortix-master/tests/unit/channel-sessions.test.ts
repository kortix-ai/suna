import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'channel-sessions-test-'))
  process.env.KORTIX_WORKSPACE = tempDir
})

afterEach(() => {
  delete process.env.KORTIX_WORKSPACE
  rmSync(tempDir, { recursive: true, force: true })
})

async function loadModules() {
  const cacheBust = `?t=${Date.now()}${Math.random()}`
  const db = await import(`../../channels/channel-db.ts${cacheBust}`)
  const sessions = await import(`../../channels/channel-sessions.ts${cacheBust}`)
  return { ...db, ...sessions }
}

describe('channel sessions', () => {
  it('clears all active sessions for a channel config id', async () => {
    const { createChannel, rememberSession, getSessionState, clearChannelSessions } = await loadModules()
    const channel = createChannel({
      platform: 'slack',
      bot_token: 'xoxb-test',
      bot_username: 'settingsbot',
    })

    rememberSession(`slack:${channel.id}:thread:C123:1712160000.000100`, 'ses_one')
    rememberSession(`slack:${channel.id}:thread:C123:1712160001.000100`, 'ses_two')

    expect(getSessionState(`slack:${channel.id}:thread:C123:1712160000.000100`).currentId).toBe('ses_one')
    expect(getSessionState(`slack:${channel.id}:thread:C123:1712160001.000100`).currentId).toBe('ses_two')

    const cleared = clearChannelSessions('slack', channel.id)
    expect(cleared).toBe(2)
    expect(getSessionState(`slack:${channel.id}:thread:C123:1712160000.000100`).currentId).toBe(null)
    expect(getSessionState(`slack:${channel.id}:thread:C123:1712160001.000100`).currentId).toBe(null)
  })
})
