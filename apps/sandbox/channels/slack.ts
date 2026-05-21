#!/usr/bin/env bun
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs"

function getToken(): string | undefined {
  return process.env.SLACK_BOT_TOKEN
}

function slackApiBase(): string {
  return (process.env.SLACK_API_URL || "https://slack.com/api").replace(/\/$/, "")
}

function joinUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl)
  const suffix = path.startsWith("/") ? path : `/${path}`
  const basePath = base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname
  const joined = new URL(`${basePath}${suffix}`, base.origin)
  for (const [k, v] of base.searchParams) joined.searchParams.set(k, v)
  return joined.toString()
}

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

async function slackSend(opts: { channel: string; text?: string; threadTs?: string; file?: string }): Promise<any> {
  const token = getToken()
  if (!token) return { ok: false, error: "SLACK_BOT_TOKEN not set" }

  if (opts.file) {
    if (!existsSync(opts.file)) return { ok: false, error: `File not found: ${opts.file}` }
    const fileData = readFileSync(opts.file)
    const fileName = opts.file.split("/").pop() || "file"

    const getUrlRes = (await fetch(`${slackApiBase()}/files.getUploadURLExternal`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ filename: fileName, length: String(fileData.length) }),
      signal: AbortSignal.timeout(15_000),
    }).then((r) => r.json())) as any
    if (!getUrlRes.ok) return { ok: false, error: getUrlRes.error ?? "getUploadURL failed" }

    const uploadRes = await fetch(getUrlRes.upload_url, {
      method: "POST",
      body: fileData,
      signal: AbortSignal.timeout(60_000),
    })
    if (!uploadRes.ok) return { ok: false, error: `Upload failed: ${uploadRes.status}` }

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

  if (!opts.text) return { ok: false, error: "Either --text or --file required" }
  const body: Record<string, unknown> = { channel: opts.channel, text: opts.text, mrkdwn: true }
  if (opts.threadTs) body.thread_ts = opts.threadTs
  const data = await apiPost("chat.postMessage", body)
  if (!data.ok) return { ok: false, error: data.error ?? "send failed" }
  return { ok: true, ts: data.ts, channel: data.channel }
}

async function slackEdit(opts: { channel: string; ts: string; text: string }): Promise<any> {
  const data = await apiPost("chat.update", { channel: opts.channel, ts: opts.ts, text: opts.text })
  if (!data.ok) return { ok: false, error: data.error ?? "edit failed" }
  return { ok: true, ts: data.ts, channel: data.channel }
}

async function slackDelete(opts: { channel: string; ts: string }): Promise<any> {
  const data = await apiPost("chat.delete", { channel: opts.channel, ts: opts.ts })
  if (!data.ok) return { ok: false, error: data.error ?? "delete failed" }
  return { ok: true }
}

async function slackReact(opts: { channel: string; ts: string; emoji: string }): Promise<any> {
  const data = await apiPost("reactions.add", { channel: opts.channel, timestamp: opts.ts, name: opts.emoji })
  if (!data.ok) return { ok: false, error: data.error ?? "react failed" }
  return { ok: true }
}

async function slackHistory(opts: { channel: string; limit?: number }): Promise<any> {
  const data = await apiGet("conversations.history", { channel: opts.channel, limit: String(opts.limit ?? 20) })
  if (!data.ok) return { ok: false, error: data.error ?? "history failed" }
  return { ok: true, messages: data.messages }
}

async function slackThread(opts: { channel: string; ts: string; limit?: number }): Promise<any> {
  const data = await apiGet("conversations.replies", {
    channel: opts.channel, ts: opts.ts, limit: String(opts.limit ?? 20),
  })
  if (!data.ok) return { ok: false, error: data.error ?? "thread failed" }
  return { ok: true, messages: data.messages }
}

async function slackChannels(opts: { limit?: number }): Promise<any> {
  const data = await apiGet("conversations.list", {
    limit: String(opts.limit ?? 100),
    types: "public_channel,private_channel",
    exclude_archived: "true",
  })
  if (!data.ok) return { ok: false, error: data.error ?? "channels failed" }
  return { ok: true, channels: data.channels }
}

async function slackChannelInfo(opts: { channel: string }): Promise<any> {
  const data = await apiGet("conversations.info", { channel: opts.channel })
  if (!data.ok) return { ok: false, error: data.error ?? "channel info failed" }
  return { ok: true, channel: data.channel }
}

