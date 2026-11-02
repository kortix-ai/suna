import { describe, expect, test } from 'bun:test';

import { doctorReplyVerdict } from '../commands/doctor.ts';

// KRTX-2918: a turn that failed showed only "reply had no text content"; the
// cause the gateway gave was nowhere in the doctor output.

function reply(opts: { text?: string; error?: boolean }) {
  return {
    schema: 'kortix.session/2',
    v: 0,
    producer: { harness: 'pi', harness_version: '1', adapter_version: '1' },
    message_id: 'msg_reply',
    thread_id: 'ses_doctor',
    seq: 2,
    kind: 'turn',
    role: 'assistant',
    reply_to: 'msg_prompt',
    status: opts.error ? 'error' : 'complete',
    created_at: new Date(2).toISOString(),
    completed_at: new Date(3).toISOString(),
    ...(opts.error ? { error: { code: 'APIError', message: '"synthetic-model" requires a paid plan.' } } : {}),
    blocks: opts.text ? [{ type: 'text', id: 'part_1', text: opts.text }] : [],
  } as unknown as Parameters<typeof doctorReplyVerdict>[0];
}

describe('kortix doctor reply check', () => {
  test('a failed turn with no text names the turn error', () => {
    expect(doctorReplyVerdict(reply({ error: true }))).toEqual({
      ok: false,
      reason: 'reply failed — APIError: "synthetic-model" requires a paid plan.',
    });
  });

  test('a turn that failed after partial text still fails, with the error', () => {
    const verdict = doctorReplyVerdict(reply({ text: 'Starting…', error: true }));
    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ reason: expect.stringContaining('requires a paid plan') });
  });

  test('a clean reply passes with its text', () => {
    expect(doctorReplyVerdict(reply({ text: 'ready' }))).toEqual({ ok: true, text: 'ready' });
  });

  test('shows the answer, not the reasoning that precedes it', () => {
    const message = reply({ text: 'pong' });
    message.blocks.unshift({ type: 'reasoning', id: 'part_reasoning', text: 'The user just said ping. I should respond with pong.' } as never);
    expect(doctorReplyVerdict(message)).toEqual({ ok: true, text: 'pong' });
  });

  test('reasoning alone is not a reply', () => {
    const message = reply({});
    message.blocks.push({ type: 'reasoning', id: 'part_reasoning', text: 'I should respond with pong.' } as never);
    expect(doctorReplyVerdict(message)).toEqual({ ok: false, reason: 'reply had no text content' });
  });

  test('a clean reply with no text keeps the old message', () => {
    expect(doctorReplyVerdict(reply({}))).toEqual({ ok: false, reason: 'reply had no text content' });
  });
});
