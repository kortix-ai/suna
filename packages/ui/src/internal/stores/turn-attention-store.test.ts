import { beforeEach, describe, expect, test } from 'bun:test';

import { useTurnAttentionStore } from './turn-attention-store';

/**
 * The favicon badge's source of truth: one entry per session with a finished
 * turn the user has not seen, dropped the moment that session comes into
 * view. sendWebNotification marks; TurnAttentionBadge clears.
 */

beforeEach(() => {
  useTurnAttentionStore.setState({ unseen: [] });
});

describe('turn-attention-store', () => {
  test('markTurnComplete records a session once, not per completion', () => {
    const { markTurnComplete } = useTurnAttentionStore.getState();

    markTurnComplete('s1');
    markTurnComplete('s1');
    markTurnComplete('s2');

    expect(useTurnAttentionStore.getState().unseen).toEqual(['s1', 's2']);
  });

  test('markSeen drops only the seen sessions', () => {
    useTurnAttentionStore.setState({ unseen: ['s1', 's2', 's3'] });

    useTurnAttentionStore.getState().markSeen(['s2']);

    expect(useTurnAttentionStore.getState().unseen).toEqual(['s1', 's3']);
  });

  test('markSeen with nothing seen changes nothing', () => {
    useTurnAttentionStore.setState({ unseen: ['s1'] });

    useTurnAttentionStore.getState().markSeen([]);

    expect(useTurnAttentionStore.getState().unseen).toEqual(['s1']);
  });
});
