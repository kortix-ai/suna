import { describe, expect, test } from 'bun:test';
import { parseReminderPrompt, reminderPromptText } from './reminder-prompt';

describe('reminder prompt', () => {
  test('a one-time header round-trips', () => {
    const text = reminderPromptText({ id: 'reminder.0123456789ab', recurring: false, prompt: 'Did it arrive?' });
    expect(text).toBe(
      '[REMINDER reminder.0123456789ab — one-time scheduled check-in on this session, not a new user message.]\n\nDid it arrive?',
    );
    expect(parseReminderPrompt(text)).toEqual({ id: 'reminder.0123456789ab', recurring: false, prompt: 'Did it arrive?' });
  });

  test('a recurring header carries the remove command and round-trips', () => {
    const text = reminderPromptText({ id: 'reminder.0123456789ab', recurring: true, prompt: 'Line one\nLine two' });
    expect(text).toContain('run `kortix reminders rm reminder.0123456789ab`.]');
    expect(parseReminderPrompt(text)).toEqual({ id: 'reminder.0123456789ab', recurring: true, prompt: 'Line one\nLine two' });
  });

  test('anything else is not a reminder', () => {
    expect(parseReminderPrompt(undefined)).toBeUndefined();
    expect(parseReminderPrompt('')).toBeUndefined();
    expect(parseReminderPrompt('please [REMINDER reminder.0123456789ab — one-time x.]')).toBeUndefined();
    expect(parseReminderPrompt('[REMINDER nope — one-time scheduled check-in.]\n\nx')).toBeUndefined();
    expect(parseReminderPrompt('[REMINDER reminder.0123456789ab — one-time never closed')).toBeUndefined();
  });

  test('stays linear on a long unterminated header', () => {
    const hostile = `[REMINDER reminder.0123456789ab — one-time ${'x'.repeat(200_000)}`;
    const start = performance.now();
    expect(parseReminderPrompt(hostile)).toBeUndefined();
    expect(performance.now() - start).toBeLessThan(250);
  });
});