async function slackJoin(opts: { channel: string }): Promise<any> {
  const data = await apiPost("conversations.join", { channel: opts.channel })
  if (!data.ok) return { ok: false, error: data.error ?? "join failed" }
  return { ok: true, channel: data.channel }
}

async function slackUsers(opts: { limit?: number }): Promise<any> {
  const data = await apiGet("users.list", { limit: String(opts.limit ?? 100) })
  if (!data.ok) return { ok: false, error: data.error ?? "users failed" }
  return { ok: true, members: data.members }
}

async function slackUser(opts: { id: string }): Promise<any> {
  const data = await apiGet("users.info", { user: opts.id })
  if (!data.ok) return { ok: false, error: data.error ?? "user failed" }
  return { ok: true, user: data.user }
}

async function slackMe(): Promise<any> {
  const data = await apiPost("auth.test", {})
  if (!data.ok) return { ok: false, error: data.error ?? "auth.test failed" }
  return {
    ok: true,
    user_id: data.user_id,
    user: data.user,
    team: data.team,
    team_id: data.team_id,
    bot_id: data.bot_id,
  }
}

async function slackSearch(opts: { query: string }): Promise<any> {
  const data = await apiGet("search.messages", { query: opts.query })
  if (!data.ok) return { ok: false, error: data.error ?? "search failed" }
  return { ok: true, messages: data.messages }
}

async function slackFileInfo(opts: { fileId: string }): Promise<any> {
  const data = await apiGet("files.info", { file: opts.fileId })
  if (!data.ok) return { ok: false, error: data.error ?? "file info failed" }
  return { ok: true, file: data.file }
}

