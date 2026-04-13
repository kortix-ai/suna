import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHmac } from 'crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const FIXTURES = join(import.meta.dir, '../fixtures/channels')

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf-8'))
}

function signSlackRequest(body: string, secret: string): { signature: string; timestamp: string } {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const sigBase = `v0:${timestamp}:${body}`
  const signature = 'v0=' + createHmac('sha256', secret).update(sigBase).digest('hex')
  return { signature, timestamp }
}

describe('Slack channel webhook route', () => {
  const originalWorkspace = process.env.KORTIX_WORKSPACE
  const originalFetch = globalThis.fetch
  let workspace = ''
  const fetchCalls: Array<{ url: string; body: any }> = []

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'slack-route-e2e-'))
    process.env.KORTIX_WORKSPACE = workspace
    process.env.INTERNAL_SERVICE_KEY = 'kortix_sb_test'
    process.env.KORTIX_TOKEN = 'kortix_sb_test'
    fetchCalls.length = 0

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const body = init?.body ? JSON.parse(String(init.body)) : null
      fetchCalls.push({ url, body })
      if (url === 'http://localhost:4096/session') {
        return new Response(JSON.stringify({ id: 'sess-slack-route' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === 'http://localhost:4096/session/sess-slack-route/prompt_async') {
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    process.env.KORTIX_WORKSPACE = originalWorkspace
    rmSync(workspace, { recursive: true, force: true })
  })

  it('accepts a signed Slack event and returns 202 instead of crashing', async () => {
    const cacheBust = `?t=${Date.now()}${Math.random()}`
    const { default: channelWebhooksRouter } = await import(`../../src/routes/channel-webhooks.ts${cacheBust}`)
    const channelId = crypto.randomUUID()
    const webhookPath = `/hooks/slack/${channelId}`
    mkdirSync(join(workspace, '.kortix'), { recursive: true })
    const db = new Database(join(workspace, '.kortix', 'kortix.db'))
    db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        bot_token TEXT NOT NULL DEFAULT '',
        signing_secret TEXT,
        webhook_secret TEXT NOT NULL,
        webhook_path TEXT NOT NULL UNIQUE,
        bot_id TEXT,
        bot_username TEXT,
        default_agent TEXT DEFAULT 'kortix',
        default_model TEXT DEFAULT '',
        bridge_instructions TEXT,
        instructions TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO channels (id, platform, name, enabled, bot_token, signing_secret, webhook_secret, webhook_path, bot_id, bot_username, default_agent, default_model, bridge_instructions, instructions, created_by, created_at, updated_at)
      VALUES (?, 'slack', 'Slack Route Test', 1, 'xoxb-test', 'signing-secret', 'webhook-secret', ?, 'U0LAN0Z89', 'kortix-bot', 'kortix', 'openai/gpt-4.1-mini', 'Always answer with a brief confirmation first.', 'You are the Slack support bot for this workspace.', NULL, ?, ?)
    `).run(channelId, webhookPath, now, now)

    const payload = fixture('slack-event-app-mention.json') as Record<string, unknown>
    const body = JSON.stringify(payload)
    const { signature, timestamp } = signSlackRequest(body, 'signing-secret')

    const res = await channelWebhooksRouter.request(`http://localhost${webhookPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-slack-signature': signature,
        'x-slack-request-timestamp': timestamp,
      },
      body,
    })

    expect(res.status).toBe(202)
    const json = await res.json() as { ok: boolean; sessionId: string }
    expect(json.ok).toBe(true)
    expect(json.sessionId).toBe('sess-slack-route')

    const createCall = fetchCalls.find((call) => call.url === 'http://localhost:4096/session')
    expect(createCall?.body?.agent).toBe('kortix')
    expect(createCall?.body?.systemPrompt).toBe('You are the Slack support bot for this workspace.')

    const promptCall = fetchCalls.find((call) => call.url === 'http://localhost:4096/session/sess-slack-route/prompt_async')
    expect(promptCall?.body?.model).toEqual({ providerID: 'openai', modelID: 'gpt-4.1-mini' })
    expect(promptCall?.body?.parts?.[0]?.text).toContain('Always answer with a brief confirmation first.')
  })
})
