/**
 * Channel management routes — thin wrapper over SQLite channel DB.
 *
 * GET    /kortix/channels              — list all channels
 * POST   /kortix/channels/verify-telegram  — verify a Telegram bot token
 * POST   /kortix/channels/setup/telegram   — full Telegram bot setup
 * POST   /kortix/channels/setup/slack      — full Slack bot setup
 * POST   /kortix/channels/slack-manifest   — generate Slack app manifest
 * GET    /kortix/channels/:id          — get channel details
 * POST   /kortix/channels/:id/enable   — enable channel
 * POST   /kortix/channels/:id/disable  — disable channel
 * DELETE /kortix/channels/:id          — remove channel
 * PATCH  /kortix/channels/:id          — update settings
 */

import { Hono } from 'hono'
import { getMasterPublicBaseUrl } from './share'

const channelsRouter = new Hono()

function joinPublicBaseUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl)
  const suffix = path.startsWith('/') ? path : `/${path}`
  const basePath = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname
  const joined = new URL(`${basePath}${suffix}`, base.origin)
  // Preserve query params (e.g. __proxy_token) from the base URL
  for (const [k, v] of base.searchParams) {
    joined.searchParams.set(k, v)
  }
  return joined.toString()
}

/**
 * Get a usable public base URL for channel webhooks.
 * In cloud/production, PUBLIC_BASE_URL (or CLOUD_PROXY_BASE_URL) provides a
 * real public URL. Locally this will be localhost — webhooks won't work
 * externally unless PUBLIC_BASE_URL is set to a tunnel/ngrok URL.
 */
function getChannelPublicBaseUrl(): string {
  return getMasterPublicBaseUrl()
}

// Dynamic import to avoid loading bun:sqlite at module scope in test environments
async function loadDb() {
  const mod = await import('../../channels/channel-db')
  return mod
}

channelsRouter.get('/', async (c) => {
  try {
    const { listChannels } = await loadDb()
    const platform = c.req.query('platform')
    const channels = listChannels(platform || undefined)
    const publicBase = getChannelPublicBaseUrl()
    return c.json({
      ok: true,
      channels: channels.map(ch => ({
        id: ch.id,
        platform: ch.platform,
        name: ch.name,
        enabled: ch.enabled,
        bot_username: ch.bot_username,
        default_agent: ch.default_agent,
        default_model: ch.default_model,
        instructions: ch.instructions || '',
        webhook_path: ch.webhook_path,
        webhook_url: publicBase ? joinPublicBaseUrl(publicBase, ch.webhook_path) : null,
        created_by: ch.created_by,
        created_at: ch.created_at,
        updated_at: ch.updated_at,
      })),
    })
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500)
  }
})

// ─── Setup / Wizard endpoints ────────────────────────────────────────────────

channelsRouter.post('/verify-telegram', async (c) => {
  const { botToken } = await c.req.json()
  if (!botToken) return c.json({ ok: false, error: 'botToken required' }, 400)

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    })
    const data = await res.json() as any
    if (data.ok && data.result) {
      return c.json({ ok: true, bot: { id: data.result.id, username: data.result.username, firstName: data.result.first_name } })
    }
    return c.json({ ok: false, error: data.description || 'Invalid token' })
  } catch {
    return c.json({ ok: false, error: 'Failed to reach Telegram API' }, 500)
  }
})

