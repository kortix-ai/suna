/**
 * Channel Webhook Handler — receives Telegram/Slack webhook events,
 * verifies them against the channel config in SQLite, parses them
 * into normalized events, and dispatches to OpenCode sessions.
 *
 * Mounted BEFORE the generic /hooks/* proxy to port 8099 so channel
 * webhooks are handled directly by kortix-master.
 */
import { Hono } from 'hono'
import { getChannelByPath, updateChannel, type ChannelConfig } from '../../channels/channel-db'
import {
  parseTelegramUpdate,
  parseSlackEvent,
  verifySlackSignature,
  parseWhatsAppWebhook,
  verifyWhatsAppSignature,
  type NormalizedChannelEvent,
} from '../../triggers/src/channel-webhooks'

const channelWebhooksRouter = new Hono()

const OPENCODE_URL = 'http://localhost:4096'

// ── Persistent session store — survives restarts via SQLite ─────────────────

import { getDb } from '../../channels/channel-db'

function ensureSessionTable(): void {
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_sessions (
      session_key TEXT PRIMARY KEY,
      current_session_id TEXT NOT NULL,
      history TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );
  `)
}

// Run on module load
try { ensureSessionTable() } catch {}

function getSessionState(sessionKey: string): { currentId: string | null; history: string[] } {
  try {
    const db = getDb()
    const row = db.prepare('SELECT current_session_id, history FROM channel_sessions WHERE session_key = ?').get(sessionKey) as { current_session_id: string; history: string } | null
    if (!row) return { currentId: null, history: [] }
    return { currentId: row.current_session_id, history: JSON.parse(row.history || '[]') }
  } catch {
    return { currentId: null, history: [] }
  }
}

function rememberSession(sessionKey: string, sessionId: string): void {
  try {
    const db = getDb()
    const existing = getSessionState(sessionKey)
    const history = [sessionId, ...existing.history.filter(id => id !== sessionId)].slice(0, 10)
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO channel_sessions (session_key, current_session_id, history, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET current_session_id = excluded.current_session_id, history = excluded.history, updated_at = excluded.updated_at
    `).run(sessionKey, sessionId, JSON.stringify(history), now)
  } catch {}
}

function clearSession(sessionKey: string): void {
  try {
    const db = getDb()
    db.prepare('UPDATE channel_sessions SET current_session_id = \'\', updated_at = ? WHERE session_key = ?')
      .run(new Date().toISOString(), sessionKey)
  } catch {}
}

async function sendTelegramText(channel: ChannelConfig, chatId: string, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${channel.bot_token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(15_000),
  })
}

