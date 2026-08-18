import { describe, expect, test } from 'bun:test';

import { WIRE_MESSAGE_ID, mintWireMessageId, wireIdTime } from '../projects/wire-message-id';
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

describe('repairPromptWireId', () => {
  test('a body with no messageID is forwarded untouched — OpenCode mints its own', () => {
    const body = enc({ parts: [{ type: 'text', text: 'hi' }] });
    const result = repairPromptWireId({ body, newestKnownTime: null, nowMs: NOW });
    expect(result.outcome).toBe('none');
    expect(result.body).toBe(body);
    expect(result.effectiveMessageId).toBeNull();
  });

  test('a well-placed client id is kept byte-for-byte', () => {
    const older = mintWireMessageId({ nowMs: NOW - 60_000 });
    const client = mintWireMessageId({ nowMs: NOW });
    const body = enc({ messageID: client.id, parts: [] });
    const result = repairPromptWireId({ body, newestKnownTime: older.time, nowMs: NOW });
    expect(result.outcome).toBe('kept');
    expect(result.body).toBe(body);
    expect(result.effectiveMessageId).toBe(client.id);
  });

  test('a client id at-or-below the newest known message is RE-MINTED above it', () => {
    // The Essentia case: a steering prompt into a continuously-streaming child
    // session, minted by a tab whose store held none of that child's messages,
    // fell back to the 2-minute backdate and sorted below the tip. OpenCode
    // read it as already answered and the turn never ran.
    const tip = mintWireMessageId({ nowMs: NOW - 1_000 });
    const stale = mintWireMessageId({ nowMs: NOW - 120_000 });
    const body = enc({ messageID: stale.id, parts: [{ type: 'text', text: 'stop looping' }] });
    const result = repairPromptWireId({ body, newestKnownTime: tip.time, nowMs: NOW });

    expect(result.outcome).toBe('reminted');
    const forwarded = dec(result.body);
    expect(forwarded.messageID).toMatch(WIRE_MESSAGE_ID);
    expect(forwarded.messageID).not.toBe(stale.id);
    expect(wireIdTime(forwarded.messageID)! > tip.time).toBe(true);
    // Every other field survives the rewrite.
    expect(forwarded.parts).toEqual([{ type: 'text', text: 'stop looping' }]);
    expect(result.effectiveMessageId).toBe(forwarded.messageID);
  });

  test('a malformed client id is re-minted rather than forwarded for OpenCode to misorder', () => {
    const body = enc({ messageID: 'msg_1a01deadbeef0000000000000000', parts: [] });
    const result = repairPromptWireId({ body, newestKnownTime: null, nowMs: NOW });
    expect(result.outcome).toBe('reminted');
    expect(dec(result.body).messageID).toMatch(WIRE_MESSAGE_ID);
  });

  test('with NO transcript evidence a valid client id is kept — repair only on positive evidence', () => {
    // A failed transcript read must never rewrite an id the client placed
    // correctly: the read is fail-open, and "we could not check" is not "it
    // is wrong".
    const client = mintWireMessageId({ nowMs: NOW - 300_000 });
    const body = enc({ messageID: client.id, parts: [] });
    const result = repairPromptWireId({ body, newestKnownTime: null, nowMs: NOW });
    expect(result.outcome).toBe('kept');
    expect(result.effectiveMessageId).toBe(client.id);
  });

  test('an unparseable body is forwarded untouched for OpenCode to reject', () => {
    const body = new TextEncoder().encode('{not json').buffer as ArrayBuffer;
    const result = repairPromptWireId({ body, newestKnownTime: null, nowMs: NOW });
    expect(result.outcome).toBe('none');
    expect(result.body).toBe(body);
  });
});