channelsRouter.post('/setup/telegram', async (c) => {
  try {
    const { botToken, publicUrl, createdBy, defaultAgent, defaultModel } = await c.req.json()
    if (!botToken) return c.json({ ok: false, error: 'botToken required' }, 400)

    // 1. Verify token via Telegram getMe
    const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    })
    const meData = await meRes.json() as any
    if (!meData.ok || !meData.result) {
      return c.json({ ok: false, error: meData.description || 'Invalid bot token' })
    }
    const bot = meData.result

    // 2. Create or update channel in SQLite (one Telegram bot => one channel row)
    const { upsertChannelByBot } = await loadDb()
    const { channel, created, deduped } = upsertChannelByBot({
      platform: 'telegram',
      bot_token: botToken,
      bot_id: String(bot.id),
      bot_username: bot.username,
      created_by: createdBy,
      default_agent: defaultAgent || undefined,
      default_model: defaultModel || undefined,
    })

    // 3. Register default Telegram bot commands so the slash menu works immediately
    const commands = [
      { command: 'status', description: 'Current config & session' },
      { command: 'model', description: 'Set model (provider/model)' },
      { command: 'agent', description: 'Set agent' },
      { command: 'name', description: 'Rename this channel' },
      { command: 'instructions', description: 'Set system prompt' },
      { command: 'new', description: 'Start fresh session' },
      { command: 'sessions', description: 'List recent sessions' },
      { command: 'session', description: 'Switch session' },
      { command: 'help', description: 'All commands' },
    ]
    const cmdRes = await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
      signal: AbortSignal.timeout(10_000),
    })
    const cmdData = await cmdRes.json() as any

    // 4. Set Telegram webhook — auto-resolve public URL if not provided
    const resolvedPublicUrl = publicUrl || getChannelPublicBaseUrl() || ''
    let webhookUrl: string | null = null
    if (resolvedPublicUrl) {
      webhookUrl = joinPublicBaseUrl(resolvedPublicUrl, channel.webhook_path)
      const whRes = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: webhookUrl, secret_token: channel.webhook_secret }),
        signal: AbortSignal.timeout(10_000),
      })
      const whData = await whRes.json() as any
      if (!whData.ok) {
        // Channel was created but webhook failed — return partial success
        return c.json({
          ok: true,
          channel: {
            id: channel.id,
            name: channel.name,
            bot: `@${bot.username}`,
            webhookPath: channel.webhook_path,
            webhookUrl: null,
            commandsConfigured: Boolean(cmdData?.ok),
          },
          message: `Telegram bot @${bot.username} set up as "${channel.name}" but webhook failed: ${whData.description || 'unknown error'}`,
        })
      }
    }

    return c.json({
      ok: true,
      channel: {
        id: channel.id,
        name: channel.name,
        bot: `@${bot.username}`,
        webhookPath: channel.webhook_path,
        webhookUrl: webhookUrl || null,
        commandsConfigured: Boolean(cmdData?.ok),
      },
      message: `Telegram bot @${bot.username} ${created ? 'set up' : 'updated'} as "${channel.name}"${webhookUrl ? '' : ' — provide publicUrl to register webhook'}`,
      deduped,
    })
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500)
  }
})

// ── WhatsApp setup ──────────────────────────────────────────────────────────

