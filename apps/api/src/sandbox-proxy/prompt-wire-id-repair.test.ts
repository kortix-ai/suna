import { describe, expect, test } from 'bun:test';

import { WIRE_MESSAGE_ID, newestWireIdTime, wireIdTime } from '../projects/wire-message-id';
import {
  isPromptWireIdRepairPath,
  promptTranscriptReadPath,
  repairPromptWireId,
} from './prompt-wire-id-repair';

const NOW = 1_770_000_000_000;
const enc = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj)).buffer as ArrayBuffer;
const dec = (buf: ArrayBuffer) => JSON.parse(new TextDecoder().decode(buf)) as Record<string, any>;

describe('isPromptWireIdRepairPath', () => {
  test('prompt_async and message carry a client wire id; command and summarize do not', () => {
    expect(isPromptWireIdRepairPath('/session/ses_1/prompt_async')).toBe(true);
    expect(isPromptWireIdRepairPath('/session/ses_1/message')).toBe(true);
    expect(isPromptWireIdRepairPath('/proxy/4096/session/ses_1/prompt_async')).toBe(true);
    expect(isPromptWireIdRepairPath('/session/ses_1/command')).toBe(false);
    expect(isPromptWireIdRepairPath('/session/ses_1/summarize')).toBe(false);
    expect(isPromptWireIdRepairPath('/session/ses_1/message/msg_1')).toBe(false);
  });
});

describe('promptTranscriptReadPath', () => {
  test('rewrites the delivery path to the same session\'s newest-N read, prefix preserved', () => {
    expect(promptTranscriptReadPath('/session/ses_1/prompt_async', 8)).toBe(
      '/session/ses_1/message?limit=8',
    );
    expect(promptTranscriptReadPath('/proxy/4096/session/ses_1/message', 8)).toBe(
      '/proxy/4096/session/ses_1/message?limit=8',
    );
  });
});

// Kept, re-minted and unreadable-read placements are proven on the forward path
// in routes/forward.test.ts (the ledger id and the echo header agree with the
// wire). These rows pin the decisions that path does not reach.
describe('repairPromptWireId', () => {
  test('a body with no messageID is forwarded untouched — OpenCode mints its own', () => {
    const body = enc({ parts: [{ type: 'text', text: 'hi' }] });
    const result = repairPromptWireId({ body, newestKnownTime: null, nowMs: NOW });
    expect(result.outcome).toBe('none');
    expect(result.body).toBe(body);
    expect(result.effectiveMessageId).toBeNull();
  });

  describe('across the 48-bit wrap (2026-08-14T11:19:55.136Z)', () => {
    const WRAP_MS = 1_786_706_395_136;
    const nowMs = WRAP_MS + 120_000;
    const PRE_WRAP_NEWEST = 'msg_fffff8ad0000AAAAAAAAAAAAAA';
    const POST_WRAP_NEWEST = 'msg_000007530000AAAAAAAAAAAAAA';

    test('a pre-wrap client id below a post-wrap newest is RE-MINTED above it', () => {
      const newest = newestWireIdTime([PRE_WRAP_NEWEST, POST_WRAP_NEWEST], nowMs);
      expect(newest).toBe(BigInt('0x000007530000'));
      const body = enc({ messageID: 'msg_fffff15a0000AAAAAAAAAAAAAA', parts: [] });
      const result = repairPromptWireId({ body, newestKnownTime: newest, nowMs, random: () => 0 });
      expect(result.outcome).toBe('reminted');
      expect(wireIdTime(result.effectiveMessageId!)).toBe(BigInt('0x000007530001'));
    });

    test('a post-wrap client id above a pre-wrap newest is kept', () => {
      const body = enc({ messageID: POST_WRAP_NEWEST, parts: [] });
      const result = repairPromptWireId({
        body,
        newestKnownTime: wireIdTime(PRE_WRAP_NEWEST),
        nowMs,
        random: () => 0,
      });
      expect(result.outcome).toBe('kept');
      expect(result.effectiveMessageId).toBe(POST_WRAP_NEWEST);
    });
  });

  test('a malformed client id is re-minted rather than forwarded for OpenCode to misorder', () => {
    const body = enc({ messageID: 'msg_1a01deadbeef0000000000000000', parts: [] });
    const result = repairPromptWireId({ body, newestKnownTime: null, nowMs: NOW });
    expect(result.outcome).toBe('reminted');
    expect(dec(result.body).messageID).toMatch(WIRE_MESSAGE_ID);
  });

  test('an unparseable body is forwarded untouched for OpenCode to reject', () => {
    const body = new TextEncoder().encode('{not json').buffer as ArrayBuffer;
    const result = repairPromptWireId({ body, newestKnownTime: null, nowMs: NOW });
    expect(result.outcome).toBe('none');
    expect(result.body).toBe(body);
  });

  test('a far-future client id (the pre-fix CLI shape) is RE-MINTED, even with no transcript read', () => {
    // `msg_1a0d…` sits ~40 days ahead of the clock. Kept, it renders every
    // later turn ABOVE this prompt. It is positive evidence on its own.
    const nowMs = Date.parse('2026-09-24T16:11:24.000Z');
    const body = enc({ messageID: 'msg_1a0d42f86f80SyntheticCli03', parts: [] });
    const result = repairPromptWireId({ body, newestKnownTime: null, nowMs });
    expect(result.outcome).toBe('reminted');
    const forwarded = dec(result.body).messageID as string;
    expect(forwarded).toMatch(WIRE_MESSAGE_ID);
    expect(forwarded.startsWith('msg_0d42')).toBe(true);
  });
});
