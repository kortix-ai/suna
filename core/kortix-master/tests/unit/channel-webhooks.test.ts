/**
 * Unit tests for channel-webhooks.ts — the Telegram + Slack webhook pre-processors.
 *
 * These functions parse platform-specific webhook payloads into normalized messages
 * with computed session keys, ready for the trigger dispatch system.
 *
 * No HTTP, no network — just call the parser functions with fixture payloads.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

// These will be implemented in channel-webhooks.ts
import {
  parseTelegramUpdate,
  parseSlackEvent,
  verifySlackSignature,
  parseWhatsAppWebhook,
  verifyWhatsAppSignature,
  type NormalizedChannelEvent,
} from '../../triggers/src/channel-webhooks'

const FIXTURES = join(import.meta.dir, '../fixtures/channels')
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf-8'))
}

const TEST_CONFIG_ID = 'cfg-test-123'
const TEST_BOT_ID = 'U0LAN0Z89'
const SLACK_SIGNING_SECRET = 'test_signing_secret_abc123'

// ─── Telegram ────────────────────────────────────────────────────────────────

describe('parseTelegramUpdate', () => {
  describe('message parsing', () => {
    it('extracts chat_id, user_id, user_name, text from standard DM', () => {
      const update = fixture('telegram-update-message.json')
      const result = parseTelegramUpdate(update, TEST_CONFIG_ID)
      expect(result).not.toBeNull()
      expect(result!.platform).toBe('telegram')
      expect(result!.user_id).toBe('123456')
      expect(result!.user_name).toBe('Marko')
      expect(result!.username).toBe('markokraemer')
      expect(result!.chat_id).toBe('123456789')
      expect(result!.text).toBe('hey can you check the CI?')
      expect(result!.message_id).toBe('42')
      expect(result!.event_type).toBe('message')
      expect(result!.is_dm).toBe(true)
    })

    it('extracts from group chat message', () => {
      const update = fixture('telegram-update-group.json')
      const result = parseTelegramUpdate(update, TEST_CONFIG_ID)
      expect(result).not.toBeNull()
      expect(result!.user_id).toBe('654321')
      expect(result!.user_name).toBe('Alice')
      expect(result!.chat_id).toBe('-1001234567890')
      expect(result!.is_dm).toBe(false)
      expect(result!.event_type).toBe('message')
    })

    it('extracts from edited_message', () => {
      const update = fixture('telegram-update-edited.json')
      const result = parseTelegramUpdate(update, TEST_CONFIG_ID)
      expect(result).not.toBeNull()
      expect(result!.event_type).toBe('edited_message')
      expect(result!.text).toBe('hey can you check the CI? it\'s urgent')
      expect(result!.user_id).toBe('123456')
    })

    it('extracts from message_reaction', () => {
      const update = fixture('telegram-update-reaction.json')
      const result = parseTelegramUpdate(update, TEST_CONFIG_ID)
      expect(result).not.toBeNull()
      expect(result!.event_type).toBe('message_reaction')
      expect(result!.text).toContain('👍')
      expect(result!.user_id).toBe('123456')
      expect(result!.message_id).toBe('42')
    })

    it('extracts from callback_query', () => {
      const update = fixture('telegram-update-callback.json')
      const result = parseTelegramUpdate(update, TEST_CONFIG_ID)
      expect(result).not.toBeNull()
      expect(result!.event_type).toBe('callback_query')
      expect(result!.text).toContain('approve_deploy')
      expect(result!.user_id).toBe('123456')
    })

    it('extracts from my_chat_member (bot added)', () => {
      const update = fixture('telegram-update-bot-added.json')
      const result = parseTelegramUpdate(update, TEST_CONFIG_ID)
      expect(result).not.toBeNull()
      expect(result!.event_type).toBe('my_chat_member')
      expect(result!.text).toContain('member')
      expect(result!.chat_id).toBe('-1001234567890')
    })

    it('extracts photo file_id and caption', () => {
      const update = fixture('telegram-update-photo.json')
      const result = parseTelegramUpdate(update, TEST_CONFIG_ID)
      expect(result).not.toBeNull()
      expect(result!.event_type).toBe('message')
      expect(result!.text).toContain('screenshot of the error')
      expect(result!.text).toContain('photo')
    })

    it('handles missing username by falling back to first_name', () => {
      const update = {
        update_id: 999,
        message: {
          message_id: 1,
          from: { id: 789, is_bot: false, first_name: 'NoUsername' },
          chat: { id: 789, type: 'private' },
          date: 1712160000,
          text: 'hi',
        },
      }
      const result = parseTelegramUpdate(update, TEST_CONFIG_ID)
      expect(result).not.toBeNull()
      expect(result!.user_name).toBe('NoUsername')
      expect(result!.username).toBe('')
    })

    it('returns null for unrecognized update types', () => {
      const result = parseTelegramUpdate({ update_id: 999 }, TEST_CONFIG_ID)
      expect(result).toBeNull()
    })
  })

  describe('session key', () => {
    it('DM produces "telegram:<config>:user:<user_id>"', () => {
      const update = fixture('telegram-update-message.json')
      const result = parseTelegramUpdate(update, TEST_CONFIG_ID)
      expect(result!.session_key).toBe(`telegram:${TEST_CONFIG_ID}:user:123456`)
    })

    it('Group produces "telegram:<config>:chat:<chat_id>"', () => {
      const update = fixture('telegram-update-group.json')
      const result = parseTelegramUpdate(update, TEST_CONFIG_ID)
      expect(result!.session_key).toBe(`telegram:${TEST_CONFIG_ID}:chat:-1001234567890`)
    })

    it('different users in DMs produce different keys', () => {
      const u1 = fixture('telegram-update-message.json')
      const u2 = {
        update_id: 999,
        message: {
          message_id: 2, from: { id: 999999, first_name: 'Other' },
          chat: { id: 999999, type: 'private' }, date: 1, text: 'x',
        },
      }
      const r1 = parseTelegramUpdate(u1, TEST_CONFIG_ID)
      const r2 = parseTelegramUpdate(u2, TEST_CONFIG_ID)
      expect(r1!.session_key).not.toBe(r2!.session_key)
    })

    it('same user produces same key across messages', () => {
      const u1 = fixture('telegram-update-message.json')
      const u2 = {
        update_id: 100099,
        message: {
          message_id: 99, from: { id: 123456, first_name: 'Marko', username: 'markokraemer' },
          chat: { id: 123456789, type: 'private' }, date: 9999, text: 'another msg',
        },
      }
      const r1 = parseTelegramUpdate(u1, TEST_CONFIG_ID)
      const r2 = parseTelegramUpdate(u2, TEST_CONFIG_ID)
      expect(r1!.session_key).toBe(r2!.session_key)
    })
  })

  describe('prompt building', () => {
    it('includes platform, user info, chat_id, message text', () => {
      const update = fixture('telegram-update-message.json')
      const result = parseTelegramUpdate(update, TEST_CONFIG_ID)
      expect(result!.prompt).toContain('Telegram')
      expect(result!.prompt).toContain('Marko')
      expect(result!.prompt).toContain('markokraemer')
      expect(result!.prompt).toContain('123456789')
      expect(result!.prompt).toContain('hey can you check the CI?')
    })

    it('includes CLI send instructions', () => {
      const update = fixture('telegram-update-message.json')
      const result = parseTelegramUpdate(update, TEST_CONFIG_ID)
      expect(result!.prompt).toContain('telegram.ts')
      expect(result!.prompt).toContain('send')
      expect(result!.prompt).toContain('--chat')
    })

    it('includes event type for non-message updates', () => {
      const update = fixture('telegram-update-reaction.json')
      const result = parseTelegramUpdate(update, TEST_CONFIG_ID)
      expect(result!.prompt).toContain('reaction')
    })
  })
})

// ─── Slack ───────────────────────────────────────────────────────────────────

describe('parseSlackEvent', () => {
  describe('challenge verification', () => {
    it('detects url_verification and returns challenge', () => {
      const event = fixture('slack-challenge.json')
      const result = parseSlackEvent(event, TEST_CONFIG_ID, TEST_BOT_ID)
      expect(result).not.toBeNull()
      expect(result!.is_challenge).toBe(true)
      expect(result!.challenge).toBe('3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P')
    })

    it('does NOT produce a dispatch event for challenges', () => {
      const event = fixture('slack-challenge.json')
      const result = parseSlackEvent(event, TEST_CONFIG_ID, TEST_BOT_ID)
      expect(result!.dispatch_event).toBeUndefined()
    })
  })

  describe('event parsing — app_mention', () => {
    it('extracts channel, user, text, event_ts', () => {
      const event = fixture('slack-event-app-mention.json')
      const result = parseSlackEvent(event, TEST_CONFIG_ID, TEST_BOT_ID)
      expect(result!.is_challenge).toBe(false)
      const ev = result!.dispatch_event!
      expect(ev.platform).toBe('slack')
      expect(ev.event_type).toBe('app_mention')
      expect(ev.user_id).toBe('U061F7AUR')
      expect(ev.chat_id).toBe('C0AG3PJLCHH')
    })

    it('strips bot mention from text', () => {
      const event = fixture('slack-event-app-mention.json')
      const result = parseSlackEvent(event, TEST_CONFIG_ID, TEST_BOT_ID)
      const ev = result!.dispatch_event!
      expect(ev.text).not.toContain(`<@${TEST_BOT_ID}>`)
      expect(ev.text).toContain('can someone review PR #42?')
    })

    it('uses event_ts as thread_ts for top-level mentions (new thread)', () => {
      const event = fixture('slack-event-app-mention.json')
      const result = parseSlackEvent(event, TEST_CONFIG_ID, TEST_BOT_ID)
      const ev = result!.dispatch_event!
      // thread_ts is null in the fixture → should use event_ts
      expect(ev.thread_ts).toBe('1712160000.000100')
    })

    it('preserves thread_ts if already in a thread', () => {
      const event = fixture('slack-event-app-mention-in-thread.json')
      const result = parseSlackEvent(event, TEST_CONFIG_ID, TEST_BOT_ID)
      const ev = result!.dispatch_event!
      expect(ev.thread_ts).toBe('1712160000.000100')
    })
  })

  describe('event parsing — message.im', () => {
    it('extracts channel, user, text for DM', () => {
      const event = fixture('slack-event-message-im.json')
      const result = parseSlackEvent(event, TEST_CONFIG_ID, TEST_BOT_ID)
      const ev = result!.dispatch_event!
      expect(ev.event_type).toBe('message')
      expect(ev.user_id).toBe('U061F7AUR')
      expect(ev.chat_id).toBe('D0CHZQWNP')
      expect(ev.text).toBe('hey, can you deploy staging?')
      expect(ev.is_dm).toBe(true)
    })

    it('ignores bot messages (bot_id present)', () => {
      const event = fixture('slack-event-bot-message.json')
      const result = parseSlackEvent(event, TEST_CONFIG_ID, TEST_BOT_ID)
      expect(result!.dispatch_event).toBeUndefined()
    })
  })

  describe('event parsing — reaction_added', () => {
    it('extracts reaction emoji, user, channel, ts', () => {
      const event = fixture('slack-event-reaction-added.json')
      const result = parseSlackEvent(event, TEST_CONFIG_ID, TEST_BOT_ID)
      const ev = result!.dispatch_event!
      expect(ev.event_type).toBe('reaction_added')
      expect(ev.text).toContain('eyes')
      expect(ev.user_id).toBe('U061F7AUR')
      expect(ev.chat_id).toBe('C0AG3PJLCHH')
    })
  })

  describe('event parsing — reaction_removed', () => {
    it('extracts reaction removal info', () => {
      const event = fixture('slack-event-reaction-removed.json')
      const result = parseSlackEvent(event, TEST_CONFIG_ID, TEST_BOT_ID)
      const ev = result!.dispatch_event!
      expect(ev.event_type).toBe('reaction_removed')
      expect(ev.text).toContain('eyes')
    })
  })

  describe('event parsing — message_changed', () => {
    it('extracts old and new text', () => {
      const event = fixture('slack-event-message-changed.json')
      const result = parseSlackEvent(event, TEST_CONFIG_ID, TEST_BOT_ID)
      const ev = result!.dispatch_event!
      expect(ev.event_type).toBe('message_changed')
      expect(ev.text).toContain('it\'s urgent')
      expect(ev.prompt).toContain('can someone review PR #42?')
    })
  })

  describe('event parsing — message_deleted', () => {
    it('extracts deleted message info', () => {
      const event = fixture('slack-event-message-deleted.json')
      const result = parseSlackEvent(event, TEST_CONFIG_ID, TEST_BOT_ID)
      const ev = result!.dispatch_event!
      expect(ev.event_type).toBe('message_deleted')
      expect(ev.chat_id).toBe('C0AG3PJLCHH')
    })
  })

  describe('event parsing — member_joined_channel', () => {
    it('extracts user and channel', () => {
      const event = fixture('slack-event-member-joined.json')
      const result = parseSlackEvent(event, TEST_CONFIG_ID, TEST_BOT_ID)
      const ev = result!.dispatch_event!
      expect(ev.event_type).toBe('member_joined_channel')
      expect(ev.user_id).toBe('U061F7AUR')
      expect(ev.chat_id).toBe('C0AG3PJLCHH')
    })
  })

  describe('event parsing — file_shared', () => {
    it('extracts file info', () => {
      const event = fixture('slack-event-file-shared.json')
      const result = parseSlackEvent(event, TEST_CONFIG_ID, TEST_BOT_ID)
      const ev = result!.dispatch_event!
      expect(ev.event_type).toBe('file_shared')
      expect(ev.text).toContain('report.pdf')
      expect(ev.chat_id).toBe('C0AG3PJLCHH')
    })
  })

  describe('session key', () => {
    it('DM produces "slack:<config>:dm:<user_id>"', () => {
      const event = fixture('slack-event-message-im.json')
      const result = parseSlackEvent(event, TEST_CONFIG_ID, TEST_BOT_ID)
      expect(result!.dispatch_event!.session_key).toBe(`slack:${TEST_CONFIG_ID}:dm:U061F7AUR`)
    })

    it('channel thread produces "slack:<config>:thread:<channel>:<thread_ts>"', () => {
      const event = fixture('slack-event-app-mention-in-thread.json')
      const result = parseSlackEvent(event, TEST_CONFIG_ID, TEST_BOT_ID)
      expect(result!.dispatch_event!.session_key).toBe(`slack:${TEST_CONFIG_ID}:thread:C0AG3PJLCHH:1712160000.000100`)
    })

    it('top-level @mention uses event_ts as thread key', () => {
      const event = fixture('slack-event-app-mention.json')
      const result = parseSlackEvent(event, TEST_CONFIG_ID, TEST_BOT_ID)
      expect(result!.dispatch_event!.session_key).toBe(`slack:${TEST_CONFIG_ID}:thread:C0AG3PJLCHH:1712160000.000100`)
    })

    it('reaction in channel uses the reacted message thread', () => {
      const event = fixture('slack-event-reaction-added.json')
      const result = parseSlackEvent(event, TEST_CONFIG_ID, TEST_BOT_ID)
      expect(result!.dispatch_event!.session_key).toContain(`slack:${TEST_CONFIG_ID}:thread:C0AG3PJLCHH`)
    })
  })
})

// ─── Slack Signature Verification ────────────────────────────────────────────

describe('verifySlackSignature', () => {
  it('accepts valid HMAC-SHA256 signature', () => {
    const timestamp = String(Math.floor(Date.now() / 1000)) // current time
    const body = '{"test":"data"}'
    const crypto = require('crypto')
    const sigBasestring = `v0:${timestamp}:${body}`
    const signature = 'v0=' + crypto.createHmac('sha256', SLACK_SIGNING_SECRET)
      .update(sigBasestring).digest('hex')

    const result = verifySlackSignature(body, timestamp, signature, SLACK_SIGNING_SECRET)
    expect(result).toBe(true)
  })

  it('rejects invalid signature', () => {
    const result = verifySlackSignature('body', '123', 'v0=invalid', SLACK_SIGNING_SECRET)
    expect(result).toBe(false)
  })

  it('rejects when timestamp is too old (>5 minutes)', () => {
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 600) // 10 min ago
    const body = '{"test":"data"}'
    const crypto = require('crypto')
    const sig = 'v0=' + crypto.createHmac('sha256', SLACK_SIGNING_SECRET)
      .update(`v0:${oldTimestamp}:${body}`).digest('hex')

    const result = verifySlackSignature(body, oldTimestamp, sig, SLACK_SIGNING_SECRET)
    expect(result).toBe(false)
  })
})

// ─── WhatsApp ──────────────────────────────────────────────────────────────

const TEST_PHONE_NUMBER_ID = '123456789'

describe('parseWhatsAppWebhook', () => {
  describe('text message parsing', () => {
    it('extracts phone, user_name, text from standard message', () => {
      const payload = fixture('whatsapp-message-text.json')
      const result = parseWhatsAppWebhook(payload, TEST_CONFIG_ID, TEST_PHONE_NUMBER_ID)
      expect(result.dispatch_event).not.toBeUndefined()
      const ev = result.dispatch_event!
      expect(ev.platform).toBe('whatsapp')
      expect(ev.user_id).toBe('5511999887766')
      expect(ev.user_name).toBe('Alice')
      expect(ev.chat_id).toBe('5511999887766')
      expect(ev.text).toBe('hey can you check the CI?')
      expect(ev.message_id).toBe('wamid.HBgLNTUxMQ==')
      expect(ev.event_type).toBe('message')
      expect(ev.is_dm).toBe(true)
    })
  })

  describe('media messages', () => {
    it('extracts image with caption', () => {
      const payload = fixture('whatsapp-message-image.json')
      const result = parseWhatsAppWebhook(payload, TEST_CONFIG_ID, TEST_PHONE_NUMBER_ID)
      const ev = result.dispatch_event!
      expect(ev.text).toContain('image')
      expect(ev.text).toContain('screenshot of the error')
    })

    it('extracts document filename', () => {
      const payload = fixture('whatsapp-message-document.json')
      const result = parseWhatsAppWebhook(payload, TEST_CONFIG_ID, TEST_PHONE_NUMBER_ID)
      const ev = result.dispatch_event!
      expect(ev.text).toContain('document')
      expect(ev.text).toContain('report.pdf')
    })

    it('extracts reaction emoji', () => {
      const payload = fixture('whatsapp-message-reaction.json')
      const result = parseWhatsAppWebhook(payload, TEST_CONFIG_ID, TEST_PHONE_NUMBER_ID)
      const ev = result.dispatch_event!
      expect(ev.event_type).toBe('reaction')
      expect(ev.text).toContain('👍')
    })
  })

  describe('status updates (should be skipped)', () => {
    it('returns no dispatch event for delivery status', () => {
      const payload = fixture('whatsapp-status-update.json')
      const result = parseWhatsAppWebhook(payload, TEST_CONFIG_ID, TEST_PHONE_NUMBER_ID)
      expect(result.dispatch_event).toBeUndefined()
    })
  })

  describe('session key', () => {
    it('produces "whatsapp:<config>:user:<phone>"', () => {
      const payload = fixture('whatsapp-message-text.json')
      const result = parseWhatsAppWebhook(payload, TEST_CONFIG_ID, TEST_PHONE_NUMBER_ID)
      expect(result.dispatch_event!.session_key).toBe(`whatsapp:${TEST_CONFIG_ID}:user:5511999887766`)
    })

    it('same user produces same key across messages', () => {
      const p1 = fixture('whatsapp-message-text.json')
      const p2 = fixture('whatsapp-message-image.json')
      const r1 = parseWhatsAppWebhook(p1, TEST_CONFIG_ID, TEST_PHONE_NUMBER_ID)
      const r2 = parseWhatsAppWebhook(p2, TEST_CONFIG_ID, TEST_PHONE_NUMBER_ID)
      expect(r1.dispatch_event!.session_key).toBe(r2.dispatch_event!.session_key)
    })
  })

  describe('prompt building', () => {
    it('includes platform, user info, phone, message text', () => {
      const payload = fixture('whatsapp-message-text.json')
      const result = parseWhatsAppWebhook(payload, TEST_CONFIG_ID, TEST_PHONE_NUMBER_ID)
      const prompt = result.dispatch_event!.prompt
      expect(prompt).toContain('WhatsApp')
      expect(prompt).toContain('Alice')
      expect(prompt).toContain('5511999887766')
      expect(prompt).toContain('hey can you check the CI?')
    })

    it('includes CLI send instructions', () => {
      const payload = fixture('whatsapp-message-text.json')
      const result = parseWhatsAppWebhook(payload, TEST_CONFIG_ID, TEST_PHONE_NUMBER_ID)
      const prompt = result.dispatch_event!.prompt
      expect(prompt).toContain('whatsapp')
      expect(prompt).toContain('send')
      expect(prompt).toContain('--phone')
    })
  })

  describe('edge cases', () => {
    it('returns no dispatch for null payload', () => {
      const result = parseWhatsAppWebhook(null, TEST_CONFIG_ID, TEST_PHONE_NUMBER_ID)
      expect(result.dispatch_event).toBeUndefined()
    })

    it('returns no dispatch for empty entry', () => {
      const result = parseWhatsAppWebhook({ entry: [] }, TEST_CONFIG_ID, TEST_PHONE_NUMBER_ID)
      expect(result.dispatch_event).toBeUndefined()
    })

    it('returns no dispatch for non-messages field', () => {
      const result = parseWhatsAppWebhook({
        entry: [{ changes: [{ field: 'account_update', value: {} }] }]
      }, TEST_CONFIG_ID, TEST_PHONE_NUMBER_ID)
      expect(result.dispatch_event).toBeUndefined()
    })
  })
})

// ─── WhatsApp Signature Verification ────────────────────────────────────────

describe('verifyWhatsAppSignature', () => {
  const WHATSAPP_APP_SECRET = 'test_whatsapp_app_secret'

  it('accepts valid HMAC-SHA256 signature', () => {
    const body = '{"test":"data"}'
    const crypto = require('crypto')
    const signature = 'sha256=' + crypto.createHmac('sha256', WHATSAPP_APP_SECRET)
      .update(body).digest('hex')

    const result = verifyWhatsAppSignature(body, signature, WHATSAPP_APP_SECRET)
    expect(result).toBe(true)
  })

  it('rejects invalid signature', () => {
    const result = verifyWhatsAppSignature('body', 'sha256=invalid', WHATSAPP_APP_SECRET)
    expect(result).toBe(false)
  })

  it('rejects empty signature', () => {
    const result = verifyWhatsAppSignature('body', '', WHATSAPP_APP_SECRET)
    expect(result).toBe(false)
  })
})
