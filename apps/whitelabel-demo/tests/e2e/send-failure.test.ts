import { describe, expect, test } from 'bun:test';
import { sendFailureTitle } from '../../src/lib/send-failure';

describe('sendFailureTitle', () => {
  test('billing reads as an operator problem, not a retry', () => {
    expect(sendFailureTitle({ kind: 'billing', message: 'x' } as never)).toContain('credit');
  });

  test('a not-ready runtime reads as transient', () => {
    expect(sendFailureTitle({ kind: 'runtime-not-ready', message: 'x' } as never)).toContain(
      'starting',
    );
  });

  test('a gateway failure names WHICH provider when the envelope carries it', () => {
    expect(
      sendFailureTitle({
        kind: 'runtime-error',
        message: 'x',
        gateway: { provider: 'anthropic' },
      } as never),
    ).toBe('The anthropic model failed');
  });

  test('a gateway failure without a provider still reads sensibly', () => {
    expect(sendFailureTitle({ kind: 'runtime-error', message: 'x' } as never)).toBe(
      'The agent could not run that',
    );
  });

  test('an unknown kind never produces an empty title', () => {
    expect(sendFailureTitle({ kind: 'something-new', message: 'x' } as never).length).toBeGreaterThan(0);
  });
});
