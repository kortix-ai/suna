#!/usr/bin/env bun
/**
 * Telegram Bot API CLI — thin wrapper around the raw API.
 *
 * Usage:
 *   bun run telegram.ts send --chat <id> --text "message"
 *   bun run telegram.ts edit --chat <id> --message-id <id> --text "updated"
 *   bun run telegram.ts delete --chat <id> --message-id <id>
 *   bun run telegram.ts typing --chat <id>
 *   bun run telegram.ts me
 *   bun run telegram.ts get-chat --chat <id>
 *   bun run telegram.ts set-webhook --url <url> [--secret <token>]
 *   bun run telegram.ts delete-webhook
 *   bun run telegram.ts webhook-info
 *   bun run telegram.ts file --file-id <id>
 *   bun run telegram.ts setup
 *
 * Auth: TELEGRAM_BOT_TOKEN env var.
 * Output: JSON always. Exit 0 on success, 1 on failure.
 */

import { readFileSync } from "node:fs"

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
  return getEnv("TELEGRAM_BOT_TOKEN")
}

function apiBase(): string {
  return getEnv("TELEGRAM_API_BASE_URL") || "https://api.telegram.org"
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

// ─── API helper ──────────────────────────────────────────────────────────────

async function api(method: string, body?: Record<string, unknown>): Promise<any> {
  const token = getToken()
  if (!token) return { ok: false, error: "TELEGRAM_BOT_TOKEN not set" }

  const url = `${apiBase()}/bot${token}/${method}`
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  })
  return await res.json()
}

// ─── Exported handler functions (used by tests and CLI) ──────────────────────

export async function telegramSend(opts: { chat: string; text?: string; replyTo?: number; file?: string }): Promise<any> {
  const token = getToken()
  if (!token) return { ok: false, error: "TELEGRAM_BOT_TOKEN not set" }

  // If file is provided, send as document/photo/video depending on extension
  if (opts.file) {
    const { readFileSync, existsSync } = await import("node:fs")
    if (!existsSync(opts.file)) return { ok: false, error: `File not found: ${opts.file}` }

    const fileData = readFileSync(opts.file)
    const fileName = opts.file.split("/").pop() || "file"
    const ext = fileName.split(".").pop()?.toLowerCase() || ""

    // Pick the right Telegram method based on file type
    const imageExts = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp"])
    const videoExts = new Set(["mp4", "avi", "mov", "mkv", "webm"])
    const audioExts = new Set(["mp3", "ogg", "oga", "m4a", "wav", "flac"])
    const voiceExts = new Set(["ogg", "oga"])

    let method: string
    let fieldName: string
    if (imageExts.has(ext)) { method = "sendPhoto"; fieldName = "photo" }
    else if (videoExts.has(ext)) { method = "sendVideo"; fieldName = "video" }
    else if (audioExts.has(ext) && !voiceExts.has(ext)) { method = "sendAudio"; fieldName = "audio" }
    else { method = "sendDocument"; fieldName = "document" }

    const formData = new FormData()
    formData.append("chat_id", opts.chat)
    formData.append(fieldName, new Blob([fileData]), fileName)
    if (opts.text) formData.append("caption", opts.text)
    if (opts.replyTo) formData.append("reply_to_message_id", String(opts.replyTo))

    const res = await fetch(`${apiBase()}/bot${token}/${method}`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(60_000),
    })
    const data = await res.json() as any
    if (!data.ok) return { ok: false, error: data.description ?? "send file failed" }
    return { ok: true, message_id: data.result.message_id, chat_id: opts.chat, method }
  }

  // Text-only message
  if (!opts.text) return { ok: false, error: "Either --text or --file required" }
  const body: Record<string, unknown> = { chat_id: opts.chat, text: opts.text }
  if (opts.replyTo) body.reply_to_message_id = opts.replyTo

  // Try Markdown first, fall back to plain text if it fails (unescaped chars etc.)
  body.parse_mode = "Markdown"
  const data = await api("sendMessage", body)
  if (data.ok) return { ok: true, message_id: data.result.message_id, chat_id: opts.chat }

  // Markdown failed — retry plain text
  delete body.parse_mode
  const fallback = await api("sendMessage", body)
  if (!fallback.ok) return { ok: false, error: fallback.description ?? fallback.error ?? "send failed" }
  return { ok: true, message_id: fallback.result.message_id, chat_id: opts.chat }
}

export async function telegramEdit(opts: { chat: string; messageId: number; text: string }): Promise<any> {
  // Try Markdown first, fall back to plain
  const body = { chat_id: opts.chat, message_id: opts.messageId, text: opts.text, parse_mode: "Markdown" as string | undefined }
  const data = await api("editMessageText", body)
  if (data.ok) return { ok: true, message_id: data.result.message_id }

  delete body.parse_mode
  const fallback = await api("editMessageText", body)
  if (!fallback.ok) return { ok: false, error: fallback.description ?? "edit failed" }
  return { ok: true, message_id: fallback.result.message_id }
}

