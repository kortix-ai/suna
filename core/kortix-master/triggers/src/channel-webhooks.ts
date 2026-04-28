/**
 * Channel Webhook Pre-processors — Telegram + Slack
 *
 * Parses platform-specific webhook payloads into normalized events with
 * computed session keys, ready for the trigger dispatch system.
 *
 * No HTTP server logic here — these are pure functions called by the
 * webhook server handlers.
 */
import { createHmac, timingSafeEqual } from "node:crypto"

// ─── Types ───────────────────────────────────────────────────────────────────

export interface NormalizedChannelEvent {
  platform: "telegram" | "slack"
  event_type: string
  user_id: string
  user_name: string
  username: string          // platform handle (e.g. @markokraemer)
  chat_id: string
  text: string
  message_id: string
  thread_ts?: string        // Slack thread timestamp
  is_dm: boolean
  session_key: string       // Computed session reuse key
  prompt: string            // Full prompt text for the agent
  raw: unknown              // Original payload
}

export interface SlackParseResult {
  is_challenge: boolean
  challenge?: string
  dispatch_event?: NormalizedChannelEvent
}

// ─── CLI path helper ─────────────────────────────────────────────────────────

function telegramInstructions(configId: string, chatId: string, messageId?: string, includeTyping?: boolean): string[] {
  const cfg = `--config-id ${configId}`
  return [
    "── Telegram instructions ──",
    "CRITICAL: The user can ONLY see messages you send via ktelegram. Your internal thoughts, tool calls, and session text are INVISIBLE to them. You MUST send every reply, result, and output through ktelegram. If you don't call ktelegram send, the user sees nothing.",
    "",
    `Send text: ktelegram send ${cfg} --chat ${chatId} --text "your reply"`,
    `Complex text (code/backticks): write to /tmp/reply.txt, then: ktelegram send ${cfg} --chat ${chatId} --text-file /tmp/reply.txt`,
    ...(messageId ? [`Quote-reply: ktelegram send ${cfg} --chat ${chatId} --reply-to ${messageId} --text "reply"`] : []),
    `Send file: ktelegram send ${cfg} --chat ${chatId} --file /tmp/example.py --text "caption"`,
    ...(includeTyping ? [`Typing: ktelegram typing ${cfg} --chat ${chatId}`] : []),
    `Edit: ktelegram edit ${cfg} --chat ${chatId} --message-id <ID> --text "new"`,
    `Delete: ktelegram delete ${cfg} --chat ${chatId} --message-id <ID>`,
    "",
    "Rules:",
    "- EVERY response must be sent via ktelegram send. No exceptions.",
    "- When delegating to workers, ALWAYS use async: true. Immediately acknowledge to the user via ktelegram send (e.g. 'Working on it...'), then send the result when the worker completes.",
    "- NEVER block silently. The user sees nothing until you call ktelegram send.",
    "- Code/files: write to /tmp/ and attach via --file. NEVER paste file contents into text.",
    "- Use --text-file for anything with backticks, quotes, or code blocks.",
    "- Do NOT use the question or show tools — they don't render in Telegram.",
    "- Do NOT send localhost URLs — screenshot and send via --file instead.",
    "- Voice messages: /workspace/telegram-files/. Transcribe with kwhisper --file <path>",
    "- Images arrive as files. Use Read tool to view them.",
    "- Bridge commands (/new /reset /status /help /model /agent) are handled automatically, not by you.",
    "- Keep replies concise. Short paragraphs, no walls of text.",
  ]
}

