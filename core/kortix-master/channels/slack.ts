#!/usr/bin/env bun
/**
 * Slack Web API CLI — full wrapper around the Slack API.
 *
 * Usage:
 *   bun run slack.ts send --channel <id> --text "message" [--thread <ts>] [--file /path/to/file]
 *   bun run slack.ts edit --channel <id> --ts <ts> --text "updated"
 *   bun run slack.ts delete --channel <id> --ts <ts>
 *   bun run slack.ts react --channel <id> --ts <ts> --emoji "thumbsup"
 *   bun run slack.ts typing --channel <id>
 *   bun run slack.ts history --channel <id> [--limit 20]
 *   bun run slack.ts thread --channel <id> --ts <ts> [--limit 20]
 *   bun run slack.ts channels [--limit 100]
 *   bun run slack.ts channel-info --channel <id>
 *   bun run slack.ts join --channel <id>
 *   bun run slack.ts users [--limit 100]
 *   bun run slack.ts user --id <id>
 *   bun run slack.ts me
 *   bun run slack.ts search --query "..."
 *   bun run slack.ts file-info --file <id>
 *   bun run slack.ts download --url <url> --out <path>
 *
 * Auth: SLACK_BOT_TOKEN env var.
 * Output: JSON always. Exit 0 on success, 1 on failure.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs"

// ─── Env resolution ──────────────────────────────────────────────────────────

const S6_ENV_DIR = process.env.S6_ENV_DIR || "/run/s6/container_environment"

function getEnv(key: string): string | undefined {
  try {
    const val = readFileSync(`${S6_ENV_DIR}/${key}`, "utf-8").trim()
    if (val) return val
  } catch {}
  return process.env[key]
}

function getPublicUrl(flagsUrl?: string): string {
  return flagsUrl || getEnv("PUBLIC_BASE_URL") || getEnv("PUBLIC_URL") || ""
}

function getToken(): string | undefined {
  return getEnv("SLACK_BOT_TOKEN")
}

function slackApiBase(): string {
  return (getEnv("SLACK_API_URL") || "https://slack.com/api").replace(/\/$/, "")
}

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

// ─── API helpers ─────────────────────────────────────────────────────────────

async function apiPost(method: string, body: Record<string, unknown>): Promise<any> {
  const token = getToken()
  if (!token) return { ok: false, error: "SLACK_BOT_TOKEN not set" }

  const res = await fetch(`${slackApiBase()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  return await res.json()
}

async function apiGet(method: string, params: Record<string, string>): Promise<any> {
  const token = getToken()
  if (!token) return { ok: false, error: "SLACK_BOT_TOKEN not set" }

  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${slackApiBase()}/${method}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  })
  return await res.json()
}

// ─── Exported handler functions ──────────────────────────────────────────────

export async function slackSend(opts: { channel: string; text?: string; threadTs?: string; file?: string }): Promise<any> {
  const token = getToken()
  if (!token) return { ok: false, error: "SLACK_BOT_TOKEN not set" }

  // File upload — Slack's 3-step upload flow
  if (opts.file) {
    if (!existsSync(opts.file)) return { ok: false, error: `File not found: ${opts.file}` }
    const fileData = readFileSync(opts.file)
    const fileName = opts.file.split("/").pop() || "file"

    // Step 1: Get upload URL (requires form-urlencoded, not JSON)
    const getUrlRes = await fetch(`${slackApiBase()}/files.getUploadURLExternal`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ filename: fileName, length: String(fileData.length) }),
      signal: AbortSignal.timeout(15_000),
    }).then(r => r.json()) as any
    if (!getUrlRes.ok) return { ok: false, error: getUrlRes.error ?? "getUploadURL failed" }

    // Step 2: Upload the file bytes to the presigned URL
    const uploadRes = await fetch(getUrlRes.upload_url, {
      method: "POST",
      body: fileData,
      signal: AbortSignal.timeout(60_000),
    })
    if (!uploadRes.ok) return { ok: false, error: `Upload failed: ${uploadRes.status}` }

    // Step 3: Complete the upload and share to channel
    const completeBody: Record<string, unknown> = {
      files: [{ id: getUrlRes.file_id, title: fileName }],
      channel_id: opts.channel,
    }
    if (opts.text) completeBody.initial_comment = opts.text
    if (opts.threadTs) completeBody.thread_ts = opts.threadTs

    const completeRes = await apiPost("files.completeUploadExternal", completeBody)
    if (!completeRes.ok) return { ok: false, error: completeRes.error ?? "completeUpload failed" }
    return { ok: true, files: completeRes.files, channel: opts.channel }
  }

  // Text-only message
  if (!opts.text) return { ok: false, error: "Either --text or --file required" }
  const body: Record<string, unknown> = { channel: opts.channel, text: opts.text, mrkdwn: true }
  if (opts.threadTs) body.thread_ts = opts.threadTs

  const data = await apiPost("chat.postMessage", body)
  if (!data.ok) return { ok: false, error: data.error ?? "send failed" }
  return { ok: true, ts: data.ts, channel: data.channel }
}

export async function slackEdit(opts: { channel: string; ts: string; text: string }): Promise<any> {
  const data = await apiPost("chat.update", { channel: opts.channel, ts: opts.ts, text: opts.text })
  if (!data.ok) return { ok: false, error: data.error ?? "edit failed" }
  return { ok: true, ts: data.ts, channel: data.channel }
}

export async function slackDelete(opts: { channel: string; ts: string }): Promise<any> {
  const data = await apiPost("chat.delete", { channel: opts.channel, ts: opts.ts })
  if (!data.ok) return { ok: false, error: data.error ?? "delete failed" }
  return { ok: true }
}

export async function slackReact(opts: { channel: string; ts: string; emoji: string }): Promise<any> {
  const data = await apiPost("reactions.add", { channel: opts.channel, timestamp: opts.ts, name: opts.emoji })
  if (!data.ok) return { ok: false, error: data.error ?? "react failed" }
  return { ok: true }
}

export async function slackTyping(opts: { channel: string }): Promise<any> {
  // Slack doesn't have a direct "typing" API for bots in the Web API.
  // The typing indicator only works via RTM/Socket Mode, which we don't use.
  // Return success silently — the agent can call it without error.
  return { ok: true, note: "Slack Web API does not support typing indicators for bots" }
}

export async function slackHistory(opts: { channel: string; limit?: number }): Promise<any> {
  const data = await apiGet("conversations.history", {
    channel: opts.channel, limit: String(opts.limit ?? 20),
  })
  if (!data.ok) return { ok: false, error: data.error ?? "history failed" }
  return { ok: true, messages: data.messages }
}

export async function slackThread(opts: { channel: string; ts: string; limit?: number }): Promise<any> {
  const data = await apiGet("conversations.replies", {
    channel: opts.channel, ts: opts.ts, limit: String(opts.limit ?? 20),
  })
  if (!data.ok) return { ok: false, error: data.error ?? "thread failed" }
  return { ok: true, messages: data.messages }
}

export async function slackChannels(opts: { limit?: number }): Promise<any> {
  const data = await apiGet("conversations.list", {
    limit: String(opts.limit ?? 100),
    types: "public_channel,private_channel",
    exclude_archived: "true",
  })
  if (!data.ok) return { ok: false, error: data.error ?? "channels failed" }
  return { ok: true, channels: data.channels }
}

export async function slackChannelInfo(opts: { channel: string }): Promise<any> {
  const data = await apiGet("conversations.info", { channel: opts.channel })
  if (!data.ok) return { ok: false, error: data.error ?? "channel info failed" }
  return { ok: true, channel: data.channel }
}

export async function slackJoin(opts: { channel: string }): Promise<any> {
  const data = await apiPost("conversations.join", { channel: opts.channel })
  if (!data.ok) return { ok: false, error: data.error ?? "join failed" }
  return { ok: true, channel: data.channel }
}

export async function slackUsers(opts: { limit?: number }): Promise<any> {
  const data = await apiGet("users.list", { limit: String(opts.limit ?? 100) })
  if (!data.ok) return { ok: false, error: data.error ?? "users failed" }
  return { ok: true, members: data.members }
}

export async function slackUser(opts: { id: string }): Promise<any> {
  const data = await apiGet("users.info", { user: opts.id })
  if (!data.ok) return { ok: false, error: data.error ?? "user failed" }
  return { ok: true, user: data.user }
}

export async function slackMe(): Promise<any> {
  const data = await apiPost("auth.test", {})
  if (!data.ok) return { ok: false, error: data.error ?? "auth.test failed" }
  return { ok: true, user_id: data.user_id, user: data.user, team: data.team, team_id: data.team_id, bot_id: data.bot_id }
}

export async function slackSearch(opts: { query: string }): Promise<any> {
  const data = await apiGet("search.messages", { query: opts.query })
  if (!data.ok) return { ok: false, error: data.error ?? "search failed" }
  return { ok: true, messages: data.messages }
}

export async function slackFileInfo(opts: { fileId: string }): Promise<any> {
  const data = await apiGet("files.info", { file: opts.fileId })
  if (!data.ok) return { ok: false, error: data.error ?? "file info failed" }
  return { ok: true, file: data.file }
}

export async function slackDownload(opts: { url: string; out: string }): Promise<any> {
  const token = getToken()
  if (!token) return { ok: false, error: "SLACK_BOT_TOKEN not set" }

  try {
    const res = await fetch(opts.url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) return { ok: false, error: `Download failed: ${res.status}` }
    const buf = await res.arrayBuffer()
    const dir = opts.out.split("/").slice(0, -1).join("/")
    if (dir) mkdirSync(dir, { recursive: true })
    writeFileSync(opts.out, Buffer.from(buf))
    return { ok: true, path: opts.out, size: buf.byteLength }
  } catch (e) {
    return { ok: false, error: `Download failed: ${e}` }
  }
}

// ─── CLI argument parsing ────────────────────────────────────────────────────

function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const args = argv.slice(2)
  const command = args[0] ?? "help"
  const flags: Record<string, string> = {}
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const val = args[i + 1] && !args[i + 1]!.startsWith("--") ? args[++i]! : "true"
      flags[key] = val
    }
  }
  return { command, flags }
}

function out(data: unknown): void {
  console.log(JSON.stringify(data, null, 2))
}

// ─── CLI main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv)

  if (flags["config-id"]) {
    const { getChannel } = await import("./channel-db")
    const channel = getChannel(flags["config-id"])
    if (!channel) {
      out({ ok: false, error: `Channel not found: ${flags["config-id"]}` })
      process.exit(1)
    }
    if (channel.platform !== "slack") {
      out({ ok: false, error: `Channel ${flags["config-id"]} is not a Slack channel` })
      process.exit(1)
    }
    process.env.SLACK_BOT_TOKEN = channel.bot_token
    if (channel.signing_secret) process.env.SLACK_SIGNING_SECRET = channel.signing_secret
  }

  switch (command) {
    case "send": {
      if (!flags.channel) { out({ ok: false, error: "--channel required" }); process.exit(1) }
      // --text-file reads message text from a file (avoids shell escaping issues with code blocks, backticks, etc.)
      let text = flags.text
      if (flags["text-file"]) {
        try { text = readFileSync(flags["text-file"], "utf-8") } catch { out({ ok: false, error: `Cannot read --text-file: ${flags["text-file"]}` }); process.exit(1) }
      }
      if (!text && !flags.file) { out({ ok: false, error: "--text, --text-file, and/or --file required" }); process.exit(1) }
      const result = await slackSend({ channel: flags.channel, text, threadTs: flags.thread, file: flags.file })
      out(result); process.exit(result.ok ? 0 : 1); break
    }
    case "edit": {
      let editText = flags.text
      if (flags["text-file"]) { try { editText = readFileSync(flags["text-file"], "utf-8") } catch { out({ ok: false, error: `Cannot read --text-file` }); process.exit(1) } }
      if (!flags.channel || !flags.ts || !editText) { out({ ok: false, error: "--channel, --ts, --text (or --text-file) required" }); process.exit(1) }
      const result = await slackEdit({ channel: flags.channel, ts: flags.ts, text: editText })
      out(result); process.exit(result.ok ? 0 : 1); break
    }
    case "delete": {
      if (!flags.channel || !flags.ts) { out({ ok: false, error: "--channel and --ts required" }); process.exit(1) }
      const result = await slackDelete({ channel: flags.channel, ts: flags.ts })
      out(result); process.exit(result.ok ? 0 : 1); break
    }
    case "react": {
      if (!flags.channel || !flags.ts || !flags.emoji) { out({ ok: false, error: "--channel, --ts, --emoji required" }); process.exit(1) }
      const result = await slackReact({ channel: flags.channel, ts: flags.ts, emoji: flags.emoji })
      out(result); process.exit(result.ok ? 0 : 1); break
    }
    case "typing": {
      if (!flags.channel) { out({ ok: false, error: "--channel required" }); process.exit(1) }
      const result = await slackTyping({ channel: flags.channel })
      out(result); process.exit(result.ok ? 0 : 1); break
    }
    case "history": {
      if (!flags.channel) { out({ ok: false, error: "--channel required" }); process.exit(1) }
      const result = await slackHistory({ channel: flags.channel, limit: flags.limit ? parseInt(flags.limit, 10) : undefined })
      out(result); process.exit(result.ok ? 0 : 1); break
    }
    case "thread": {
      if (!flags.channel || !flags.ts) { out({ ok: false, error: "--channel and --ts required" }); process.exit(1) }
      const result = await slackThread({ channel: flags.channel, ts: flags.ts, limit: flags.limit ? parseInt(flags.limit, 10) : undefined })
      out(result); process.exit(result.ok ? 0 : 1); break
    }
    case "channels": {
      const result = await slackChannels({ limit: flags.limit ? parseInt(flags.limit, 10) : undefined })
      out(result); process.exit(result.ok ? 0 : 1); break
    }
    case "channel-info": {
      if (!flags.channel) { out({ ok: false, error: "--channel required" }); process.exit(1) }
      const result = await slackChannelInfo({ channel: flags.channel })
      out(result); process.exit(result.ok ? 0 : 1); break
    }
    case "join": {
      if (!flags.channel) { out({ ok: false, error: "--channel required" }); process.exit(1) }
      const result = await slackJoin({ channel: flags.channel })
      out(result); process.exit(result.ok ? 0 : 1); break
    }
    case "users": {
      const result = await slackUsers({ limit: flags.limit ? parseInt(flags.limit, 10) : undefined })
      out(result); process.exit(result.ok ? 0 : 1); break
    }
    case "user": {
      if (!flags.id) { out({ ok: false, error: "--id required" }); process.exit(1) }
      const result = await slackUser({ id: flags.id })
      out(result); process.exit(result.ok ? 0 : 1); break
    }
    case "me": {
      const result = await slackMe()
      out(result); process.exit(result.ok ? 0 : 1); break
    }
    case "search": {
      if (!flags.query) { out({ ok: false, error: "--query required" }); process.exit(1) }
      const result = await slackSearch({ query: flags.query })
      out(result); process.exit(result.ok ? 0 : 1); break
    }
    case "file-info": {
      if (!flags.file) { out({ ok: false, error: "--file required (file ID)" }); process.exit(1) }
      const result = await slackFileInfo({ fileId: flags.file })
      out(result); process.exit(result.ok ? 0 : 1); break
    }
    case "download": {
      if (!flags.url || !flags.out) { out({ ok: false, error: "--url and --out required" }); process.exit(1) }
      const result = await slackDownload({ url: flags.url, out: flags.out })
      out(result); process.exit(result.ok ? 0 : 1); break
    }
    case "setup": {
      if (!flags.token) {
        out({ ok: false, error: "--token required (xoxb-... Bot User OAuth Token)" })
        process.exit(1)
      }

      // Verify token
      const origToken = process.env.SLACK_BOT_TOKEN
      process.env.SLACK_BOT_TOKEN = flags.token
      const meSetup = await slackMe()
      if (!meSetup.ok) {
        process.env.SLACK_BOT_TOKEN = origToken
        out({ ok: false, error: `Invalid token: ${meSetup.error}` })
        process.exit(1)
      }

      const { createChannel } = await import("./channel-db")
      const channel = createChannel({
        platform: "slack",
        name: flags.name,
        bot_token: flags.token,
        signing_secret: flags["signing-secret"],
        bot_id: meSetup.user_id,
        bot_username: meSetup.user,
        default_agent: flags.agent,
        default_model: flags.model,
        created_by: flags["created-by"],
      })

      process.env.SLACK_BOT_TOKEN = origToken

      // Generate manifest if URL provided
      const publicUrl = getPublicUrl(flags.url)
      const webhookUrl = publicUrl ? joinPublicBaseUrl(publicUrl, channel.webhook_path) : null

      out({
        ok: true,
        channel: {
          id: channel.id,
          name: channel.name,
          bot: `@${channel.bot_username}`,
          team: meSetup.team,
          webhook_path: channel.webhook_path,
          webhook_url: webhookUrl || "not set — provide --url and update Slack Event Subscriptions URL",
        },
        message: `Slack bot @${channel.bot_username} set up as "${channel.name}"`,
        next_step: webhookUrl
          ? `Update your Slack app Event Subscriptions URL to: ${webhookUrl}`
          : "Set --url to your public URL so the webhook can be configured",
      })
      break
    }

    case "manifest": {
      const publicUrl = getPublicUrl(flags.url)
      if (!publicUrl) { out({ ok: false, error: "--url required (your public URL for webhooks)" }); process.exit(1) }
      const channelId = flags["channel-id"] || "new"
      const webhookUrl = joinPublicBaseUrl(publicUrl, `/hooks/slack/${channelId}`)
      const manifest = {
        display_information: { name: flags.name || `Kortix ${["Atlas","Nova","Sage","Echo","Bolt","Iris","Dash","Cleo","Finn","Luna","Juno","Axel","Niko","Zara","Milo","Ruby","Hugo","Aria","Leo","Ivy"][Math.floor(Math.random()*20)]}`, description: "Kortix AI instance", background_color: "#1a1a2e" },
        features: { bot_user: { display_name: flags.name || "Kortix", always_online: true } },
        oauth_config: { scopes: { bot: [
          "app_mentions:read", "channels:history", "channels:read", "channels:join",
          "chat:write", "chat:write.public", "files:read", "files:write",
          "groups:history", "groups:read", "im:history", "im:read", "im:write",
          "mpim:history", "mpim:read", "reactions:read", "reactions:write", "users:read",
        ] } },
        settings: {
          event_subscriptions: { request_url: webhookUrl, bot_events: [
            "app_mention", "message.im", "message.channels", "message.groups", "message.mpim",
            "reaction_added", "reaction_removed", "member_joined_channel", "file_shared",
          ] },
          org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false,
        },
      }
      out({ ok: true, manifest, webhook_url: webhookUrl })
      break
    }

    case "help":
    default:
      console.log(`
Slack Web API CLI

Commands:
  setup         Set up new Slack bot (--token, [--signing-secret], [--name], [--url], [--created-by])
  manifest      Generate Slack app manifest (--url, [--name], [--channel-id])
  send          Send message/file (--channel, --text, [--thread], [--file], [--text-file], [--config-id])
  edit          Edit a message (--channel, --ts, --text/--text-file, [--config-id])
  delete        Delete a message (--channel, --ts, [--config-id])
  react         Add reaction (--channel, --ts, --emoji, [--config-id])
  typing        Typing indicator (--channel, [--config-id])
  history       Channel history (--channel, [--limit], [--config-id])
  thread        Thread replies (--channel, --ts, [--limit], [--config-id])
  channels      List channels ([--limit])
  channel-info  Get channel info (--channel)
  join          Join channel (--channel)
  users         List users ([--limit])
  user          Get user info (--id)
  me            Bot identity
  search        Search messages (--query)
  file-info     Get file info (--file <file_id>)
  download      Download file (--url <url_private> --out <path>)

Auth: SLACK_BOT_TOKEN env var or --config-id <channel-id>
`)
      break
  }
}

if (import.meta.main) {
  main().catch((err) => {
    out({ ok: false, error: err instanceof Error ? err.message : String(err) })
    process.exit(1)
  })
}
