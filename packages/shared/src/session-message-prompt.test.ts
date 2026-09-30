import { describe, expect, test } from 'bun:test';
import { parseSessionMessagePrompt, sessionMessagePromptText } from './session-message-prompt';

const SID = '0f8b2c1e-1d2a-4c3b-9e8f-7a6b5c4d3e2f';

describe('session message prompt', () => {
  test('a session message round-trips and tells the agent how to reply', () => {
    const text = sessionMessagePromptText({
      type: 'message',
      sender: { kind: 'session', sessionId: SID, title: 'Move to prod — now' },
      to: [],
      prompt: 'Build is green.',
    });
    expect(text).toContain(`kortix send ${SID}`);
    expect(parseSessionMessagePrompt(text)).toEqual({
      type: 'message',
      sender: { kind: 'session', sessionId: SID, title: 'Move to prod now' },
      to: [],
      prompt: 'Build is green.',
    });
  });

  test('an ask names its people, even when the title contains " to "', () => {
    const text = sessionMessagePromptText({
      type: 'ask',
      sender: { kind: 'session', sessionId: SID, title: 'Move to prod' },
      to: [
        { name: 'Avery Stone', email: 'avery@example.com' },
        { name: '', email: 'blake@example.com' },
      ],
      prompt: 'Which region?\nSecond line.',
    });
    const parsed = parseSessionMessagePrompt(text);
    expect(parsed?.type).toBe('ask');
    expect(parsed?.sender).toEqual({ kind: 'session', sessionId: SID, title: 'Move to prod' });
    expect(parsed?.to).toEqual([
      { name: 'Avery Stone', email: 'avery@example.com' },
      { name: 'blake@example.com', email: 'blake@example.com' },
    ]);
    expect(parsed?.prompt).toBe('Which region?\nSecond line.');
  });

  test('a person message carries no reply instruction', () => {
    const text = sessionMessagePromptText({
      type: 'message',
      sender: { kind: 'person', name: 'Avery "x" [y]', email: 'avery@example.com' },
      to: [],
      prompt: 'us-east-2',
    });
    expect(text.split('\n')[0]).toBe('[MESSAGE from Avery x y <avery@example.com>]');
    expect(parseSessionMessagePrompt(text)?.sender).toEqual({ kind: 'person', name: 'Avery x y', email: 'avery@example.com' });
  });

  test('ordinary text and a broken header are not messages', () => {
    expect(parseSessionMessagePrompt('hello')).toBeUndefined();
    expect(parseSessionMessagePrompt('[MESSAGE from nobody]\n\nx')).toBeUndefined();
    expect(parseSessionMessagePrompt('[MESSAGE from Avery <a@example.com>\nno close]')).toBeUndefined();
    expect(parseSessionMessagePrompt(null)).toBeUndefined();
  });
});
