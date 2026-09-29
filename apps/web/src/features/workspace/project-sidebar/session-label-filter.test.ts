import type { ProjectSession } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { matchesLabelFilters } from './session-label-filter';

describe('session label filter', () => {
  test('empty selection includes unlabeled sessions and selected labels match any', () => {
    const session = { labels: ['alpha', 'beta'] } as ProjectSession;
    expect(matchesLabelFilters(session, [])).toBe(true);
    expect(matchesLabelFilters({} as ProjectSession, ['alpha'])).toBe(false);
    expect(matchesLabelFilters(session, ['other', 'beta'])).toBe(true);
    expect(matchesLabelFilters(session, ['other'])).toBe(false);
  });
});
