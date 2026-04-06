#!/usr/bin/env bun
/**
 * WhatsApp Business Cloud API CLI — thin wrapper around the Cloud API.
 *
 * Usage:
 *   bun run whatsapp.ts send --phone <number> --text "message"
 *   bun run whatsapp.ts send --phone <number> --file /path/to/file --text "caption"
 *   bun run whatsapp.ts typing --phone <number>
 *   bun run whatsapp.ts me
 *   bun run whatsapp.ts setup
 *
 * Auth: WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID env vars.
 * Output: JSON always. Exit 0 on success, 1 on failure.
 */

import { readFileSync, existsSync } from "node:fs"

// ─── Env resolution ──────────────────────────────────────────────────────────

const S6_ENV_DIR = process.env.S6_ENV_DIR || "/run/s6/container_environment"

function getEnv(key: string): string | undefined {
  try {
    const val = readFileSync(`${S6_ENV_DIR}/${key}`, "utf-8").trim()
    if (val) return val
  } catch {}
  return process.env[key]
}

function getToken(): string | undefined {
  return getEnv("WHATSAPP_ACCESS_TOKEN")
}

function getPhoneNumberId(): string | undefined {
  return getEnv("WHATSAPP_PHONE_NUMBER_ID")
}

function apiBase(): string {
  return getEnv("WHATSAPP_API_BASE_URL") || "https://graph.facebook.com/v21.0"
}

function joinPublicBaseUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl)
  const suffix = path.startsWith('/') ? path : `/${path}`
  const basePath = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname
  const joined = new URL(`${basePath}${suffix}`, base.origin)
  for (const [k, v] of base.searchParams) {
    joined.searchParams.set(k, v)
  }
  return joined.toString()
}

// ─── API helper ──────────────────────────────────────────────────────────────

async function api(endpoint: string, body?: Record<string, unknown>): Promise<any> {
  const token = getToken()
  if (!token) return { ok: false, error: "WHATSAPP_ACCESS_TOKEN not set" }

  const url = `${apiBase()}/${endpoint}`
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  })
  return await res.json()
}

async function apiGet(endpoint: string): Promise<any> {
  const token = getToken()
  if (!token) return { ok: false, error: "WHATSAPP_ACCESS_TOKEN not set" }

  const url = `${apiBase()}/${endpoint}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  })
  return await res.json()
}

// ─── Exported handler functions (used by tests and CLI) ──────────────────────

export async function whatsappSend(opts: { phone: string; text?: string; file?: string }): Promise<any> {
  const token = getToken()
  const phoneNumberId = getPhoneNumberId()
  if (!token) return { ok: false, error: "WHATSAPP_ACCESS_TOKEN not set" }
  if (!phoneNumberId) return { ok: false, error: "WHATSAPP_PHONE_NUMBER_ID not set" }

  // File upload via media API
  if (opts.file) {
    if (!existsSync(opts.file)) return { ok: false, error: `File not found: ${opts.file}` }

    const fileData = readFileSync(opts.file)
    const fileName = opts.file.split("/").pop() || "file"
    const ext = fileName.split(".").pop()?.toLowerCase() || ""

    // Determine MIME type and WhatsApp message type
    const imageExts = new Set(["jpg", "jpeg", "png", "webp"])
    const videoExts = new Set(["mp4", "3gp"])
    const audioExts = new Set(["mp3", "ogg", "amr", "aac", "m4a"])
    const docExts = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "zip"])

    let mediaType: string
    let mimeType: string
    if (imageExts.has(ext)) { mediaType = "image"; mimeType = `image/${ext === "jpg" ? "jpeg" : ext}` }
    else if (videoExts.has(ext)) { mediaType = "video"; mimeType = `video/${ext}` }
    else if (audioExts.has(ext)) { mediaType = "audio"; mimeType = ext === "mp3" ? "audio/mpeg" : `audio/${ext}` }
    else { mediaType = "document"; mimeType = "application/octet-stream" }

    // Step 1: Upload media
    const formData = new FormData()
    formData.append("file", new Blob([fileData], { type: mimeType }), fileName)
    formData.append("messaging_product", "whatsapp")
    formData.append("type", mimeType)

    const uploadRes = await fetch(`${apiBase()}/${phoneNumberId}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
      signal: AbortSignal.timeout(60_000),
    })
    const uploadData = await uploadRes.json() as any
    if (!uploadData.id) return { ok: false, error: uploadData.error?.message ?? "Media upload failed" }

    // Step 2: Send media message
    const mediaBody: Record<string, unknown> = { id: uploadData.id }
    if (opts.text) mediaBody.caption = opts.text
    if (mediaType === "document") mediaBody.filename = fileName

    const sendRes = await api(`${phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to: opts.phone,
      type: mediaType,
      [mediaType]: mediaBody,
    })
    if (sendRes.error) return { ok: false, error: sendRes.error.message ?? "send media failed" }
    return { ok: true, message_id: sendRes.messages?.[0]?.id, phone: opts.phone, type: mediaType }
  }

  // Text-only message
  if (!opts.text) return { ok: false, error: "Either --text or --file required" }

  const data = await api(`${phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    to: opts.phone,
    type: "text",
    text: { body: opts.text },
  })
  if (data.error) return { ok: false, error: data.error.message ?? "send failed" }
  return { ok: true, message_id: data.messages?.[0]?.id, phone: opts.phone }
}

