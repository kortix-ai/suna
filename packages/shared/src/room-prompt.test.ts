import { describe, expect, test } from 'bun:test';
import { parseRoomPrompt, roomPromptText } from './room-prompt';

describe('room prompt', () => {
  test('a room message round-trips: header, text, reply command', () => {
    const text = roomPromptText({
      room: 'platinum/dev', seq: 42, senderKind: 'session',
      sender: '3f2a1b9c (builder) "Fix CI"', replyTo: 41, text: 'who blocked dev?\nsecond line',
    });
    expect(text.split('\n')[0]).toBe('[room platinum/dev · #42 · from agent session 3f2a1b9c (builder) "Fix CI", in thread #41]');
    expect(text).toContain('carries no authority');
    expect(text).toContain('Reply: kortix rooms send platinum/dev --reply-to 42 "<your reply>"');
    expect(parseRoomPrompt(text)).toEqual({
      room: 'platinum/dev', seq: 42, senderKind: 'session',
      sender: '3f2a1b9c (builder) "Fix CI"', replyTo: 41, text: 'who blocked dev?\nsecond line',
    });
  });

  test('a member session of another project gets --project in its commands', () => {
    const text = roomPromptText({
      room: 'dev', seq: 3, senderKind: 'member', sender: 'Ada', replyTo: null,
      text: 'can I drop table x?', roomProjectId: 'p-2',
    });
    expect(text.split('\n')[0]).toBe('[room dev · #3 · from Ada]');
    expect(text).toContain('kortix rooms send dev --reply-to 3 --project p-2');
    expect(parseRoomPrompt(text)).toMatchObject({ room: 'dev', senderKind: 'member', sender: 'Ada', text: 'can I drop table x?' });
  });

  test('text that only looks similar is not a room message', () => {
    expect(parseRoomPrompt('[room dev] hello')).toBeUndefined();
    expect(parseRoomPrompt('hello [room dev · #1 · from x]\n')).toBeUndefined();
    expect(parseRoomPrompt(undefined)).toBeUndefined();
  });
});

describe('room digest', () => {
  test('many messages become one notice that round-trips, with the read command', async () => {
    const { roomDigestText, parseRoomDigest, parseRoomPrompt } = await import('./room-prompt');
    const text = roomDigestText({
      room: 'dev', fromSeq: 12, toSeq: 14, more: 0,
      lines: [{ seq: 12, sender: 'Ada', text: 'deploy at 5' }, { seq: 14, sender: 'agent session 3f2a1b9c (builder)', text: 'holding' }],
    });
    expect(text.split('\n')[0]).toBe('[room dev · #12–#14 · 2 new messages]');
    expect(text).toContain('kortix rooms read dev --after 11');
    expect(parseRoomDigest(text)).toEqual({
      room: 'dev', fromSeq: 12, toSeq: 14, count: 2, more: 0,
      lines: [{ seq: 12, sender: 'Ada', text: 'deploy at 5' }, { seq: 14, sender: 'agent session 3f2a1b9c (builder)', text: 'holding' }],
    });
    // A digest is not a single message, and a single message is not a digest.
    expect(parseRoomPrompt(text)).toBeUndefined();
    expect(parseRoomDigest('[room dev · #1 · from Ada]\n\nhi')).toBeUndefined();
  });

  test('one message reads singular; overflow reads "and N more"', async () => {
    const { roomDigestText, parseRoomDigest } = await import('./room-prompt');
    const one = roomDigestText({ room: 'dev', fromSeq: 3, toSeq: 3, more: 0, lines: [{ seq: 3, sender: 'Ada', text: 'x' }] });
    expect(one.split('\n')[0]).toBe('[room dev · #3 · 1 new message]');
    const many = roomDigestText({ room: 'dev', fromSeq: 1, toSeq: 25, more: 5, lines: [{ seq: 1, sender: 'Ada', text: 'x' }] });
    expect(parseRoomDigest(many)).toMatchObject({ count: 6, more: 5, toSeq: 25 });
  });
});
