import { describe, expect, test } from 'bun:test';

import {
  COMPACTION_LABEL_DONE,
  COMPACTION_LABEL_LOADING,
  compactionFailedLabel,
  isInsufficientCreditsError,
  isUsageLimitError,
  parseBalance,
  turnErrorCard,
  turnErrorSuggestion,
} from './turn-error';

describe('credits / usage-limit detection (web session-error-banner.tsx)', () => {
  test('insufficient credits', () => {
    expect(isInsufficientCreditsError('Payment Required: Insufficient credits. Balance: $-0.06')).toBe(true);
    expect(isInsufficientCreditsError('You are out of credits')).toBe(true);
    expect(isInsufficientCreditsError('HTTP 402: credit limit')).toBe(true);
    expect(isInsufficientCreditsError('Payment required')).toBe(false);
  });

  test('usage limit', () => {
    expect(isUsageLimitError('Free usage exceeded, subscribe to Go')).toBe(true);
    expect(isUsageLimitError('subscription_required')).toBe(true);
    expect(isUsageLimitError('Billing inactive')).toBe(true);
    expect(isUsageLimitError('Model not found')).toBe(false);
  });

  test('balance', () => {
    expect(parseBalance('Insufficient credits. Balance: $-0.06')).toBe('$-0.06');
    expect(parseBalance('balance: 12.5')).toBe('$12.50');
    expect(parseBalance('no number')).toBeNull();
  });
});

describe('turnErrorCard routing (web TurnErrorDisplay)', () => {
  test('nothing to show', () => {
    expect(turnErrorCard({})).toEqual({ kind: 'none' });
    expect(turnErrorCard({ errorText: '' })).toEqual({ kind: 'none' });
  });

  test('an abort renders nothing, by identity first and prose second', () => {
    expect(turnErrorCard({ errorText: 'Something failed', isAbort: true })).toEqual({ kind: 'none' });
    expect(turnErrorCard({ errorText: 'The operation was aborted.' })).toEqual({ kind: 'none' });
    expect(turnErrorCard({ errorText: 'The operation was aborted.', isAbort: false }).kind).toBe('error');
  });

  test('connector refusals belong to the connector notice', () => {
    expect(turnErrorCard({ error: { kind: 'connector', message: 'Connect Gmail' } })).toEqual({ kind: 'none' });
  });

  test('typed billing errors pick the card from the entitlement code', () => {
    expect(
      turnErrorCard({ error: { kind: 'billing', message: 'x', billing: { detail: { code: 'budget_exceeded' } } } }).kind,
    ).toBe('usage-limit');
    expect(turnErrorCard({ error: { kind: 'billing', message: 'Subscribe to activate your seat' } }).kind).toBe(
      'usage-limit',
    );
    expect(
      turnErrorCard({ error: { kind: 'billing', message: 'x', billing: { detail: { code: 'insufficient_credits' } } } })
        .kind,
    ).toBe('credits');
  });

  test('plain text routes by message', () => {
    expect(turnErrorCard({ errorText: 'Insufficient credits. Balance: $1' })).toEqual({
      kind: 'credits',
      text: 'Insufficient credits. Balance: $1',
    });
    expect(turnErrorCard({ errorText: 'Free usage exceeded' }).kind).toBe('usage-limit');
    expect(turnErrorCard({ errorText: 'ModelNotFound', errorDetails: { provider: 'openai' } })).toEqual({
      kind: 'error',
      text: 'ModelNotFound',
      gateway: { provider: 'openai' },
    });
  });

  test('the send error gateway wins over the turn details', () => {
    const card = turnErrorCard({
      errorText: 'ignored',
      errorDetails: { provider: 'turn' },
      error: { kind: 'runtime-error', message: 'Boom', gateway: { provider: 'send' } },
    });
    expect(card).toEqual({ kind: 'error', text: 'Boom', gateway: { provider: 'send' } });
  });

  test('suggestion is dropped when it repeats the title', () => {
    expect(turnErrorSuggestion('Boom', { suggestion: 'Try again' })).toBe('Try again');
    expect(turnErrorSuggestion('Boom', { suggestion: 'Boom' })).toBeUndefined();
    expect(turnErrorSuggestion('Boom', undefined)).toBeUndefined();
  });
});

describe('compaction copy (web turn/compaction-card.tsx)', () => {
  test('labels', () => {
    expect(COMPACTION_LABEL_LOADING).toBe('Compacting context…');
    expect(COMPACTION_LABEL_DONE).toBe('Context automatically compacted');
    expect(compactionFailedLabel({ isAbort: true, error: 'x' })).toBe('Compaction stopped');
    expect(compactionFailedLabel({ error: 'boom' })).toBe('Compaction failed');
    expect(compactionFailedLabel({})).toBe('Compaction incomplete');
  });
});
