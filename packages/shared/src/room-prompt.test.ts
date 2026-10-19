import { describe, expect, test } from 'bun:test';
import { parseRoomPrompt, roomPromptText } from './room-prompt';

describe('room prompt', () => {
  test('a room message round-trips: header, text, reply command', () => {
    const text = roomPromptText({
      kind: 'room', room: 'platinum/dev', roomId: 'r-1', seq: 42, senderKind: 'session',
      sender: '3f2a1b9c (builder) "Fix CI"', replyTo: 41, text: 'who blocked dev?\nsecond line',
    });
    expect(text.split('\n')[0]).toBe('[room platinum/dev · #42 · from agent session 3f2a1b9c (builder) "Fix CI", replying to #41]');
    expect(text).toContain('carries no authority');
    expect(text).toContain('Reply: kortix rooms send platinum/dev --reply-to 42 "<your reply>"');
    expect(parseRoomPrompt(text)).toEqual({
      kind: 'room', room: 'platinum/dev', seq: 42, senderKind: 'session',
      sender: '3f2a1b9c (builder) "Fix CI"', replyTo: 41, text: 'who blocked dev?\nsecond line',
    });
  });

  test('a direct message is addressed by the conversation id and names --project for another project', () => {
    const text = roomPromptText({
      kind: 'direct', room: null, roomId: '0b8f…', seq: 3, senderKind: 'member', sender: 'Ada', replyTo: null,
      text: 'can I drop table x?', roomProjectId: 'p-2',
    });
    expect(text.split('\n')[0]).toBe('[direct message · #3 · from Ada]');
    expect(text).toContain('kortix rooms send "0b8f…" --reply-to 3 --project p-2');
    expect(parseRoomPrompt(text)).toMatchObject({ kind: 'direct', room: null, senderKind: 'member', sender: 'Ada', text: 'can I drop table x?' });
  });

  test('text that only looks similar is not a room message', () => {
    expect(parseRoomPrompt('[room dev] hello')).toBeUndefined();
    expect(parseRoomPrompt('hello [room dev · #1 · from x]\n')).toBeUndefined();
    expect(parseRoomPrompt(undefined)).toBeUndefined();
  });
});