channelsRouter.post('/verify-whatsapp', async (c) => {
  const { accessToken, phoneNumberId } = await c.req.json()
  if (!accessToken || !phoneNumberId) return c.json({ ok: false, error: 'accessToken and phoneNumberId required' }, 400)

  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`,
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) },
    )
    const data = await res.json() as any
    if (data.error) {
      return c.json({ ok: false, error: data.error.message || 'Invalid credentials' })
    }
    return c.json({
      ok: true,
      phone: {
        id: phoneNumberId,
        display_phone_number: data.display_phone_number,
        verified_name: data.verified_name,
        quality_rating: data.quality_rating,
      },
    })
  } catch {
    return c.json({ ok: false, error: 'Failed to reach WhatsApp Cloud API' }, 500)
  }
})

channelsRouter.post('/setup/whatsapp', async (c) => {
  try {
    const { accessToken, phoneNumberId, publicUrl, createdBy, defaultAgent, defaultModel, webhookVerifyToken } = await c.req.json()
    if (!accessToken || !phoneNumberId) return c.json({ ok: false, error: 'accessToken and phoneNumberId required' }, 400)

    // 1. Verify credentials
    const meRes = await fetch(
      `https://graph.facebook.com/v21.0/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`,
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) },
    )
    const meData = await meRes.json() as any
    if (meData.error) {
      return c.json({ ok: false, error: meData.error.message || 'Invalid credentials' })
    }

    // 2. Store as "ACCESS_TOKEN|PHONE_NUMBER_ID" in bot_token field
    const combinedToken = `${accessToken}|${phoneNumberId}`

    const { upsertChannelByBot } = await loadDb()
    const { channel, created, deduped } = upsertChannelByBot({
      platform: 'whatsapp',
      bot_token: combinedToken,
      bot_id: phoneNumberId,
      bot_username: meData.verified_name || meData.display_phone_number,
      created_by: createdBy,
      default_agent: defaultAgent || undefined,
      default_model: defaultModel || undefined,
    })

    // If user provides a custom webhook verify token, store in signing_secret field
    if (webhookVerifyToken) {
      const { updateChannel } = await loadDb()
      updateChannel(channel.id, { signing_secret: webhookVerifyToken } as any)
    }

    const resolvedPublicUrl = publicUrl || getChannelPublicBaseUrl() || ''
    const webhookUrl = resolvedPublicUrl ? joinPublicBaseUrl(resolvedPublicUrl, channel.webhook_path) : null

    return c.json({
      ok: true,
      channel: {
        id: channel.id,
        name: channel.name,
        phone: meData.display_phone_number,
        verifiedName: meData.verified_name,
        webhookPath: channel.webhook_path,
        webhookUrl,
        webhookVerifyToken: channel.webhook_secret,
      },
      message: `WhatsApp ${meData.verified_name || meData.display_phone_number} ${created ? 'set up' : 'updated'} as "${channel.name}"`,
      next_step: webhookUrl
        ? `Set your Meta App webhook URL to: ${webhookUrl} — use verify token: ${channel.webhook_secret}`
        : 'Set PUBLIC_BASE_URL or provide publicUrl to get your webhook URL',
      deduped,
    })
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500)
  }
})

// ── Random bot name generation ────────────────────────────────────────────────
const FIRST_NAMES = [
  'Atlas', 'Nova', 'Sage', 'Echo', 'Bolt', 'Iris', 'Dash', 'Cleo',
  'Finn', 'Luna', 'Juno', 'Axel', 'Niko', 'Zara', 'Milo', 'Ruby',
  'Hugo', 'Aria', 'Leo', 'Ivy', 'Rex', 'Mae', 'Kai', 'Pia',
  'Max', 'Vera', 'Otto', 'Lyra', 'Remy', 'Tess',
]

function generateBotName(): string {
  const name = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)]
  return `Kortix ${name}`
}

