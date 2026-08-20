import { describe, expect, test } from 'bun:test';
import { stripAnsi } from '../style.ts';
import { deliveryCell, describeLinkValidity, parseExposure } from './secrets.ts';

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

  test('names the exposure, or the service that spends the value', () => {
    expect(cell()).toBe('environment');
    expect(cell({ strategy: 'broker', consumer: 'llm_gateway' })).toBe('llm_gateway');
    expect(cell({ strategy: 'broker', consumer: null })).toBe('Kortix service');
    expect(cell({ strategy: 'egress', consumer: 'network' })).toBe('enforced: approved hosts');
  });

  test('an undeliverable path is marked in text, not only in colour', () => {
    // The CLI runs unstyled under NO_COLOR and in pipes, where a red cell and a
    // healthy one are the same bytes — the marker has to survive stripAnsi.
    expect(cell({ strategy: 'egress', consumer: 'network', deliveryStatus: 'unavailable' })).toBe(
      'enforced: approved hosts · unavailable',
    );
    expect(cell({ deliveryStatus: 'unavailable' })).toBe('environment · unavailable');
  });

  test('denied delivery reports its own target and is never flagged', () => {
    expect(cell({ strategy: 'denied', consumer: null, deliveryStatus: 'disabled' })).toBe(
      'disabled',
    );
  });

  test('rotation and undeliverability are independent and both show', () => {
    expect(cell({ requiresRotation: true })).toBe('environment · rotate');
    expect(
      cell({
        strategy: 'egress',
        consumer: 'network',
        deliveryStatus: 'unavailable',
        requiresRotation: true,
      }),
    ).toBe('enforced: approved hosts · unavailable · rotate');
  });
});

describe('parseExposure', () => {
  test('the model words map to the stored strategy names', () => {
    expect(parseExposure('environment')).toBe('runtime');
    expect(parseExposure('enforced')).toBe('egress');
    expect(parseExposure('egress-enforced')).toBe('egress');
    expect(parseExposure('none')).toBe('denied');
  });

  test('the stored names stay accepted, so no existing script breaks', () => {
    // Deprecate, do not remove: `kortix secrets delivery X egress` is written
    // down in scripts and in agent transcripts.
    expect(parseExposure('runtime')).toBe('runtime');
    expect(parseExposure('egress')).toBe('egress');
    expect(parseExposure('broker')).toBe('broker');
    expect(parseExposure('denied')).toBe('denied');
  });

  test('input is trimmed and case-insensitive; anything else is rejected', () => {
    expect(parseExposure('  Enforced  ')).toBe('egress');
    expect(parseExposure('plaintext')).toBeNull();
    expect(parseExposure('')).toBeNull();
    expect(parseExposure(undefined)).toBeNull();
  });
});