async function sendSlackText(channel: ChannelConfig, targetChannel: string, text: string, threadTs?: string): Promise<void> {
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${channel.bot_token}`,
    },
    body: JSON.stringify({ channel: targetChannel, text, ...(threadTs ? { thread_ts: threadTs } : {}) }),
    signal: AbortSignal.timeout(15_000),
  })
}

interface OpenCodeSession {
  id: string
  title?: string
  time?: { created?: string }
}

async function fetchSessions(limit: number = 10): Promise<OpenCodeSession[]> {
  try {
    const res = await fetch(`${OPENCODE_URL}/session`, {
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return []
    const sessions = await res.json() as OpenCodeSession[]
    return sessions.slice(0, limit)
  } catch {
    return []
  }
}

async function fetchAvailableModels(): Promise<string[]> {
  try {
    const res = await fetch('http://localhost:8000/kortix/preferences/models', {
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return []
    const data = await res.json() as { models?: Array<{ id: string }> }
    return (data.models || []).map(m => m.id)
  } catch {
    return []
  }
}

type CommandOutcome = { handled: boolean; text?: string }

async function handleChannelCommand(
  channel: ChannelConfig,
  event: NormalizedChannelEvent,
): Promise<CommandOutcome> {
  const raw = (event.text || '').trim()
  if (!raw) return { handled: false }

  const isTelegram = channel.platform === 'telegram'
  const isCommand = isTelegram ? raw.startsWith('/') : raw.startsWith('!')
  if (!isCommand) return { handled: false }

  const commandText = isTelegram ? raw.slice(1) : raw.slice(1)
  const [rawName, ...rest] = commandText.split(/\s+/)
  const command = (rawName || '').replace(/@.+$/, '').toLowerCase()
  const arg = rest.join(' ').trim()

  const p = isTelegram ? '/' : '!'

  switch (command) {
    case 'new':
    case 'reset': {
      clearSession(event.session_key)
      return { handled: true, text: 'Session reset. Next message starts fresh.' }
    }

    case 'status':
    case 'info': {
      const state = getSessionState(event.session_key)
      return {
        handled: true,
        text: [
          `${channel.name} (${channel.platform})`,
          `Bot: @${channel.bot_username || '?'}`,
          `Agent: ${channel.default_agent || 'kortix'}`,
          `Model: ${channel.default_model || '(default)'}`,
          `Session: ${state.currentId || 'none'}`,
          `Enabled: ${channel.enabled ? 'yes' : 'no'}`,
          channel.instructions ? `Instructions: ${channel.instructions.slice(0, 100)}${channel.instructions.length > 100 ? '…' : ''}` : '',
        ].filter(Boolean).join('\n'),
      }
    }

    case 'agent': {
      if (!arg) {
        return { handled: true, text: `Current agent: ${channel.default_agent || 'kortix'}\nUsage: ${p}agent <name>` }
      }
      const updated = updateChannel(channel.id, { default_agent: arg })
      clearSession(event.session_key)
      return { handled: true, text: `Agent: ${updated?.default_agent || arg}\nSession reset.` }
    }

    case 'model': {
      if (!arg) {
        const models = await fetchAvailableModels()
        const lines = [`Current: ${channel.default_model || '(default)'}`]
        if (models.length > 0) {
          lines.push('', 'Available:')
          models.slice(0, 15).forEach(m => lines.push(`  ${m}`))
          if (models.length > 15) lines.push(`  … and ${models.length - 15} more`)
        }
        lines.push('', `Usage: ${p}model <provider/model>`)
        return { handled: true, text: lines.join('\n') }
      }
      const updated = updateChannel(channel.id, { default_model: arg })
      clearSession(event.session_key)
      return { handled: true, text: `Model: ${updated?.default_model || arg}\nSession reset.` }
    }

    case 'name': {
      if (!arg) {
        return { handled: true, text: `Current name: ${channel.name}\nUsage: ${p}name <new name>` }
      }
      const updated = updateChannel(channel.id, { name: arg })
      return { handled: true, text: `Channel renamed to: ${updated?.name || arg}` }
    }

    case 'instructions':
    case 'prompt': {
      if (!arg) {
        return {
          handled: true,
          text: channel.instructions
            ? `Current instructions:\n${channel.instructions}\n\nUsage: ${p}instructions <text> or ${p}instructions clear`
            : `No custom instructions set.\nUsage: ${p}instructions <text>`,
        }
      }
      if (arg === 'clear' || arg === 'reset' || arg === 'none') {
        updateChannel(channel.id, { instructions: '' as any })
        clearSession(event.session_key)
        return { handled: true, text: 'Instructions cleared. Session reset.' }
      }
      updateChannel(channel.id, { instructions: arg } as any)
      clearSession(event.session_key)
      return { handled: true, text: `Instructions updated. Session reset.` }
    }

    case 'enable': {
      updateChannel(channel.id, { enabled: true })
      return { handled: true, text: 'Channel enabled.' }
    }

    case 'disable': {
      updateChannel(channel.id, { enabled: false })
      return { handled: true, text: 'Channel disabled. Messages will be ignored until re-enabled.' }
    }

    case 'sessions': {
      const current = getSessionState(event.session_key)
      const sessions = await fetchSessions(15)
      if (sessions.length === 0) {
        return { handled: true, text: 'No sessions yet.' }
      }
      const lines = sessions.map((s) => {
        const marker = s.id === current.currentId ? ' ← current' : ''
        const title = (s.title || '(untitled)').slice(0, 50)
        return `${s.id.slice(0, 16)}… ${title}${marker}`
      })
      return { handled: true, text: `Sessions:\n${lines.join('\n')}` }
    }

    case 'session': {
      if (!arg) {
        const current = getSessionState(event.session_key)
        return { handled: true, text: `Current: ${current.currentId || 'none'}\nUsage: ${p}session <id or partial>` }
      }
      // Allow partial ID matching
      const sessions = await fetchSessions(100)
      const match = sessions.find(s => s.id === arg || s.id.startsWith(arg))
      if (!match) {
        return { handled: true, text: `No session found matching: ${arg}` }
      }
      rememberSession(event.session_key, match.id)
      return { handled: true, text: `Switched to: ${match.id}\n${match.title || '(untitled)'}` }
    }

    case 'help': {
      return {
        handled: true,
        text: [
          'Commands:',
          `${p}status — Current config & session`,
          `${p}model <provider/model> — Set model`,
          `${p}agent <name> — Set agent`,
          `${p}name <name> — Rename this channel`,
          `${p}instructions <text> — Set system prompt`,
          `${p}instructions clear — Clear system prompt`,
          `${p}new — Start fresh session`,
          `${p}reset — Same as ${p}new`,
          `${p}sessions — List recent sessions`,
          `${p}session <id> — Switch session`,
          `${p}enable / ${p}disable — Toggle channel`,
          `${p}help — This message`,
        ].join('\n'),
      }
    }

    default:
      return { handled: false }
  }
}

// ── Dispatch to OpenCode ────────────────────────────────────────────────────

async function dispatchToOpenCode(
  channel: ChannelConfig,
  event: NormalizedChannelEvent,
): Promise<{ sessionId: string }> {
  const existingSessionId = getSessionState(event.session_key).currentId || null

  // Parse "provider/model" into the format OpenCode expects
  const modelOverride = channel.default_model
    ? (() => {
        const parts = channel.default_model.split('/')
        return parts.length >= 2
          ? { providerID: parts[0], modelID: parts.slice(1).join('/') }
          : { providerID: 'kortix', modelID: channel.default_model }
      })()
    : undefined

  // Reuse existing session — always send to the same session for continuity
  if (existingSessionId) {
    try {
      const res = await fetch(`${OPENCODE_URL}/session/${existingSessionId}/prompt_async`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parts: [{ type: 'text', text: event.prompt }],
          agent: channel.default_agent || undefined,
          ...(modelOverride ? { model: modelOverride } : {}),
        }),
        signal: AbortSignal.timeout(30_000),
      })
      if (res.ok) {
        rememberSession(event.session_key, existingSessionId)
        return { sessionId: existingSessionId }
      }
      // Session might be gone — fall through to create new one
      clearSession(event.session_key)
    } catch {
      clearSession(event.session_key)
    }
  }

  // Create new session
  const createRes = await fetch(`${OPENCODE_URL}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent: channel.default_agent || 'kortix',
      ...(channel.instructions ? { systemPrompt: channel.instructions } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!createRes.ok) {
    throw new Error(`Failed to create OpenCode session: ${createRes.status}`)
  }
  const session = await createRes.json() as { id: string }

  // Send the prompt
  const promptRes = await fetch(`${OPENCODE_URL}/session/${session.id}/prompt_async`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parts: [{ type: 'text', text: event.prompt }],
      agent: channel.default_agent || 'kortix',
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!promptRes.ok) {
    throw new Error(`Failed to send prompt: ${promptRes.status}`)
  }

  // Cache session for reuse (persisted in SQLite)
  rememberSession(event.session_key, session.id)
  rememberSession(event.session_key, session.id)

  return { sessionId: session.id }
}

