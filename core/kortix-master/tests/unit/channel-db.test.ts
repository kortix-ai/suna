/**
 * Unit tests for channel-db.ts — SQLite channel config store.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Point the DB to a temp dir
let tempDir: string
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'channel-db-test-'))
  process.env.KORTIX_WORKSPACE = tempDir
})
afterEach(() => {
  // Force re-init on next test
  delete process.env.KORTIX_WORKSPACE
  rmSync(tempDir, { recursive: true, force: true })
})

// Dynamic import so env is set before module loads
async function loadDb() {
  // Clear module cache by using a unique import each time
  const mod = await import(`../../channels/channel-db.ts?t=${Date.now()}${Math.random()}`)
  return mod
}

describe('channel-db', () => {
  it('creates channels table on first access', async () => {
    const { getDb } = await loadDb()
    const db = getDb()
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='channels'").all()
    expect(tables).toHaveLength(1)
  })

  it('creates a telegram channel with a readable default name from the bot username', async () => {
    const { createChannel } = await loadDb()
    const ch = createChannel({
      platform: 'telegram',
      bot_token: 'test-token-123',
      bot_id: '999',
      bot_username: 'test_bot',
    })
    expect(ch.id).toBeTruthy()
    expect(ch.platform).toBe('telegram')
    expect(ch.name).toBe('Telegram @test_bot')
    expect(ch.enabled).toBe(true)
    expect(ch.bot_token).toBe('test-token-123')
    expect(ch.webhook_path).toContain('/hooks/telegram/')
    expect(ch.webhook_secret).toBeTruthy()
    expect(ch.webhook_secret.length).toBeGreaterThan(16)
  })

  it('creates a slack channel with custom name', async () => {
    const { createChannel } = await loadDb()
    const ch = createChannel({
      platform: 'slack',
      name: 'My Slack Bot',
      bot_token: 'xoxb-test',
      signing_secret: 'secret123',
      bot_username: 'mybot',
    })
    expect(ch.name).toBe('My Slack Bot')
    expect(ch.signing_secret).toBe('secret123')
    expect(ch.webhook_path).toContain('/hooks/slack/')
  })

  it('lists channels filtered by platform', async () => {
    const { createChannel, listChannels } = await loadDb()
    createChannel({ platform: 'telegram', bot_token: 'tg1' })
    createChannel({ platform: 'slack', bot_token: 'sl1' })
    createChannel({ platform: 'telegram', bot_token: 'tg2' })

    const all = listChannels()
    expect(all).toHaveLength(3)

    const tg = listChannels('telegram')
    expect(tg).toHaveLength(2)

    const sl = listChannels('slack')
    expect(sl).toHaveLength(1)
  })

  it('gets channel by ID', async () => {
    const { createChannel, getChannel } = await loadDb()
    const ch = createChannel({ platform: 'telegram', bot_token: 'tok' })
    const found = getChannel(ch.id)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(ch.id)
  })

  it('gets channel by webhook path', async () => {
    const { createChannel, getChannelByPath } = await loadDb()
    const ch = createChannel({ platform: 'telegram', bot_token: 'tok' })
    const found = getChannelByPath(ch.webhook_path)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(ch.id)
  })

  it('enables and disables channels', async () => {
    const { createChannel, enableChannel, disableChannel, getChannel } = await loadDb()
    const ch = createChannel({ platform: 'telegram', bot_token: 'tok' })
    expect(ch.enabled).toBe(true)

    disableChannel(ch.id)
    expect(getChannel(ch.id)!.enabled).toBe(false)

    enableChannel(ch.id)
    expect(getChannel(ch.id)!.enabled).toBe(true)
  })

  it('updates channel settings', async () => {
    const { createChannel, updateChannel } = await loadDb()
    const ch = createChannel({ platform: 'telegram', bot_token: 'tok' })

    updateChannel(ch.id, { default_agent: 'worker', default_model: 'openai/gpt-4o', bridge_instructions: 'Acknowledge first.' })
    const { createChannel: _, getChannel } = await loadDb()
    const updated = getChannel(ch.id)!
    expect(updated.default_agent).toBe('worker')
    expect(updated.default_model).toBe('openai/gpt-4o')
    expect(updated.bridge_instructions).toBe('Acknowledge first.')
  })

  it('deletes a channel', async () => {
    const { createChannel, deleteChannel, getChannel } = await loadDb()
    const ch = createChannel({ platform: 'telegram', bot_token: 'tok' })
    expect(getChannel(ch.id)).not.toBeNull()

    const result = deleteChannel(ch.id)
    expect(result).toBe(true)
    expect(getChannel(ch.id)).toBeNull()
  })

  it('generates unique names', async () => {
    const { createChannel } = await loadDb()
    const names = new Set<string>()
    for (let i = 0; i < 10; i++) {
      const ch = createChannel({ platform: 'telegram', bot_token: `tok${i}` })
      expect(names.has(ch.name)).toBe(false)
      names.add(ch.name)
    }
  })

  it('enforces unique webhook paths', async () => {
    const { createChannel } = await loadDb()
    const ch1 = createChannel({ platform: 'telegram', bot_token: 'tok1' })
    const ch2 = createChannel({ platform: 'telegram', bot_token: 'tok2' })
    expect(ch1.webhook_path).not.toBe(ch2.webhook_path)
  })

  it('cleans up legacy channel shadow connectors', async () => {
    const { getDb, cleanupLegacyChannelConnectors } = await loadDb()
    const db = getDb()
    db.exec(`
      CREATE TABLE IF NOT EXISTS connectors (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        source TEXT,
        pipedream_slug TEXT,
        env_keys TEXT,
        notes TEXT,
        auto_generated INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    db.prepare(`
      INSERT INTO connectors (id, name, description, source, notes, auto_generated, created_at, updated_at)
      VALUES ('1', 'telegram-kortix-old', 'old shadow row', 'channel', 'Channel ID: abc', 1, 'now', 'now')
    `).run()

    const removed = cleanupLegacyChannelConnectors()
    expect(removed).toBeGreaterThanOrEqual(1)

    const remaining = db.query("SELECT * FROM connectors WHERE source = 'channel'").all() as any[]
    expect(remaining).toHaveLength(0)
  })
})
