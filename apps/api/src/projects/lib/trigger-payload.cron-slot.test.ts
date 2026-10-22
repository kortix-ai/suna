import { describe, expect, test } from 'bun:test';
import { cronSlotFields, renderSessionKey } from './trigger-payload';

describe('cronSlotFields', () => {
  test('derives the UTC date and hour of the scheduled slot', () => {
    expect(cronSlotFields(new Date('2026-10-06T13:07:00.000Z'))).toEqual({
      scheduled_date: '2026-10-06',
      scheduled_hour: '2026-10-06T13',
    });
  });

  test('a daily session key rolls over at UTC midnight and is stable within the day', () => {
    const spec = { sessionMode: 'keyed', sessionKey: 'merge-v41-{{ cron.scheduled_date }}' } as never;
    const at = (iso: string) => renderSessionKey(spec, { cron: cronSlotFields(new Date(iso)) });
    expect(at('2026-10-06T00:00:00.000Z')).toBe('merge-v41-2026-10-06');
    expect(at('2026-10-06T23:58:00.000Z')).toBe('merge-v41-2026-10-06');
    expect(at('2026-10-07T00:00:00.000Z')).toBe('merge-v41-2026-10-07');
  });
});