// ── Telegram webhook handler ────────────────────────────────────────────────

channelWebhooksRouter.post('/hooks/telegram/:channelId', async (c) => {
  const channelId = c.req.param('channelId')
  const webhookPath = `/hooks/telegram/${channelId}`

  // Look up channel
  let channel = getChannelByPath(webhookPath)
  if (!channel) {
    return c.json({ ok: false, error: 'not_found' }, 404)
  }

  // Verify Telegram secret token
  const secretHeader = c.req.header('x-telegram-bot-api-secret-token') || ''
  if (secretHeader !== channel.webhook_secret) {
    console.warn(`[Channel Webhook] Telegram secret mismatch for ${channel.name} (${channelId})`)
    return c.json({ ok: false, error: 'unauthorized' }, 401)
  }

  // Parse the update
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400)
  }

  const event = parseTelegramUpdate(body, channelId)
  if (!event) {
    return c.json({ ok: true, skipped: true })
  }

  // Handle commands BEFORE the enabled check — so /enable works on disabled channels
  const command = await handleChannelCommand(channel, event)
  if (command.handled) {
    if (command.text) await sendTelegramText(channel, event.chat_id, command.text)
    // Re-read channel in case the command changed it (e.g. /enable, /disable)
    channel = getChannelByPath(webhookPath)!
    return c.json({ ok: true, command: true })
  }

  // Non-command messages require the channel to be enabled
  if (!channel.enabled) {
    return c.json({ ok: false, error: 'channel_disabled' }, 403)
  }

  // Dispatch to OpenCode
  try {
    const result = await dispatchToOpenCode(channel, event)
    console.log(`[Channel Webhook] Telegram ${event.event_type} from @${event.username} → session ${result.sessionId}`)
    return c.json({ ok: true, sessionId: result.sessionId }, 202)
  } catch (err) {
    console.error(`[Channel Webhook] Telegram dispatch error:`, err)
    return c.json({ ok: false, error: 'dispatch_failed' }, 500)
  }
})