function slackInstructions(configId: string, channel: string, threadTs?: string, includeHistory?: boolean): string[] {
  const cfg = `--config-id ${configId}`
  const threadArg = threadTs ? ` --thread ${threadTs}` : ""
  return [
    "── Slack instructions ──",
    "CRITICAL: The user can ONLY see messages you send via kslack. Your internal thoughts, tool calls, and session text are INVISIBLE to them. You MUST send every reply, result, and output through kslack. If you don't call kslack send, the user sees nothing.",
    "",
    `Send text: kslack send ${cfg} --channel ${channel}${threadArg} --text "your reply"`,
    `Complex text (code/backticks): write to /tmp/reply.txt, then: kslack send ${cfg} --channel ${channel}${threadArg} --text-file /tmp/reply.txt`,
    `Send file: kslack send ${cfg} --channel ${channel}${threadArg} --file /tmp/example.py --text "caption"`,
    `React: kslack react ${cfg} --channel ${channel} --ts <MSG_TS> --emoji thumbsup`,
    ...(includeHistory && threadTs ? [`Thread history: kslack thread ${cfg} --channel ${channel} --ts ${threadTs}`] : []),
    `Edit: kslack edit ${cfg} --channel ${channel} --ts <TS> --text "updated"`,
    `Join channel: kslack join ${cfg} --channel <CHANNEL_ID>`,
    "",
    "Slack mrkdwn (NOT Markdown):",
    "- Bold: *bold* (NOT **bold**) | Italic: _italic_ | Strike: ~strike~",
    "- Links: <https://url|text> (NOT [text](url)) | No # headers",
    "",
    "Rules:",
    "- EVERY response must be sent via kslack send. No exceptions.",
    "- When delegating to workers, ALWAYS use async: true. Immediately acknowledge to the user via kslack send (e.g. 'On it...'), then send the result when the worker completes.",
    "- NEVER block silently. The user sees nothing until you call kslack send.",
    "- ALWAYS reply in thread. Never post top-level.",
    "- Code/files: write to /tmp/ and attach via --file. NEVER paste file contents into text.",
    "- Use --text-file for anything with backticks, quotes, or code blocks.",
    "- Do NOT use the question or show tools — they don't render in Slack.",
    "- Do NOT send localhost URLs. Screenshot and send via --file instead.",
    "- If bot gets 'not_in_channel', use kslack join first, then retry.",
    "- Files from users: /workspace/slack-files/. Transcribe audio with kwhisper --file <path>",
    "- Bridge commands (!new !reset !status !help !model !agent) are handled automatically, not by you.",
    "- Keep replies concise and channel-appropriate.",
  ]
}

// ─── Telegram ────────────────────────────────────────────────────────────────

