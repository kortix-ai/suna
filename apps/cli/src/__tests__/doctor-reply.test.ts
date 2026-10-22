import { describe, expect, test } from 'bun:test';

import { doctorReplyVerdict } from '../commands/doctor.ts';

// KRTX-2918: a turn that failed showed only "reply had no text content"; the
// cause the gateway gave was nowhere in the doctor output.

function reply(opts: { text?: string; error?: boolean }) {
  return {
    info: {
      id: 'msg_reply',
      sessionID: 'ses_doctor',
      role: 'assistant',
      parentID: 'msg_prompt',
      mode: 'build',
      modelID: 'synthetic-model',
      providerID: 'kortix',
      path: { cwd: '/workspace', root: '/workspace' },
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 2, completed: 3 },
      // OpenCode's error envelope: the message lives under `data.message`.
      ...(opts.error
        ? { error: { name: 'APIError', data: { message: '"synthetic-model" requires a paid plan.' } } }
        : {}),
    },
    parts: opts.text
      ? [{ id: 'part_1', sessionID: 'ses_doctor', messageID: 'msg_reply', type: 'text', text: opts.text }]
      : [],
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
    message.parts.unshift({
      id: 'part_reasoning',
      sessionID: 'ses_doctor',
      messageID: 'msg_reply',
      type: 'reasoning',
      text: 'The user just said ping. I should respond with pong.',
      time: { start: 2, end: 3 },
    });
    expect(doctorReplyVerdict(message)).toEqual({ ok: true, text: 'pong' });
  });

  test('reasoning alone is not a reply', () => {
    const message = reply({});
    message.parts.push({
      id: 'part_reasoning',
      sessionID: 'ses_doctor',
      messageID: 'msg_reply',
      type: 'reasoning',
      text: 'I should respond with pong.',
      time: { start: 2, end: 3 },
    });
    expect(doctorReplyVerdict(message)).toEqual({ ok: false, reason: 'reply had no text content' });
  });

  test('a clean reply with no text keeps the old message', () => {
    expect(doctorReplyVerdict(reply({}))).toEqual({ ok: false, reason: 'reply had no text content' });
  });
});