// ── Slack webhook handler ───────────────────────────────────────────────────

channelWebhooksRouter.post('/hooks/slack/:channelId', async (c) => {
  const channelId = c.req.param('channelId')
  const webhookPath = `/hooks/slack/${channelId}`

  // Look up channel
  let channel = getChannelByPath(webhookPath)
  if (!channel) {
    return c.json({ ok: false, error: 'not_found' }, 404)
  }

  // Read raw body and parse
  const rawBody = await c.req.text()
  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400)
  }

  // Handle Slack URL verification challenge — even for disabled/unconfigured channels
  const preParseResult = parseSlackEvent(body, channelId, channel.bot_id || '')
  if (preParseResult.is_challenge && preParseResult.challenge) {
    return c.json({ challenge: preParseResult.challenge })
  }

  if (!preParseResult.dispatch_event) {
    return c.json({ ok: true, skipped: true })
  }

  // Handle commands BEFORE enabled check — so !enable works on disabled channels
  const command = await handleChannelCommand(channel, preParseResult.dispatch_event)
  if (command.handled) {
    if (command.text) {
      await sendSlackText(channel, preParseResult.dispatch_event.chat_id, command.text, preParseResult.dispatch_event.thread_ts || preParseResult.dispatch_event.message_id)
    }
    channel = getChannelByPath(webhookPath)!
    return c.json({ ok: true, command: true })
  }

  // Non-command messages require the channel to be enabled
  if (!channel.enabled) {
    return c.json({ ok: false, error: 'channel_disabled' }, 403)
  }

  // Verify Slack signature if signing secret is configured
  if (channel.signing_secret) {
    const timestamp = c.req.header('x-slack-request-timestamp') || ''
    const signature = c.req.header('x-slack-signature') || ''
    if (!verifySlackSignature(rawBody, timestamp, signature, channel.signing_secret)) {
      console.warn(`[Channel Webhook] Slack signature mismatch for ${channel.name} (${channelId})`)
      return c.json({ ok: false, error: 'unauthorized' }, 401)
    }
  }

  // Dispatch to OpenCode
  try {
    const dispatch = await dispatchToOpenCode(channel, result.dispatch_event)
    console.log(`[Channel Webhook] Slack ${result.dispatch_event.event_type} from ${result.dispatch_event.username} → session ${dispatch.sessionId}`)
    return c.json({ ok: true, sessionId: dispatch.sessionId }, 202)
  } catch (err) {
    console.error(`[Channel Webhook] Slack dispatch error:`, err)
    return c.json({ ok: false, error: 'dispatch_failed' }, 500)
  }
})