async function slackDownload(opts: { url: string; out: string }): Promise<any> {
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
      if (!flags.channel) { out({ ok: false, error: "--channel required" }); process.exit(1) }
      let text = flags.text
      if (flags["text-file"]) {
        try { text = readFileSync(flags["text-file"], "utf-8") }
        catch { out({ ok: false, error: `Cannot read --text-file: ${flags["text-file"]}` }); process.exit(1) }
      }
      if (!text && !flags.file) { out({ ok: false, error: "--text, --text-file, and/or --file required" }); process.exit(1) }
      const r = await slackSend({ channel: flags.channel, text, threadTs: flags.thread, file: flags.file })
      out(r); process.exit(r.ok ? 0 : 1); break
    }
    case "edit": {
      let editText = flags.text
      if (flags["text-file"]) {
        try { editText = readFileSync(flags["text-file"], "utf-8") }
        catch { out({ ok: false, error: `Cannot read --text-file` }); process.exit(1) }
      }
      if (!flags.channel || !flags.ts || !editText) {
        out({ ok: false, error: "--channel, --ts, --text (or --text-file) required" }); process.exit(1)
      }
      const r = await slackEdit({ channel: flags.channel, ts: flags.ts, text: editText })
      out(r); process.exit(r.ok ? 0 : 1); break
    }
    case "delete": {
      if (!flags.channel || !flags.ts) { out({ ok: false, error: "--channel and --ts required" }); process.exit(1) }
      const r = await slackDelete({ channel: flags.channel, ts: flags.ts })
      out(r); process.exit(r.ok ? 0 : 1); break
    }
    case "react": {
      if (!flags.channel || !flags.ts || !flags.emoji) {
        out({ ok: false, error: "--channel, --ts, --emoji required" }); process.exit(1)
      }
      const r = await slackReact({ channel: flags.channel, ts: flags.ts, emoji: flags.emoji })
      out(r); process.exit(r.ok ? 0 : 1); break
    }
    case "typing": {
      if (!flags.channel) { out({ ok: false, error: "--channel required" }); process.exit(1) }
      out({ ok: true, note: "Slack Web API does not support typing indicators for bots" }); break
    }
    case "history": {
      if (!flags.channel) { out({ ok: false, error: "--channel required" }); process.exit(1) }
      const r = await slackHistory({ channel: flags.channel, limit: flags.limit ? parseInt(flags.limit, 10) : undefined })
      out(r); process.exit(r.ok ? 0 : 1); break
    }
    case "thread": {
      if (!flags.channel || !flags.ts) { out({ ok: false, error: "--channel and --ts required" }); process.exit(1) }
      const r = await slackThread({ channel: flags.channel, ts: flags.ts, limit: flags.limit ? parseInt(flags.limit, 10) : undefined })
      out(r); process.exit(r.ok ? 0 : 1); break
    }
    case "channels": {
      const r = await slackChannels({ limit: flags.limit ? parseInt(flags.limit, 10) : undefined })
      out(r); process.exit(r.ok ? 0 : 1); break
    }
    case "channel-info": {
      if (!flags.channel) { out({ ok: false, error: "--channel required" }); process.exit(1) }
      const r = await slackChannelInfo({ channel: flags.channel })
      out(r); process.exit(r.ok ? 0 : 1); break
    }
    case "join": {
      if (!flags.channel) { out({ ok: false, error: "--channel required" }); process.exit(1) }
      const r = await slackJoin({ channel: flags.channel })
      out(r); process.exit(r.ok ? 0 : 1); break
    }
    case "users": {
      const r = await slackUsers({ limit: flags.limit ? parseInt(flags.limit, 10) : undefined })
      out(r); process.exit(r.ok ? 0 : 1); break
    }
    case "user": {
      if (!flags.id) { out({ ok: false, error: "--id required" }); process.exit(1) }
      const r = await slackUser({ id: flags.id })
      out(r); process.exit(r.ok ? 0 : 1); break
    }
    case "me": {
      const r = await slackMe()
      out(r); process.exit(r.ok ? 0 : 1); break
    }
    case "search": {
      if (!flags.query) { out({ ok: false, error: "--query required" }); process.exit(1) }
      const r = await slackSearch({ query: flags.query })
      out(r); process.exit(r.ok ? 0 : 1); break
    }
    case "file-info": {
      if (!flags.file) { out({ ok: false, error: "--file required (file ID)" }); process.exit(1) }
      const r = await slackFileInfo({ fileId: flags.file })
      out(r); process.exit(r.ok ? 0 : 1); break
    }
    case "download": {
      if (!flags.url || !flags.out) { out({ ok: false, error: "--url and --out required" }); process.exit(1) }
      const r = await slackDownload({ url: flags.url, out: flags.out })
      out(r); process.exit(r.ok ? 0 : 1); break
    }
    case "manifest": {
      const publicUrl = flags.url || process.env.KORTIX_PUBLIC_URL || ""
      const projectId = flags["project-id"] || process.env.KORTIX_PROJECT_ID || ""
      if (!publicUrl) { out({ ok: false, error: "--url required (your public Kortix API URL)" }); process.exit(1) }
      if (!projectId) { out({ ok: false, error: "--project-id required" }); process.exit(1) }

      const requestUrl = joinUrl(publicUrl, `/v1/webhooks/slack/${projectId}`)
      const names = ["Atlas","Nova","Sage","Echo","Bolt","Iris","Dash","Cleo","Finn","Luna","Juno","Axel","Niko","Zara","Milo","Ruby","Hugo","Aria","Leo","Ivy"]
      const manifest = {
        display_information: {
          name: flags.name || `Kortix ${names[Math.floor(Math.random() * names.length)]}`,
          description: "Kortix project bot",
          background_color: "#0a0a0a",
        },
        features: { bot_user: { display_name: flags.name || "kortix", always_online: true } },
        oauth_config: {
          scopes: {
            bot: [
              "app_mentions:read", "channels:history", "channels:read", "channels:join",
              "chat:write", "chat:write.public", "files:read", "files:write",
              "groups:history", "groups:read", "im:history", "im:read", "im:write",
              "mpim:history", "mpim:read", "reactions:read", "reactions:write", "users:read",
            ],
          },
        },
        settings: {
          event_subscriptions: {
            request_url: requestUrl,
            bot_events: [
              "app_mention", "message.im", "message.channels", "message.groups", "message.mpim",
              "reaction_added", "reaction_removed", "member_joined_channel", "file_shared",
            ],
          },
          org_deploy_enabled: false,
          socket_mode_enabled: false,
          token_rotation_enabled: false,
        },
      }
      out({ ok: true, manifest, webhook_url: requestUrl })
      break
    }
    case "help":
    default:
      console.log(`
Slack Web API CLI

Auth: reads SLACK_BOT_TOKEN from env (injected via project_secrets).

Commands:

  send         (--channel, [--text|--text-file], [--thread], [--file])
  edit         (--channel, --ts, --text|--text-file)
  delete       (--channel, --ts)
  react        (--channel, --ts, --emoji)
  typing       (--channel)               # no-op on Slack Web API
  history      (--channel, [--limit])
  thread       (--channel, --ts, [--limit])
  channels     ([--limit])
  channel-info (--channel)
  join         (--channel)
  users        ([--limit])
  user         (--id)
  me
  search       (--query)
  file-info    (--file <id>)
  download     (--url, --out)
  manifest     (--url, --project-id, [--name])
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
