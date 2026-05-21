#!/usr/bin/env bun
import { readFileSync, existsSync } from "node:fs"

function getToken(): string | undefined {
  return process.env.TELEGRAM_BOT_TOKEN
}

function apiBase(): string {
  return process.env.TELEGRAM_API_BASE_URL || "https://api.telegram.org"
}

function joinUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl)
  const suffix = path.startsWith("/") ? path : `/${path}`
  const basePath = base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname
  const joined = new URL(`${basePath}${suffix}`, base.origin)
  for (const [k, v] of base.searchParams) joined.searchParams.set(k, v)
  return joined.toString()
}

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

async function telegramSend(opts: { chat: string; text?: string; replyTo?: number; file?: string }): Promise<any> {
  const token = getToken()
  if (!token) return { ok: false, error: "TELEGRAM_BOT_TOKEN not set" }

  if (opts.file) {
    if (!existsSync(opts.file)) return { ok: false, error: `File not found: ${opts.file}` }
    const fileData = readFileSync(opts.file)
    const fileName = opts.file.split("/").pop() || "file"
    const ext = fileName.split(".").pop()?.toLowerCase() || ""

    const imageExts = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp"])
    const videoExts = new Set(["mp4", "avi", "mov", "mkv", "webm"])
    const audioExts = new Set(["mp3", "ogg", "oga", "m4a", "wav", "flac"])
    const voiceExts = new Set(["ogg", "oga"])

    let method: string, fieldName: string
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
    const data = (await res.json()) as any
    if (!data.ok) return { ok: false, error: data.description ?? "send file failed" }
    return { ok: true, message_id: data.result.message_id, chat_id: opts.chat, method }
  }

  if (!opts.text) return { ok: false, error: "Either --text or --file required" }
  const body: Record<string, unknown> = { chat_id: opts.chat, text: opts.text }
  if (opts.replyTo) body.reply_to_message_id = opts.replyTo

  body.parse_mode = "Markdown"
  const data = await api("sendMessage", body)
  if (data.ok) return { ok: true, message_id: data.result.message_id, chat_id: opts.chat }

  delete body.parse_mode
  const fallback = await api("sendMessage", body)
  if (!fallback.ok) return { ok: false, error: fallback.description ?? fallback.error ?? "send failed" }
  return { ok: true, message_id: fallback.result.message_id, chat_id: opts.chat }
}

async function telegramEdit(opts: { chat: string; messageId: number; text: string }): Promise<any> {
  const body = { chat_id: opts.chat, message_id: opts.messageId, text: opts.text, parse_mode: "Markdown" as string | undefined }
  const data = await api("editMessageText", body)
  if (data.ok) return { ok: true, message_id: data.result.message_id }
  delete body.parse_mode
  const fallback = await api("editMessageText", body)
  if (!fallback.ok) return { ok: false, error: fallback.description ?? "edit failed" }
  return { ok: true, message_id: fallback.result.message_id }
}

async function telegramDelete(opts: { chat: string; messageId: number }): Promise<any> {
  const data = await api("deleteMessage", { chat_id: opts.chat, message_id: opts.messageId })
  if (!data.ok) return { ok: false, error: data.description ?? "delete failed" }
  return { ok: true }
}

async function telegramTyping(opts: { chat: string }): Promise<any> {
  const data = await api("sendChatAction", { chat_id: opts.chat, action: "typing" })
  if (!data.ok) return { ok: false, error: data.description ?? "typing failed" }
  return { ok: true }
}

async function telegramMe(): Promise<any> {
  const data = await api("getMe")
  if (!data.ok) return { ok: false, error: data.description ?? data.error ?? "getMe failed" }
  return { ok: true, bot: data.result }
}

async function telegramGetChat(opts: { chat: string }): Promise<any> {
  const data = await api("getChat", { chat_id: opts.chat })
  if (!data.ok) return { ok: false, error: data.description ?? "getChat failed" }
  return { ok: true, chat: data.result }
}

async function telegramSetWebhook(opts: { url: string; secretToken?: string }): Promise<any> {
  const body: Record<string, unknown> = { url: opts.url }
  if (opts.secretToken) body.secret_token = opts.secretToken
  const data = await api("setWebhook", body)
  if (!data.ok) return { ok: false, error: data.description ?? "setWebhook failed" }
  return { ok: true }
}

async function telegramDeleteWebhook(): Promise<any> {
  const data = await api("deleteWebhook")
  if (!data.ok) return { ok: false, error: data.description ?? "deleteWebhook failed" }
  return { ok: true }
}

async function telegramWebhookInfo(): Promise<any> {
  const data = await api("getWebhookInfo")
  if (!data.ok) return { ok: false, error: data.description ?? data.error ?? "getWebhookInfo failed" }
  return { ok: true, webhook: data.result }
}