export async function telegramDelete(opts: { chat: string; messageId: number }): Promise<any> {
  const data = await api("deleteMessage", { chat_id: opts.chat, message_id: opts.messageId })
  if (!data.ok) return { ok: false, error: data.description ?? "delete failed" }
  return { ok: true }
}

export async function telegramTyping(opts: { chat: string }): Promise<any> {
  const data = await api("sendChatAction", { chat_id: opts.chat, action: "typing" })
  if (!data.ok) return { ok: false, error: data.description ?? "typing failed" }
  return { ok: true }
}

export async function telegramMe(): Promise<any> {
  const data = await api("getMe")
  if (!data.ok) return { ok: false, error: data.description ?? data.error ?? "getMe failed" }
  return { ok: true, bot: data.result }
}

export async function telegramGetChat(opts: { chat: string }): Promise<any> {
  const data = await api("getChat", { chat_id: opts.chat })
  if (!data.ok) return { ok: false, error: data.description ?? "getChat failed" }
  return { ok: true, chat: data.result }
}

export async function telegramSetWebhook(opts: { url: string; secretToken?: string }): Promise<any> {
  const body: Record<string, unknown> = { url: opts.url }
  if (opts.secretToken) body.secret_token = opts.secretToken

  const data = await api("setWebhook", body)
  if (!data.ok) return { ok: false, error: data.description ?? "setWebhook failed" }
  return { ok: true }
}

export async function telegramDeleteWebhook(): Promise<any> {
  const data = await api("deleteWebhook")
  if (!data.ok) return { ok: false, error: data.description ?? "deleteWebhook failed" }
  return { ok: true }
}

export async function telegramWebhookInfo(): Promise<any> {
  const data = await api("getWebhookInfo")
  if (!data.ok) return { ok: false, error: data.description ?? data.error ?? "getWebhookInfo failed" }
  return { ok: true, webhook: data.result }
}

const DEFAULT_TELEGRAM_COMMANDS = [
  { command: "status", description: "Current config & session" },
  { command: "model", description: "Set model (provider/model)" },
  { command: "agent", description: "Set agent" },
  { command: "name", description: "Rename this channel" },
  { command: "instructions", description: "Set system prompt" },
  { command: "new", description: "Start fresh session" },
  { command: "sessions", description: "List recent sessions" },
  { command: "session", description: "Switch session" },
  { command: "help", description: "All commands" },
] as const

export async function telegramSetCommands(commands: ReadonlyArray<{ command: string; description: string }> = DEFAULT_TELEGRAM_COMMANDS): Promise<any> {
  const data = await api("setMyCommands", { commands })
  if (!data.ok) return { ok: false, error: data.description ?? data.error ?? "setMyCommands failed" }
  return { ok: true, commands: commands.length }
}