function buildSlackManifest(displayName: string, webhookUrl: string) {
  return {
    display_information: {
      name: displayName,
      description: 'Kortix AI instance',
      background_color: '#1a1a2e',
    },
    features: {
      bot_user: { display_name: displayName, always_online: true },
    },
    oauth_config: {
      scopes: {
        bot: [
          'app_mentions:read', 'channels:history', 'channels:read', 'channels:join',
          'chat:write', 'chat:write.public', 'files:read', 'files:write',
          'groups:history', 'groups:read', 'im:history', 'im:read', 'im:write',
          'mpim:history', 'mpim:read', 'reactions:read', 'reactions:write', 'users:read',
        ],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: webhookUrl,
        bot_events: [
          'app_mention', 'message.im', 'message.channels', 'message.groups', 'message.mpim',
          'reaction_added', 'reaction_removed', 'member_joined_channel', 'file_shared',
        ],
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  }
}

// ── Slack setup ──────────────────────────────────────────────────────────────
//
// The Slack flow is:
//   1. POST /slack-manifest { botName } → creates channel row, returns manifest with correct webhook URL + channelId
//   2. User creates Slack app from manifest, installs to workspace
//   3. POST /setup/slack { botToken, signingSecret, channelId } → updates the SAME channel row with real credentials
//
// One channel. One ID. One webhook URL. No duplicates.

channelsRouter.post('/slack-manifest', async (c) => {
  try {
    const { publicUrl, botName } = await c.req.json()
    const resolvedUrl = publicUrl || getChannelPublicBaseUrl() || ''
    if (!resolvedUrl) return c.json({ ok: false, error: 'Could not resolve public URL. Set PUBLIC_BASE_URL or provide publicUrl.' }, 400)

    const displayName = botName || generateBotName()

    // Create the channel row NOW so the manifest gets a real webhook URL.
    const { createChannel } = await loadDb()
    const channel = createChannel({
      platform: 'slack',
      name: displayName,
      bot_token: '',
      enabled: false, // disabled until /setup/slack provides real credentials
    })

    const webhookUrl = joinPublicBaseUrl(resolvedUrl, channel.webhook_path)
    const manifest = buildSlackManifest(displayName, webhookUrl)

    return c.json({ ok: true, manifest, webhookUrl, channelId: channel.id })
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500)
  }
})

channelsRouter.post('/setup/slack', async (c) => {
  try {
    const { botToken, signingSecret, publicUrl, name, createdBy, channelId, defaultAgent, defaultModel } = await c.req.json()
    if (!botToken) return c.json({ ok: false, error: 'botToken required' }, 400)

    // 1. Verify token
    const authRes = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${botToken}` },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10_000),
    })
    const authData = await authRes.json() as any
    if (!authData.ok) {
      return c.json({ ok: false, error: authData.error || 'Invalid bot token' })
    }

    // 2. Update the channel created by /slack-manifest, or create new if channelId missing
    const { getChannel, updateChannel, createChannel } = await loadDb()
    let channel
    if (channelId) {
      const existing = getChannel(channelId)
      if (existing && existing.platform === 'slack') {
        channel = updateChannel(channelId, {
          bot_token: botToken,
          signing_secret: signingSecret || undefined,
          bot_id: authData.user_id,
          bot_username: authData.user,
          name: name || existing.name,
          default_agent: defaultAgent || existing.default_agent,
          default_model: defaultModel || existing.default_model,
          enabled: true,
        })!
      }
    }
    if (!channel) {
      channel = createChannel({
        platform: 'slack',
        name: name || generateBotName(),
        bot_token: botToken,
        signing_secret: signingSecret,
        bot_id: authData.user_id,
        bot_username: authData.user,
        created_by: createdBy,
      })
    }

    const resolvedSlackUrl = publicUrl || getChannelPublicBaseUrl() || ''
    const webhookUrl = resolvedSlackUrl ? joinPublicBaseUrl(resolvedSlackUrl, channel.webhook_path) : null

    return c.json({
      ok: true,
      channel: {
        id: channel.id,
        name: channel.name,
        bot: `@${authData.user}`,
        team: authData.team,
        webhookPath: channel.webhook_path,
        webhookUrl,
      },
      message: `Slack bot @${authData.user} (${authData.team}) set up as "${channel.name}"`,
    })
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500)
  }
})

// ─── Per-channel CRUD ────────────────────────────────────────────────────────

channelsRouter.get('/:id', async (c) => {
  try {
    const { getChannel } = await loadDb()
    const ch = getChannel(c.req.param('id'))
    if (!ch) return c.json({ ok: false, error: 'Not found' }, 404)
    const publicBase = getChannelPublicBaseUrl()
    return c.json({
      ok: true,
      channel: {
        id: ch.id,
        platform: ch.platform,
        name: ch.name,
        enabled: ch.enabled,
        bot_username: ch.bot_username,
        default_agent: ch.default_agent,
        default_model: ch.default_model,
        instructions: ch.instructions,
        webhook_path: ch.webhook_path,
        webhook_url: publicBase ? joinPublicBaseUrl(publicBase, ch.webhook_path) : null,
        created_by: ch.created_by,
        created_at: ch.created_at,
        updated_at: ch.updated_at,
      },
    })
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500)
  }
})

channelsRouter.post('/:id/enable', async (c) => {
  try {
    const { enableChannel } = await loadDb()
    const ch = enableChannel(c.req.param('id'))
    if (!ch) return c.json({ ok: false, error: 'Not found' }, 404)
    return c.json({ ok: true, message: `${ch.name} enabled` })
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500)
  }
})

channelsRouter.post('/:id/disable', async (c) => {
  try {
    const { disableChannel } = await loadDb()
    const ch = disableChannel(c.req.param('id'))
    if (!ch) return c.json({ ok: false, error: 'Not found' }, 404)
    return c.json({ ok: true, message: `${ch.name} disabled` })
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500)
  }
})

channelsRouter.delete('/:id', async (c) => {
  try {
    const { deleteChannel, getChannel } = await loadDb()
    const ch = getChannel(c.req.param('id'))
    if (!ch) return c.json({ ok: false, error: 'Not found' }, 404)

    const cleanup: Record<string, unknown> = {
      provider: null,
      rowRemoved: false,
    }

    // Best-effort provider-side cleanup before deleting local secrets/tokens.
    // Skip provider cleanup if there's no real token (e.g. Slack placeholder from manifest step).
    if (ch.platform === 'telegram' && ch.bot_token) {
      const providerResults: Record<string, unknown> = {}

      // Remove webhook so Telegram stops delivering events to this bot/channel bridge.
      try {
        const whRes = await fetch(`https://api.telegram.org/bot${ch.bot_token}/deleteWebhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ drop_pending_updates: true }),
          signal: AbortSignal.timeout(10_000),
        })
        const whData = await whRes.json() as any
        providerResults.webhookDeleted = Boolean(whData?.ok)
        if (!whData?.ok) providerResults.webhookError = whData?.description || 'deleteWebhook failed'
      } catch (e) {
        providerResults.webhookDeleted = false
        providerResults.webhookError = String(e)
      }

      // Clear slash commands so the bot is de-provisioned cleanly.
      try {
        const cmdRes = await fetch(`https://api.telegram.org/bot${ch.bot_token}/setMyCommands`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ commands: [] }),
          signal: AbortSignal.timeout(10_000),
        })
        const cmdData = await cmdRes.json() as any
        providerResults.commandsCleared = Boolean(cmdData?.ok)
        if (!cmdData?.ok) providerResults.commandsError = cmdData?.description || 'setMyCommands failed'
      } catch (e) {
        providerResults.commandsCleared = false
        providerResults.commandsError = String(e)
      }

      cleanup.provider = providerResults
    } else if (ch.platform === 'slack' && ch.bot_token) {
      // Slack does not provide a simple one-call equivalent for removing Event Subscriptions
      // from a bot token at runtime. We can still remove all local secrets/tokens and connector state.
      cleanup.provider = {
        note: 'Slack local config removed. Event Subscriptions URL in Slack app should be removed manually if desired.',
      }
    } else if (ch.platform === 'whatsapp') {
      cleanup.provider = {
        note: 'WhatsApp local config removed. Webhook URL in Meta App Dashboard should be removed manually if desired.',
      }
    }

    cleanup.rowRemoved = deleteChannel(c.req.param('id'))

    return c.json({
      ok: true,
      message: `${ch.name} removed`,
      cleanup,
    })
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500)
  }
})

channelsRouter.patch('/:id', async (c) => {
  try {
    const { updateChannel } = await loadDb()
    const body = await c.req.json()
    const updates: Record<string, any> = {}
    if (body.default_agent !== undefined) updates.default_agent = body.default_agent
    if (body.default_model !== undefined) updates.default_model = body.default_model
    if (body.instructions !== undefined) updates.instructions = body.instructions
    if (body.name !== undefined) updates.name = body.name
    if (body.enabled !== undefined) updates.enabled = body.enabled

    const ch = updateChannel(c.req.param('id'), updates)
    if (!ch) return c.json({ ok: false, error: 'Not found' }, 404)
    return c.json({ ok: true, message: `${ch.name} updated` })
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500)
  }
})

export { channelsRouter }