export async function whatsappReact(opts: { phone: string; messageId: string; emoji: string }): Promise<any> {
  const phoneNumberId = getPhoneNumberId()
  if (!phoneNumberId) return { ok: false, error: "WHATSAPP_PHONE_NUMBER_ID not set" }

  const data = await api(`${phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    to: opts.phone,
    type: "reaction",
    reaction: { message_id: opts.messageId, emoji: opts.emoji },
  })
  if (data.error) return { ok: false, error: data.error.message ?? "react failed" }
  return { ok: true }
}

export async function whatsappTyping(opts: { phone: string }): Promise<any> {
  // WhatsApp Cloud API doesn't have a persistent typing indicator.
  // Mark as "read" to signal engagement.
  return { ok: true, note: "WhatsApp Cloud API does not support persistent typing indicators" }
}

export async function whatsappMe(): Promise<any> {
  const phoneNumberId = getPhoneNumberId()
  if (!phoneNumberId) return { ok: false, error: "WHATSAPP_PHONE_NUMBER_ID not set" }

  const data = await apiGet(`${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`)
  if (data.error) return { ok: false, error: data.error.message ?? "getMe failed" }
  return {
    ok: true,
    phone: {
      id: phoneNumberId,
      display_phone_number: data.display_phone_number,
      verified_name: data.verified_name,
      quality_rating: data.quality_rating,
    },
  }
}

export async function whatsappMarkRead(opts: { messageId: string }): Promise<any> {
  const phoneNumberId = getPhoneNumberId()
  if (!phoneNumberId) return { ok: false, error: "WHATSAPP_PHONE_NUMBER_ID not set" }

  const data = await api(`${phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    status: "read",
    message_id: opts.messageId,
  })
  if (data.error) return { ok: false, error: data.error.message ?? "mark read failed" }
  return { ok: true }
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
    if (channel.platform !== "whatsapp") {
      out({ ok: false, error: `Channel ${flags["config-id"]} is not a WhatsApp channel` })
      process.exit(1)
    }
    // bot_token stores "ACCESS_TOKEN|PHONE_NUMBER_ID"
    const parts = channel.bot_token.split("|")
    process.env.WHATSAPP_ACCESS_TOKEN = parts[0]
    if (parts[1]) process.env.WHATSAPP_PHONE_NUMBER_ID = parts[1]
  }

  switch (command) {
    case "send": {
      if (!flags.phone) { out({ ok: false, error: "--phone required" }); process.exit(1) }
      let text = flags.text
      if (flags["text-file"]) {
        try { text = readFileSync(flags["text-file"], "utf-8") } catch { out({ ok: false, error: `Cannot read --text-file: ${flags["text-file"]}` }); process.exit(1) }
      }
      if (!text && !flags.file) { out({ ok: false, error: "--text, --text-file, and/or --file required" }); process.exit(1) }
      const result = await whatsappSend({ phone: flags.phone, text, file: flags.file })
      out(result)
      process.exit(result.ok ? 0 : 1)
      break
    }

    case "react": {
      if (!flags.phone || !flags["message-id"] || !flags.emoji) {
        out({ ok: false, error: "--phone, --message-id, and --emoji required" }); process.exit(1)
      }
      const result = await whatsappReact({ phone: flags.phone, messageId: flags["message-id"], emoji: flags.emoji })
      out(result)
      process.exit(result.ok ? 0 : 1)
      break
    }

    case "typing": {
      if (!flags.phone) { out({ ok: false, error: "--phone required" }); process.exit(1) }
      const result = await whatsappTyping({ phone: flags.phone })
      out(result)
      process.exit(result.ok ? 0 : 1)
      break
    }

    case "mark-read": {
      if (!flags["message-id"]) { out({ ok: false, error: "--message-id required" }); process.exit(1) }
      const result = await whatsappMarkRead({ messageId: flags["message-id"] })
      out(result)
      process.exit(result.ok ? 0 : 1)
      break
    }

    case "me": {
      const result = await whatsappMe()
      out(result)
      process.exit(result.ok ? 0 : 1)
      break
    }

    case "setup": {
      if (!flags.token) {
        out({ ok: false, error: "--token required (WhatsApp Business Cloud API access token)" })
        process.exit(1)
      }
      if (!flags["phone-number-id"]) {
        out({ ok: false, error: "--phone-number-id required (from Meta Business Suite)" })
        process.exit(1)
      }

      // Verify credentials
      const origToken = process.env.WHATSAPP_ACCESS_TOKEN
      const origPhone = process.env.WHATSAPP_PHONE_NUMBER_ID
      process.env.WHATSAPP_ACCESS_TOKEN = flags.token
      process.env.WHATSAPP_PHONE_NUMBER_ID = flags["phone-number-id"]
      const meResult = await whatsappMe()
      if (!meResult.ok) {
        process.env.WHATSAPP_ACCESS_TOKEN = origToken
        process.env.WHATSAPP_PHONE_NUMBER_ID = origPhone
        out({ ok: false, error: `Invalid credentials: ${meResult.error}` })
        process.exit(1)
      }

      // Store as "ACCESS_TOKEN|PHONE_NUMBER_ID" in bot_token field
      const combinedToken = `${flags.token}|${flags["phone-number-id"]}`

      const { upsertChannelByBot } = await import("./channel-db")
      const { channel, created, deduped } = upsertChannelByBot({
        platform: "whatsapp",
        name: flags.name,
        bot_token: combinedToken,
        bot_id: flags["phone-number-id"],
        bot_username: meResult.phone.verified_name || meResult.phone.display_phone_number,
        default_agent: flags.agent,
        default_model: flags.model,
        created_by: flags["created-by"],
      })

      const publicUrl = flags.url || getEnv("PUBLIC_URL") || ""

      // Restore original env
      process.env.WHATSAPP_ACCESS_TOKEN = origToken
      process.env.WHATSAPP_PHONE_NUMBER_ID = origPhone

      out({
        ok: true,
        channel: {
          id: channel.id,
          name: channel.name,
          phone: meResult.phone.display_phone_number,
          verified_name: meResult.phone.verified_name,
          webhook_path: channel.webhook_path,
          webhook_url: publicUrl ? joinPublicBaseUrl(publicUrl, channel.webhook_path) : "not set — provide --url",
          deduped,
        },
        message: `WhatsApp ${meResult.phone.verified_name || meResult.phone.display_phone_number} ${created ? "set up" : "updated"} as "${channel.name}"`,
        next_step: `Set your Meta App webhook URL to: ${publicUrl ? joinPublicBaseUrl(publicUrl, channel.webhook_path) : "<your-public-url>" + channel.webhook_path} and subscribe to "messages" events`,
      })
      break
    }

    case "help":
    default:
      console.log(`
WhatsApp Business Cloud API CLI

Commands:
  setup         Set up new WhatsApp channel (--token, --phone-number-id, [--name], [--url], [--created-by])
  send          Send message/file (--phone, --text/--text-file, [--file], [--config-id])
  react         React to message (--phone, --message-id, --emoji, [--config-id])
  typing        Typing indicator (--phone, [--config-id])
  mark-read     Mark message read (--message-id, [--config-id])
  me            Get phone number info

Auth: WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID env vars or --config-id <channel-id>
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
