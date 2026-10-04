import { describe, expect, test } from 'bun:test';
import { nextTriggerScheduleSlot, triggerScheduleRevision } from '../triggers/trigger-schedule';
import { channelPrompterForOnBehalfOf } from '../projects/lib/on-behalf-of';
import { type ReminderDraft, reminderPromptText, reminderSpec, newReminderId, parseReminderDraft } from './session-reminders';

const NOW = new Date('2026-09-28T12:00:00.000Z');
const SESSION = '00000000-0000-4000-a000-00000000aa01';

function draft(body: Record<string, unknown>): ReminderDraft {
  const parsed = parseReminderDraft(body, NOW);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed;
}

function parseError(body: Record<string, unknown>): string {
  const parsed = parseReminderDraft(body, NOW);
  if (!('error' in parsed)) throw new Error('expected an error');
  return parsed.error;
}

describe('parseReminderDraft', () => {
  test('every alone recurs and first fires one period from now', () => {
    const reminder = draft({ prompt: ' Did the email arrive? ', every: '1h' });
    expect(reminder.prompt).toBe('Did the email arrive?');
    expect(reminder.everySeconds).toBe(3600);
    expect(reminder.firstFireAt.toISOString()).toBe('2026-09-28T13:00:00.000Z');
  });

  test('in + every starts later, then recurs', () => {
    const reminder = draft({ prompt: 'check', in: '24h', every: '1h' });
    expect(reminder.firstFireAt.toISOString()).toBe('2026-09-29T12:00:00.000Z');
    expect(reminder.everySeconds).toBe(3600);
  });

  test('at alone is a one-shot at that instant', () => {
    const reminder = draft({ prompt: 'check', at: '2026-10-01T09:00:00Z' });
    expect(reminder.everySeconds).toBeNull();
    expect(reminder.cron).toBeNull();
    expect(reminder.firstFireAt.toISOString()).toBe('2026-10-01T09:00:00.000Z');
  });

  test('cron first fires at the next cron slot in its timezone', () => {
    const reminder = draft({ prompt: 'standup', cron: '0 0 9 * * 1-5', timezone: 'Europe/Berlin' });
    expect(reminder.cron).toBe('0 0 9 * * 1-5');
    expect(reminder.firstFireAt.toISOString()).toBe('2026-09-29T07:00:00.000Z');
  });

  test('numeric seconds are accepted as a duration', () => {
    expect(draft({ prompt: 'x', every: 600 }).everySeconds).toBe(600);
  });

  test('rejects missing, conflicting, too-frequent, and past schedules', () => {
    expect(parseError({ every: '1h' })).toBe('prompt is required');
    expect(parseError({ prompt: 'x' })).toContain('Say when');
    expect(parseError({ prompt: 'x', every: '1h', cron: '0 0 * * * *' })).toContain('not both');
    expect(parseError({ prompt: 'x', at: '2026-10-01T00:00:00Z', in: '1h' })).toContain('not both');
    expect(parseError({ prompt: 'x', cron: '0 0 * * * *', in: '1h' })).toContain('drop at/in');
    expect(parseError({ prompt: 'x', every: '1m' })).toBe('every must be at least 5m');
    expect(parseError({ prompt: 'x', cron: '0 * * * * *' })).toBe('cron must fire at most once per 5m');
    expect(parseError({ prompt: 'x', at: '2026-09-28T11:00:00Z' })).toBe('at must be in the future');
    expect(parseError({ prompt: 'x', in: 'soon' })).toContain('in must be a duration');
    expect(parseError({ prompt: 'x', every: '1h', timezone: 'Mars/Base' })).toContain('valid IANA name');
    expect(parseError({ prompt: 'x'.repeat(10_001), every: '1h' })).toContain('at most 10000');
  });
});