export async function telegramGetFile(opts: { fileId: string }): Promise<any> {
  const data = await api("getFile", { file_id: opts.fileId })
  if (!data.ok) return { ok: false, error: data.description ?? "getFile failed" }
  return { ok: true, file: data.result, download_url: `${apiBase()}/file/bot${getToken()}/${data.result.file_path}` }
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
    if (channel.platform !== "telegram") {
      out({ ok: false, error: `Channel ${flags["config-id"]} is not a Telegram channel` })
      process.exit(1)
    }
    process.env.TELEGRAM_BOT_TOKEN = channel.bot_token
  }

  switch (command) {
    case "send": {
      if (!flags.chat) { out({ ok: false, error: "--chat required" }); process.exit(1) }
      let text = flags.text
      if (flags["text-file"]) {
        try { text = readFileSync(flags["text-file"], "utf-8") } catch { out({ ok: false, error: `Cannot read --text-file: ${flags["text-file"]}` }); process.exit(1) }
      }
      if (!text && !flags.file) { out({ ok: false, error: "--text, --text-file, and/or --file required" }); process.exit(1) }
      const result = await telegramSend({
        chat: flags.chat, text, file: flags.file,
        replyTo: flags["reply-to"] ? parseInt(flags["reply-to"], 10) : undefined,
      })
      out(result)
      process.exit(result.ok ? 0 : 1)
      break
    }

    case "edit": {
      let editText = flags.text
      if (flags["text-file"]) { try { editText = readFileSync(flags["text-file"], "utf-8") } catch { out({ ok: false, error: `Cannot read --text-file` }); process.exit(1) } }
      if (!flags.chat || !flags["message-id"] || !editText) {
        out({ ok: false, error: "--chat, --message-id, and --text (or --text-file) required" }); process.exit(1)
      }
      const result = await telegramEdit({
        chat: flags.chat, messageId: parseInt(flags["message-id"], 10), text: editText,
      })
      out(result)
      process.exit(result.ok ? 0 : 1)
      break
    }

    case "delete": {
      if (!flags.chat || !flags["message-id"]) {
        out({ ok: false, error: "--chat and --message-id required" }); process.exit(1)
      }
      const result = await telegramDelete({
        chat: flags.chat, messageId: parseInt(flags["message-id"], 10),
      })
      out(result)
      process.exit(result.ok ? 0 : 1)
      break
    }

    case "typing": {
      if (!flags.chat) { out({ ok: false, error: "--chat required" }); process.exit(1) }
      const result = await telegramTyping({ chat: flags.chat })
      out(result)
      process.exit(result.ok ? 0 : 1)
      break
    }

    case "me": {
      const result = await telegramMe()
      out(result)
      process.exit(result.ok ? 0 : 1)
      break
    }

    case "get-chat": {
      if (!flags.chat) { out({ ok: false, error: "--chat required" }); process.exit(1) }
      const result = await telegramGetChat({ chat: flags.chat })
      out(result)
      process.exit(result.ok ? 0 : 1)
      break
    }

    case "set-webhook": {
      if (!flags.url) { out({ ok: false, error: "--url required" }); process.exit(1) }
      const result = await telegramSetWebhook({ url: flags.url, secretToken: flags.secret })
      out(result)
      process.exit(result.ok ? 0 : 1)
      break
    }

    case "delete-webhook": {
      const result = await telegramDeleteWebhook()
      out(result)
      process.exit(result.ok ? 0 : 1)
      break
    }

    case "webhook-info": {
      const result = await telegramWebhookInfo()
      out(result)
      process.exit(result.ok ? 0 : 1)
      break
    }

    case "file": {
      if (!flags["file-id"]) { out({ ok: false, error: "--file-id required" }); process.exit(1) }
      const result = await telegramGetFile({ fileId: flags["file-id"] })
      out(result)
      process.exit(result.ok ? 0 : 1)
      break
    }

    case "setup": {
      // Non-interactive setup: --token required, --name and --created-by optional
      if (!flags.token) {
        out({ ok: false, error: "--token required. Get it from @BotFather on Telegram." })
        process.exit(1)
      }

      // Verify token
      const origToken = process.env.TELEGRAM_BOT_TOKEN
      process.env.TELEGRAM_BOT_TOKEN = flags.token
      const meResult = await telegramMe()
      if (!meResult.ok) {
        process.env.TELEGRAM_BOT_TOKEN = origToken
        out({ ok: false, error: `Invalid token: ${meResult.error}` })
        process.exit(1)
      }

      // Create or update channel in DB (one Telegram bot => one channel row)
      const { upsertChannelByBot } = await import("./channel-db")
      const { channel, created, deduped } = upsertChannelByBot({
        platform: "telegram",
        name: flags.name,
        bot_token: flags.token,
        bot_id: String(meResult.bot.id),
        bot_username: meResult.bot.username,
        default_agent: flags.agent,
        default_model: flags.model,
        created_by: flags["created-by"],
      })

      // Register webhook
      const publicUrl = getPublicUrl(flags.url)
      if (publicUrl) {
        const webhookUrl = joinPublicBaseUrl(publicUrl, channel.webhook_path)
        await telegramSetWebhook({ url: webhookUrl, secretToken: channel.webhook_secret })
      }

      // Register default bot commands so slash menu works out of the box
      const commandsResult = await telegramSetCommands()

      // Restore original token
      process.env.TELEGRAM_BOT_TOKEN = origToken

      out({
        ok: true,
        channel: {
          id: channel.id,
          name: channel.name,
          bot: `@${channel.bot_username}`,
          webhook_path: channel.webhook_path,
          webhook_url: publicUrl ? joinPublicBaseUrl(publicUrl, channel.webhook_path) : "not set — provide --url",
          commands_configured: commandsResult.ok,
          deduped,
        },
        message: `Telegram bot @${channel.bot_username} ${created ? "set up" : "updated"} as "${channel.name}"`,
      })
      break
    }

    case "help":
    default:
      console.log(`
Telegram Bot API CLI

Commands:
  setup         Set up new Telegram bot (--token, [--name], [--url], [--created-by])
  send          Send message/file (--chat, --text/--text-file, [--reply-to], [--file], [--config-id])
  edit          Edit a message (--chat, --message-id, --text/--text-file, [--config-id])
  delete        Delete a message (--chat, --message-id, [--config-id])
  typing        Send typing indicator (--chat, [--config-id])
  me            Get bot info
  get-chat      Get chat info (--chat, [--config-id])
  set-webhook   Register webhook (--url, [--secret], [--config-id])
  delete-webhook Remove webhook
  webhook-info  Get webhook status
  set-commands  Register default Telegram slash commands
  file          Get file info (--file-id, [--config-id])

Auth: TELEGRAM_BOT_TOKEN env var or --config-id <channel-id>
`)
      break
  }
}

// Only run main when executed directly (not when imported for testing)
if (import.meta.main) {
  main().catch((err) => {
    out({ ok: false, error: err instanceof Error ? err.message : String(err) })
    process.exit(1)
  })
}