async function telegramGetFile(opts: { fileId: string }): Promise<any> {
  const data = await api("getFile", { file_id: opts.fileId })
  if (!data.ok) return { ok: false, error: data.description ?? "getFile failed" }
  return {
    ok: true,
    file: data.result,
    download_url: `${apiBase()}/file/bot${getToken()}/${data.result.file_path}`,
  }
}

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

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv)

  switch (command) {
    case "send": {
      if (!flags.chat) { out({ ok: false, error: "--chat required" }); process.exit(1) }
      let text = flags.text
      if (flags["text-file"]) {
        try { text = readFileSync(flags["text-file"], "utf-8") }
        catch { out({ ok: false, error: `Cannot read --text-file: ${flags["text-file"]}` }); process.exit(1) }
      }
      if (!text && !flags.file) { out({ ok: false, error: "--text, --text-file, and/or --file required" }); process.exit(1) }
      const r = await telegramSend({
        chat: flags.chat, text, file: flags.file,
        replyTo: flags["reply-to"] ? parseInt(flags["reply-to"], 10) : undefined,
      })
      out(r); process.exit(r.ok ? 0 : 1); break
    }
    case "edit": {
      let editText = flags.text
      if (flags["text-file"]) {
        try { editText = readFileSync(flags["text-file"], "utf-8") }
        catch { out({ ok: false, error: `Cannot read --text-file` }); process.exit(1) }
      }
      if (!flags.chat || !flags["message-id"] || !editText) {
        out({ ok: false, error: "--chat, --message-id, --text (or --text-file) required" }); process.exit(1)
      }
      const r = await telegramEdit({ chat: flags.chat, messageId: parseInt(flags["message-id"], 10), text: editText })
      out(r); process.exit(r.ok ? 0 : 1); break
    }
    case "delete": {
      if (!flags.chat || !flags["message-id"]) {
        out({ ok: false, error: "--chat and --message-id required" }); process.exit(1)
      }
      const r = await telegramDelete({ chat: flags.chat, messageId: parseInt(flags["message-id"], 10) })
      out(r); process.exit(r.ok ? 0 : 1); break
    }
    case "typing": {
      if (!flags.chat) { out({ ok: false, error: "--chat required" }); process.exit(1) }
      const r = await telegramTyping({ chat: flags.chat })
      out(r); process.exit(r.ok ? 0 : 1); break
    }
    case "me": {
      const r = await telegramMe()
      out(r); process.exit(r.ok ? 0 : 1); break
    }
    case "get-chat": {
      if (!flags.chat) { out({ ok: false, error: "--chat required" }); process.exit(1) }
      const r = await telegramGetChat({ chat: flags.chat })
      out(r); process.exit(r.ok ? 0 : 1); break
    }
    case "set-webhook": {
      if (!flags.url) { out({ ok: false, error: "--url required" }); process.exit(1) }
      const r = await telegramSetWebhook({ url: flags.url, secretToken: flags.secret })
      out(r); process.exit(r.ok ? 0 : 1); break
    }
    case "delete-webhook": {
      const r = await telegramDeleteWebhook()
      out(r); process.exit(r.ok ? 0 : 1); break
    }
    case "webhook-info": {
      const r = await telegramWebhookInfo()
      out(r); process.exit(r.ok ? 0 : 1); break
    }
    case "file": {
      if (!flags["file-id"]) { out({ ok: false, error: "--file-id required" }); process.exit(1) }
      const r = await telegramGetFile({ fileId: flags["file-id"] })
      out(r); process.exit(r.ok ? 0 : 1); break
    }
    case "webhook-url": {
      const publicUrl = flags.url || process.env.KORTIX_PUBLIC_URL || ""
      const projectId = flags["project-id"] || process.env.KORTIX_PROJECT_ID || ""
      if (!publicUrl) { out({ ok: false, error: "--url required" }); process.exit(1) }
      if (!projectId) { out({ ok: false, error: "--project-id required" }); process.exit(1) }
      out({ ok: true, webhook_url: joinUrl(publicUrl, `/v1/webhooks/telegram/${projectId}`) })
      break
    }
    case "help":
    default:
      console.log(`
Telegram Bot API CLI

Auth: reads TELEGRAM_BOT_TOKEN from env (injected via project_secrets).

Commands:

  send            (--chat, [--text|--text-file], [--reply-to], [--file])
  edit            (--chat, --message-id, --text|--text-file)
  delete          (--chat, --message-id)
  typing          (--chat)
  me
  get-chat        (--chat)
  set-webhook     (--url, [--secret])
  delete-webhook
  webhook-info
  file            (--file-id)
  webhook-url     (--url, --project-id)
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