describe('parseReminderDraft horizon', () => {
  test('rejects a first fire, an instant, or a period beyond 366 days, and accepts 366 days', () => {
    const limit = 'must be at most 366d';
    expect(parseError({ prompt: 'x', in: '99999999999d' })).toContain(limit);
    expect(parseError({ prompt: 'x', in: 1e30 })).toContain(limit);
    expect(parseError({ prompt: 'x', in: 86_400_000_000 })).toContain(limit);
    expect(parseError({ prompt: 'x', at: '9999-12-31T00:00:00Z' })).toContain(limit);
    expect(parseError({ prompt: 'x', in: '1h', every: '99999999999d' })).toContain(limit);
    expect(draft({ prompt: 'x', in: '366d' }).firstFireAt.toISOString()).toBe('2027-09-29T12:00:00.000Z');
    expect(draft({ prompt: 'x', every: '366d' }).everySeconds).toBe(366 * 86400);
  });
});

describe('reminderSpec', () => {
  test('a one-shot reminder stores runAt; a recurring reminder stores its period', () => {
    const oneShot = reminderSpec({ id: 'reminder.abc', sessionId: SESSION, agent: 'kortix', draft: draft({ prompt: 'x', in: '2h' }), now: NOW });
    expect(oneShot.runAt).toBe('2026-09-28T14:00:00.000Z');
    expect(oneShot.sessionMode).toBe('pinned');
    expect(oneShot.pinnedSessionId).toBe(SESSION);
    expect(oneShot.reminder).toEqual({ everySeconds: null, createdAt: NOW.toISOString() });

    const recurring = reminderSpec({ id: 'reminder.abc', sessionId: SESSION, agent: 'kortix', draft: draft({ prompt: 'x', every: '30m' }), now: NOW });
    expect(recurring.runAt).toBeNull();
    expect(recurring.reminder?.everySeconds).toBe(1800);
  });

  test('the schedule advances one period from the claim, without jitter', () => {
    const spec = reminderSpec({ id: 'reminder.abc', sessionId: SESSION, agent: 'kortix', draft: draft({ prompt: 'x', every: '1h' }), now: NOW });
    const claimedAt = new Date('2026-09-28T15:07:00.000Z');
    expect(nextTriggerScheduleSlot(spec, claimedAt)?.toISOString()).toBe('2026-09-28T16:07:00.000Z');
  });

  test('the reminder field joins the revision only for a reminder', () => {
    const spec = reminderSpec({ id: 'reminder.abc', sessionId: SESSION, agent: 'kortix', draft: draft({ prompt: 'x', every: '1h' }), now: NOW });
    const { reminder: _reminder, ...manifestShaped } = spec;
    expect(triggerScheduleRevision(spec)).not.toBe(triggerScheduleRevision(manifestShaped));
    expect(triggerScheduleRevision({ ...manifestShaped, reminder: null })).toBe(triggerScheduleRevision(manifestShaped));
  });

  test('reminder ids cannot collide with a manifest slug', () => {
    const id = newReminderId();
    expect(id).toMatch(/^reminder\.[0-9a-f]{12}$/);
    expect(/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id)).toBe(false);
  });
});

describe('reminderPromptText', () => {
  test('a recurring reminder tells the agent how to stop it', () => {
    const spec = reminderSpec({ id: 'reminder.abc', sessionId: SESSION, agent: 'kortix', draft: draft({ prompt: 'Did it arrive?', every: '1h' }), now: NOW });
    expect(reminderPromptText(spec)).toBe(
      '[REMINDER reminder.abc — recurring scheduled check-in on this session, not a new user message. When it is no longer needed, run `kortix reminders rm reminder.abc`.]\n\nDid it arrive?',
    );
  });

  test('a one-shot reminder says it fires once', () => {
    const spec = reminderSpec({ id: 'reminder.abc', sessionId: SESSION, agent: 'kortix', draft: draft({ prompt: 'Did it arrive?', in: '24h' }), now: NOW });
    expect(reminderPromptText(spec)).toStartWith('[REMINDER reminder.abc — one-time scheduled check-in');
  });
});

describe('reminder delivery and on_behalf_of', () => {
  test("an agent-set reminder's fire leaves on_behalf_of as is; other trigger fires clear it", () => {
    const rule = (source: string) =>
      channelPrompterForOnBehalfOf({ source, userId: null, slackRequiresUserIdentity: true, teamsRequiresUserIdentity: true });
    expect(rule('trigger:reminder')).toBeUndefined();
    expect(rule('trigger:cron')).toBeNull();
  });
});
