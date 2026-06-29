/**
 * Meet (Recall.ai) real-time relay — the server-side verification + wake-gating
 * that turns a live transcript/chat event into a (rare) session escalation.
 *   • token    — the HMAC we stamp into bot metadata at join round-trips + is
 *                forgery-resistant (wrong/empty tokens rejected).
 *   • extract  — transcript.data words + chat messages parse to (speaker, text).
 *   • wake     — only utterances ADDRESSING the bot escalate; ambient chatter
 *                is dropped (listen-by-default).
 *   • join     — the injected patch carries a verifying token + the webhook url.
 */
import { describe, expect, test } from 'bun:test';
import { config } from '../config';
import {
  MEET_REALTIME_PATH,
  isWake,
  meetRealtimeJoinPatch,
  meetSessionToken,
  verifyMeetSessionToken,
  wakeKey,
} from '../channels/meet-realtime';
import { buildWakePrompt, extractTurn } from '../channels/meet-webhook';

function transcriptEvent(words: string[], opts: { name?: string; wake?: string } = {}) {
  return {
    event: 'transcript.data',
    data: {
      bot: { id: 'bot_abc', metadata: { kortix_wake: opts.wake ?? 'kortix' } },
      data: { participant: { name: opts.name ?? 'Priya' }, words: words.map((text) => ({ text })) },
    },
  };
}

describe('meet session token', () => {
  test('round-trips for the same session id', () => {
    const t = meetSessionToken('sess-1');
    expect(verifyMeetSessionToken('sess-1', t)).toBe(true);
  });

  test('rejects a token minted for a different session, and empties', () => {
    expect(verifyMeetSessionToken('sess-2', meetSessionToken('sess-1'))).toBe(false);
    expect(verifyMeetSessionToken('sess-1', '')).toBe(false);
    expect(verifyMeetSessionToken('', meetSessionToken('sess-1'))).toBe(false);
  });
});

describe('extractTurn', () => {
  test('joins transcript words into a spoken turn with the speaker', () => {
    expect(extractTurn(transcriptEvent(['Hey', 'Kortix,', 'help']))).toEqual({
      speaker: 'Priya',
      text: 'Hey Kortix, help',
      spoken: true,
    });
  });

  test('reads a chat message (text nested at data.data.data.text), spoken=false', () => {
    const ev = {
      event: 'participant_events.chat_message',
      data: {
        bot: { id: 'b', metadata: {} },
        data: { participant: { name: 'Sam' }, data: { text: 'ping kortix', to: 'everyone' } },
      },
    };
    expect(extractTurn(ev as any)).toEqual({ speaker: 'Sam', text: 'ping kortix', spoken: false });
  });

  test('unknown event → null', () => {
    expect(extractTurn({ event: 'participant_events.join', data: {} } as any)).toBeNull();
  });
});

describe('buildWakePrompt — reply in the same channel', () => {
  test('spoken → reply OUT LOUD (meet speak)', () => {
    const p = buildWakePrompt({ speaker: 'Priya', text: 'Hey Kortix, share the doc', spoken: true, botId: 'bot_abc' });
    expect(p).toContain('(spoken): "Hey Kortix, share the doc"');
    expect(p).toContain('meet speak bot_abc');
    expect(p).not.toContain('meet chat bot_abc');
  });

  test('typed → reply IN CHAT (meet chat)', () => {
    const p = buildWakePrompt({ speaker: 'Sam', text: 'hey kortix drop the link', spoken: false, botId: 'bot_abc' });
    expect(p).toContain('wrote in the chat');
    expect(p).toContain('meet chat bot_abc');
    expect(p).not.toContain('meet speak bot_abc');
  });
});

describe('isWake — phonetic wake matching (caption mis-hearings)', () => {
  test('homophones of "kortix" collapse to the same phonetic key', () => {
    const k = wakeKey('kortix');
    for (const v of ['cortex', 'cortix', 'kortex', 'quartix', 'Cortex']) {
      expect(wakeKey(v)).toBe(k);
    }
  });

  test('wakes on the literal name and on common caption mis-hearings', () => {
    for (const t of [
      'Hey Kortix, you there?',
      'hey cortex can you analyze the repo',   // the exact real-world miss
      'so cortix, what do you think',
      'quartix summarize this',
      'hey core tex are you listening',          // split into two words
    ]) {
      expect(isWake(t, 'kortix')).toBe(true);
    }
  });

  test('stays silent on unrelated words (no false wake)', () => {
    for (const t of ['ship the migration first', 'what about the context here', 'that corrects the issue']) {
      expect(isWake(t, 'kortix')).toBe(false);
    }
  });
});

describe('meetRealtimeJoinPatch', () => {
  test('carries a verifying token + the realtime webhook url (when a public URL is configured)', () => {
    const patch = meetRealtimeJoinPatch('proj-1', 'sess-1');
    if (!config.KORTIX_URL) {
      expect(patch).toBeNull(); // no public base → no realtime relay
      return;
    }
    expect(patch!.metadata.kortix_session_id).toBe('sess-1');
    expect(verifyMeetSessionToken('sess-1', patch!.metadata.kortix_token as string)).toBe(true);
    const ep = patch!.realtimeEndpoints[0] as { type: string; url: string; events: string[] };
    expect(ep.type).toBe('webhook');
    expect(ep.url.endsWith(MEET_REALTIME_PATH)).toBe(true);
    expect(ep.events).toContain('transcript.data');
  });
});