// ── WhatsApp webhook handlers ──────────────────────────────────────────────

function parseWhatsAppToken(botToken: string): { accessToken: string; phoneNumberId: string } {
  const parts = botToken.split('|')
  return { accessToken: parts[0] || '', phoneNumberId: parts[1] || '' }
}

async function sendWhatsAppText(channel: ChannelConfig, phone: string, text: string): Promise<void> {
  const { accessToken, phoneNumberId } = parseWhatsAppToken(channel.bot_token)
  if (!accessToken || !phoneNumberId) return

  await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: phone,
      type: 'text',
      text: { body: text },
    }),
    signal: AbortSignal.timeout(15_000),
  })
}

// WhatsApp webhook verification (GET) — Meta sends this when you register the webhook URL
channelWebhooksRouter.get('/hooks/whatsapp/:channelId', async (c) => {
  const channelId = c.req.param('channelId')
  const webhookPath = `/hooks/whatsapp/${channelId}`

  const channel = getChannelByPath(webhookPath)
  if (!channel) {
    return c.text('Not found', 404)
  }

  // Meta sends: hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<challenge>
  const mode = c.req.query('hub.mode')
  const token = c.req.query('hub.verify_token')
  const challenge = c.req.query('hub.challenge')

  if (mode === 'subscribe' && token === channel.webhook_secret) {
    console.log(`[Channel Webhook] WhatsApp webhook verified for ${channel.name} (${channelId})`)
    return c.text(challenge || '', 200)
  }

  console.warn(`[Channel Webhook] WhatsApp verification failed for ${channel.name} (${channelId})`)
  return c.text('Forbidden', 403)
})

// WhatsApp webhook events (POST)
channelWebhooksRouter.post('/hooks/whatsapp/:channelId', async (c) => {
  const channelId = c.req.param('channelId')
  const webhookPath = `/hooks/whatsapp/${channelId}`

  let channel = getChannelByPath(webhookPath)
  if (!channel) {
    return c.json({ ok: false, error: 'not_found' }, 404)
  }

  const rawBody = await c.req.text()
  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400)
  }

  // Verify signature if signing_secret (app secret) is configured
  if (channel.signing_secret) {
    const signature = c.req.header('x-hub-signature-256') || ''
    if (!verifyWhatsAppSignature(rawBody, signature, channel.signing_secret)) {
      console.warn(`[Channel Webhook] WhatsApp signature mismatch for ${channel.name} (${channelId})`)
      return c.json({ ok: false, error: 'unauthorized' }, 401)
    }
  }

  const { accessToken, phoneNumberId } = parseWhatsAppToken(channel.bot_token)

  const result = parseWhatsAppWebhook(body, channelId, phoneNumberId)
  if (!result.dispatch_event) {
    return c.json({ ok: true, skipped: true })
  }

  // Handle commands BEFORE the enabled check
  const command = await handleChannelCommand(channel, result.dispatch_event)
  if (command.handled) {
    if (command.text) await sendWhatsAppText(channel, result.dispatch_event.chat_id, command.text)
    channel = getChannelByPath(webhookPath)!
    return c.json({ ok: true, command: true })
  }

  if (!channel.enabled) {
    return c.json({ ok: false, error: 'channel_disabled' }, 403)
  }

  // Dispatch to OpenCode
  try {
    const dispatch = await dispatchToOpenCode(channel, result.dispatch_event)
    console.log(`[Channel Webhook] WhatsApp ${result.dispatch_event.event_type} from ${result.dispatch_event.username} → session ${dispatch.sessionId}`)
    return c.json({ ok: true, sessionId: dispatch.sessionId }, 202)
  } catch (err) {
    console.error(`[Channel Webhook] WhatsApp dispatch error:`, err)
    return c.json({ ok: false, error: 'dispatch_failed' }, 500)
  }
})

export default channelWebhooksRouter
