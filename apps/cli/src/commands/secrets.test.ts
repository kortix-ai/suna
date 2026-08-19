import { describe, expect, test } from 'bun:test';
import { stripAnsi } from '../style.ts';
import { deliveryCell, describeLinkValidity } from './secrets.ts';

describe('describeLinkValidity', () => {
  const now = Date.parse('2026-08-07T12:00:00.000Z');

  test('a 7-day link reads as days', () => {
    expect(describeLinkValidity('2026-08-14T12:00:00.000Z', now)).toBe('7 days');
  });

  test('sub-2-day windows read as hours, sub-2-hour as minutes', () => {
    expect(describeLinkValidity('2026-08-08T00:00:00.000Z', now)).toBe('12 hours');
    expect(describeLinkValidity('2026-08-07T12:45:00.000Z', now)).toBe('45 minutes');
  });

  test('past or unparseable expiry degrades without lying', () => {
    expect(describeLinkValidity('2026-08-07T11:00:00.000Z', now)).toBe('an unknown window');
    expect(describeLinkValidity('garbage', now)).toBe('an unknown window');
  });
});

describe('deliveryCell', () => {
  const cell = (row: Partial<Parameters<typeof deliveryCell>[0]> = {}): string =>
    stripAnsi(
      deliveryCell({
        strategy: 'runtime',
        consumer: 'sandbox',
        deliveryStatus: 'available',
        requiresRotation: false,
        ...row,
      }),
    );

  test('names where a healthy value goes', () => {
    expect(cell()).toBe('sandbox');
    expect(cell({ strategy: 'broker', consumer: 'llm_gateway' })).toBe('llm_gateway');
    expect(cell({ strategy: 'broker', consumer: null })).toBe('Kortix broker');
    expect(cell({ strategy: 'egress', consumer: 'network' })).toBe('approved hosts');
  });

  test('an undeliverable path is marked in text, not only in colour', () => {
    // The CLI runs unstyled under NO_COLOR and in pipes, where a red cell and a
    // healthy one are the same bytes — the marker has to survive stripAnsi.
    expect(cell({ strategy: 'egress', consumer: 'network', deliveryStatus: 'unavailable' })).toBe(
      'approved hosts · unavailable',
    );
    expect(cell({ deliveryStatus: 'unavailable' })).toBe('sandbox · unavailable');
  });

  test('denied delivery reports its own target and is never flagged', () => {
    expect(cell({ strategy: 'denied', consumer: null, deliveryStatus: 'disabled' })).toBe(
      'disabled',
    );
  });

  test('rotation and undeliverability are independent and both show', () => {
    expect(cell({ requiresRotation: true })).toBe('sandbox · rotate');
    expect(
      cell({
        strategy: 'egress',
        consumer: 'network',
        deliveryStatus: 'unavailable',
        requiresRotation: true,
      }),
    ).toBe('approved hosts · unavailable · rotate');
  });
});
