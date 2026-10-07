import { describe, expect, test } from 'bun:test';

import { formatBookedSlot, subscribeBookingSuccess, type CalEventApi } from './demo-booking';

function fakeCal() {
  const listeners = new Set<(e: unknown) => void>();
  const calls: string[] = [];
  const cal: CalEventApi = (method, { action, callback }) => {
    calls.push(`${method}:${action}`);
    if (method === 'on') listeners.add(callback as (e: unknown) => void);
    else listeners.delete(callback as (e: unknown) => void);
  };
  const fire = (data: Record<string, unknown>) =>
    listeners.forEach((l) => l(new CustomEvent('x', { detail: { data } })));
  return { cal, calls, listeners, fire };
}

describe('subscribeBookingSuccess', () => {
  test('the cleanup removes the exact listener it added', () => {
    const { cal, calls, listeners } = fakeCal();
    const unsubscribe = subscribeBookingSuccess(cal, () => {});
    expect(listeners.size).toBe(1);
    unsubscribe();
    expect(listeners.size).toBe(0);
    expect(calls).toEqual(['on:bookingSuccessfulV2', 'off:bookingSuccessfulV2']);
  });

  test('re-opening the modal never stacks a second listener', () => {
    const { cal, listeners, fire } = fakeCal();
    let booked = 0;
    for (let open = 0; open < 3; open++) subscribeBookingSuccess(cal, () => booked++)();
    const unsubscribe = subscribeBookingSuccess(cal, () => booked++);
    fire({ uid: 'b1', startTime: '2026-10-08T12:30:00Z', endTime: '2026-10-08T13:00:00Z' });
    expect(listeners.size).toBe(1);
    expect(booked).toBe(1);
    unsubscribe();
  });

  test('passes the booking payload through', () => {
    const { cal, fire } = fakeCal();
    let got: unknown = null;
    subscribeBookingSuccess(cal, (b) => (got = b));
    fire({ uid: 'b1', title: 'Kortix demo', startTime: 'a', endTime: 'b' });
    expect(got).toEqual({ uid: 'b1', title: 'Kortix demo', startTime: 'a', endTime: 'b' });
  });
});

describe('formatBookedSlot', () => {
  test('formats the slot in the viewer time zone', () => {
    const slot = formatBookedSlot(
      { startTime: '2026-10-08T12:30:00Z', endTime: '2026-10-08T13:00:00Z' },
      'en-US',
      'Europe/Berlin',
    );
    expect(slot).not.toBeNull();
    expect(slot!.month).toBe('Oct');
    expect(slot!.day).toBe('08');
    expect(slot!.weekday).toBe('Thu');
    expect(slot!.time.replace(/\s/g, ' ')).toMatch(/^2:30\s?–\s?3:00 PM$/);
    expect(slot!.zone).toBe('GMT+2');
    expect(slot!.minutes).toBe(30);
  });

  test('returns null for a payload without valid times', () => {
    expect(formatBookedSlot({ startTime: undefined, endTime: undefined }, 'en-US')).toBeNull();
    expect(formatBookedSlot({ startTime: 'nope', endTime: 'nope' }, 'en-US')).toBeNull();
  });
});