export function parseTelegramUpdate(update: any, configId: string): NormalizedChannelEvent | null {
  if (!update || typeof update !== "object") return null

  // ── Standard message ──
  if (update.message) {
    const msg = update.message
    const from = msg.from ?? {}
    const chat = msg.chat ?? {}
    const isDm = chat.type === "private"
    const userId = String(from.id ?? "")
    const chatId = String(chat.id ?? "")

    // Build text: regular text, photo caption, or document indicator
    let text = msg.text ?? ""
    if (msg.photo && msg.caption) text = `[photo] ${msg.caption}`
    else if (msg.photo) text = "[photo received]"
    if (msg.document) text = text ? `[document: ${msg.document.file_name ?? "file"}] ${text}` : `[document: ${msg.document.file_name ?? "file"}]`
    if (msg.voice) text = text || "[voice message]"
    if (msg.sticker) text = text || `[sticker: ${msg.sticker.emoji ?? ""}]`

    const sessionKey = isDm
      ? `telegram:${configId}:user:${userId}`
      : `telegram:${configId}:chat:${chatId}`

    const prompt = buildTelegramPrompt("message", from, chat, chatId, text, String(msg.message_id), isDm, configId)

    return {
      platform: "telegram",
      event_type: "message",
      user_id: userId,
      user_name: from.first_name ?? "",
      username: from.username ?? "",
      chat_id: chatId,
      text,
      message_id: String(msg.message_id),
      is_dm: isDm,
      session_key: sessionKey,
      prompt,
      raw: update,
    }
  }

  // ── Edited message ──
  if (update.edited_message) {
    const msg = update.edited_message
    const from = msg.from ?? {}
    const chat = msg.chat ?? {}
    const isDm = chat.type === "private"
    const userId = String(from.id ?? "")
    const chatId = String(chat.id ?? "")
    const text = msg.text ?? ""

    const sessionKey = isDm
      ? `telegram:${configId}:user:${userId}`
      : `telegram:${configId}:chat:${chatId}`

    const prompt = buildTelegramPrompt("edited_message", from, chat, chatId, text, String(msg.message_id), isDm, configId)

    return {
      platform: "telegram",
      event_type: "edited_message",
      user_id: userId,
      user_name: from.first_name ?? "",
      username: from.username ?? "",
      chat_id: chatId,
      text,
      message_id: String(msg.message_id),
      is_dm: isDm,
      session_key: sessionKey,
      prompt,
      raw: update,
    }
  }

  // ── Message reaction ──
  if (update.message_reaction) {
    const r = update.message_reaction
    const user = r.user ?? {}
    const chat = r.chat ?? {}
    const isDm = chat.type === "private"
    const userId = String(user.id ?? "")
    const chatId = String(chat.id ?? "")
    const newReactions = (r.new_reaction ?? []).map((x: any) => x.emoji ?? x.type).join(", ")
    const text = `[reaction: ${newReactions}]`

    const sessionKey = isDm
      ? `telegram:${configId}:user:${userId}`
      : `telegram:${configId}:chat:${chatId}`

    const prompt = buildTelegramPrompt("message_reaction", user, chat, chatId, text, String(r.message_id), isDm, configId)

    return {
      platform: "telegram",
      event_type: "message_reaction",
      user_id: userId,
      user_name: user.first_name ?? "",
      username: user.username ?? "",
      chat_id: chatId,
      text,
      message_id: String(r.message_id),
      is_dm: isDm,
      session_key: sessionKey,
      prompt,
      raw: update,
    }
  }

  // ── Callback query (inline button) ──
  if (update.callback_query) {
    const cb = update.callback_query
    const from = cb.from ?? {}
    const chat = cb.message?.chat ?? {}
    const isDm = chat.type === "private"
    const userId = String(from.id ?? "")
    const chatId = String(chat.id ?? "")
    const text = `[callback: ${cb.data ?? ""}]`

    const sessionKey = isDm
      ? `telegram:${configId}:user:${userId}`
      : `telegram:${configId}:chat:${chatId}`

    const prompt = buildTelegramPrompt("callback_query", from, chat, chatId, text, String(cb.message?.message_id ?? ""), isDm, configId)

    return {
      platform: "telegram",
      event_type: "callback_query",
      user_id: userId,
      user_name: from.first_name ?? "",
      username: from.username ?? "",
      chat_id: chatId,
      text,
      message_id: String(cb.message?.message_id ?? ""),
      is_dm: isDm,
      session_key: sessionKey,
      prompt,
      raw: update,
    }
  }

  // ── Bot added/removed from chat ──
  if (update.my_chat_member) {
    const m = update.my_chat_member
    const from = m.from ?? {}
    const chat = m.chat ?? {}
    const isDm = chat.type === "private"
    const userId = String(from.id ?? "")
    const chatId = String(chat.id ?? "")
    const newStatus = m.new_chat_member?.status ?? "unknown"
    const text = `[bot status changed to: ${newStatus}]`

    const sessionKey = isDm
      ? `telegram:${configId}:user:${userId}`
      : `telegram:${configId}:chat:${chatId}`

    const prompt = buildTelegramPrompt("my_chat_member", from, chat, chatId, text, "", isDm, configId)

    return {
      platform: "telegram",
      event_type: "my_chat_member",
      user_id: userId,
      user_name: from.first_name ?? "",
      username: from.username ?? "",
      chat_id: chatId,
      text,
      message_id: "",
      is_dm: isDm,
      session_key: sessionKey,
      prompt,
      raw: update,
    }
  }

  // Unrecognized update type
  return null
}

function buildTelegramPrompt(
  eventType: string, from: any, chat: any, chatId: string,
  text: string, messageId: string, isDm: boolean, configId: string,
): string {
  const userName = from.first_name ?? "Unknown"
  const handle = from.username ? ` (@${from.username})` : ""
  const chatLabel = isDm ? "DM" : (chat.title ?? `chat ${chatId}`)
  const lines = [
    `[Telegram · ${chatLabel} · ${eventType} from ${userName}${handle}]`,
    text,
    "",
    `Chat ID: ${chatId}${messageId ? ` | Message ID: ${messageId}` : ""}`,
    ...telegramInstructions(configId, chatId, messageId, !isDm),
  ]

  return lines.join("\n")
}

// ─── Slack ───────────────────────────────────────────────────────────────────

export function parseSlackEvent(payload: any, configId: string, botUserId: string): SlackParseResult {
  if (!payload || typeof payload !== "object") {
    return { is_challenge: false }
  }

  // Challenge verification (one-time setup)
  if (payload.type === "url_verification") {
    return { is_challenge: true, challenge: payload.challenge }
  }

  if (payload.type !== "event_callback" || !payload.event) {
    return { is_challenge: false }
  }

  const event = payload.event
  const eventType = event.type
  const eventId = payload.event_id

  // ── Bot's own messages → skip (prevents feedback loops) ──
  if (event.bot_id || event.bot_profile) {
    return { is_challenge: false }
  }
  // file_shared and some other events use user_id instead of bot_id
  const eventUserId = event.user_id || event.user || ""
  if (botUserId && eventUserId === botUserId) {
    return { is_challenge: false }
  }

  // ── app_mention ──
  if (eventType === "app_mention") {
    const userId = event.user ?? ""
    const channel = event.channel ?? ""
    const rawText = event.text ?? ""
    // Strip bot mention: "<@U0LAN0Z89> hey" → "hey"
    const text = rawText.replace(new RegExp(`<@${botUserId}>\\s*`, "g"), "").trim()
    const threadTs = event.thread_ts || event.event_ts || event.ts
    const eventTs = event.event_ts || event.ts

    const sessionKey = `slack:${configId}:thread:${channel}:${threadTs}`

    const prompt = [
      `[Slack · #channel · @mention from ${userId}]`,
      `Message: ${text}`,
      "",
      `Channel: ${channel} | Thread: ${threadTs}`,
      ...slackInstructions(configId, channel, threadTs, true),
    ].join("\n")

    return {
      is_challenge: false,
      dispatch_event: {
        platform: "slack",
        event_type: "app_mention",
        user_id: userId,
        user_name: userId,
        username: userId,
        chat_id: channel,
        text,
        message_id: eventTs,
        thread_ts: threadTs,
        is_dm: false,
        session_key: sessionKey,
        prompt,
        raw: payload,
      },
    }
  }

  // ── message (DM or channel) ──
  if (eventType === "message") {
    const subtype = event.subtype

    // ── message_changed ──
    if (subtype === "message_changed") {
      const channel = event.channel ?? ""
      const newText = event.message?.text ?? ""
      const oldText = event.previous_message?.text ?? ""
      const userId = event.message?.user ?? ""
      const ts = event.message?.ts ?? event.ts

      const sessionKey = `slack:${configId}:thread:${channel}:${ts}`
      const prompt = [
        `[Slack · message edited by ${userId}]`,
        `Old: ${oldText}`,
        `New: ${newText}`,
        `Channel: ${channel} | TS: ${ts}`,
      ].join("\n")

      return {
        is_challenge: false,
        dispatch_event: {
          platform: "slack",
          event_type: "message_changed",
          user_id: userId,
          user_name: userId,
          username: userId,
          chat_id: channel,
          text: newText,
          message_id: ts,
          is_dm: false,
          session_key: sessionKey,
          prompt,
          raw: payload,
        },
      }
    }

    // ── message_deleted ──
    if (subtype === "message_deleted") {
      const channel = event.channel ?? ""
      const deletedTs = event.deleted_ts ?? ""
      const prevText = event.previous_message?.text ?? ""
      const userId = event.previous_message?.user ?? ""

      const sessionKey = `slack:${configId}:thread:${channel}:${deletedTs}`
      const prompt = [
        `[Slack · message deleted]`,
        `Deleted: "${prevText}"`,
        `Channel: ${channel} | Deleted TS: ${deletedTs}`,
      ].join("\n")

      return {
        is_challenge: false,
        dispatch_event: {
          platform: "slack",
          event_type: "message_deleted",
          user_id: userId,
          user_name: userId,
          username: userId,
          chat_id: channel,
          text: prevText,
          message_id: deletedTs,
          is_dm: false,
          session_key: sessionKey,
          prompt,
          raw: payload,
        },
      }
    }

    // ── Skip other subtypes (channel_join, channel_leave, etc.) ──
    if (subtype && subtype !== "file_share") {
      return { is_challenge: false }
    }

    // ── Regular message (DM or channel) ──
    const userId = event.user ?? ""
    const channel = event.channel ?? ""
    const rawText = event.text ?? ""
    const isDm = event.channel_type === "im"
    const threadTs = event.thread_ts || event.event_ts || event.ts

    // Channel-message subscriptions (`message.channels` / `message.groups`)
    // fire on EVERY message, not just bot mentions — this is how Slack
    // delivers thread replies that @-mention the bot, since `app_mention`
    // only fires for top-level mentions. Without an @-mention filter here
    // the bot would respond to every message in the channel. So: in
    // non-DM channels, dispatch ONLY if the bot's user ID is @-mentioned
    // in the text. DMs always dispatch (the user IS talking to the bot).
    if (!isDm) {
      if (!botUserId) return { is_challenge: false }
      if (!rawText.includes(`<@${botUserId}>`)) return { is_challenge: false }
    }

    // Strip the @-mention so the agent gets the clean message body.
    const text = botUserId
      ? rawText.replace(new RegExp(`<@${botUserId}>\\s*`, "g"), "").trim()
      : rawText

    const sessionKey = isDm
      ? `slack:${configId}:dm:${userId}`
      : `slack:${configId}:thread:${channel}:${threadTs}`

      const prompt = isDm
      ? [
          `[Slack · DM from ${userId}]`,
          `Message: ${text}`,
          "",
          `Channel: ${channel}`,
          ...slackInstructions(configId, channel),
        ].join("\n")
      : [
          `[Slack · channel message from ${userId}]`,
          `Message: ${text}`,
          "",
          `Channel: ${channel} | Thread: ${threadTs}`,
          ...slackInstructions(configId, channel, threadTs),
        ].join("\n")

    return {
      is_challenge: false,
      dispatch_event: {
        platform: "slack",
        event_type: "message",
        user_id: userId,
        user_name: userId,
        username: userId,
        chat_id: channel,
        text,
        message_id: event.event_ts || event.ts,
        thread_ts: threadTs,
        is_dm: isDm,
        session_key: sessionKey,
        prompt,
        raw: payload,
      },
    }
  }

  // ── reaction_added ──
  if (eventType === "reaction_added") {
    const userId = event.user ?? ""
    const reaction = event.reaction ?? ""
    const channel = event.item?.channel ?? ""
    const ts = event.item?.ts ?? ""

    const sessionKey = `slack:${configId}:thread:${channel}:${ts}`
    const prompt = [
      `[Slack · reaction from ${userId}]`,
      `Reaction: :${reaction}: added to message`,
      `Channel: ${channel} | Message TS: ${ts}`,
    ].join("\n")

    return {
      is_challenge: false,
      dispatch_event: {
        platform: "slack",
        event_type: "reaction_added",
        user_id: userId,
        user_name: userId,
        username: userId,
        chat_id: channel,
        text: `[reaction: :${reaction}:]`,
        message_id: ts,
        is_dm: false,
        session_key: sessionKey,
        prompt,
        raw: payload,
      },
    }
  }

  // ── reaction_removed ──
  if (eventType === "reaction_removed") {
    const userId = event.user ?? ""
    const reaction = event.reaction ?? ""
    const channel = event.item?.channel ?? ""
    const ts = event.item?.ts ?? ""

    const sessionKey = `slack:${configId}:thread:${channel}:${ts}`
    const prompt = [
      `[Slack · reaction removed by ${userId}]`,
      `Reaction: :${reaction}: removed`,
      `Channel: ${channel} | Message TS: ${ts}`,
    ].join("\n")

    return {
      is_challenge: false,
      dispatch_event: {
        platform: "slack",
        event_type: "reaction_removed",
        user_id: userId,
        user_name: userId,
        username: userId,
        chat_id: channel,
        text: `[reaction removed: :${reaction}:]`,
        message_id: ts,
        is_dm: false,
        session_key: sessionKey,
        prompt,
        raw: payload,
      },
    }
  }

  // ── member_joined_channel ──
  if (eventType === "member_joined_channel") {
    const userId = event.user ?? ""
    const channel = event.channel ?? ""

    const sessionKey = `slack:${configId}:thread:${channel}:joined_${userId}`
    const prompt = [
      `[Slack · ${userId} joined channel]`,
      `Channel: ${channel}`,
    ].join("\n")

    return {
      is_challenge: false,
      dispatch_event: {
        platform: "slack",
        event_type: "member_joined_channel",
        user_id: userId,
        user_name: userId,
        username: userId,
        chat_id: channel,
        text: `[member joined]`,
        message_id: event.event_ts ?? "",
        is_dm: false,
        session_key: sessionKey,
        prompt,
        raw: payload,
      },
    }
  }

  // ── file_shared ──
  if (eventType === "file_shared") {
    const userId = event.user_id ?? ""
    const channel = event.channel_id ?? ""
    const file = event.file ?? {}
    const fileName = file.name ?? event.file_id ?? "unknown"

    const sessionKey = `slack:${configId}:thread:${channel}:file_${event.file_id}`
    const prompt = [
      `[Slack · file shared by ${userId}]`,
      `File: ${fileName} (${file.filetype ?? "unknown"}, ${file.size ?? "?"} bytes)`,
      `Channel: ${channel}`,
      file.url_private ? `URL: ${file.url_private}` : "",
    ].filter(Boolean).join("\n")

    return {
      is_challenge: false,
      dispatch_event: {
        platform: "slack",
        event_type: "file_shared",
        user_id: userId,
        user_name: userId,
        username: userId,
        chat_id: channel,
        text: `[file: ${fileName}]`,
        message_id: event.event_ts ?? "",
        is_dm: false,
        session_key: sessionKey,
        prompt,
        raw: payload,
      },
    }
  }

  // Unrecognized event type
  return { is_challenge: false }
}

// ─── Slack Signature Verification ────────────────────────────────────────────

export function verifySlackSignature(
  body: string,
  timestamp: string,
  signature: string,
  signingSecret: string,
): boolean {
  // Reject if timestamp is >5 minutes old (replay protection)
  const now = Math.floor(Date.now() / 1000)
  const ts = parseInt(timestamp, 10)
  if (isNaN(ts) || Math.abs(now - ts) > 300) return false

  const sigBasestring = `v0:${timestamp}:${body}`
  const computed = "v0=" + createHmac("sha256", signingSecret).update(sigBasestring).digest("hex")

  // Timing-safe comparison
  try {
    return timingSafeEqual(Buffer.from(computed), Buffer.from(signature))
  } catch {
    return false
  }
}
