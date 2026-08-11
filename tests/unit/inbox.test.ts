import { describe, expect, it } from 'vitest';

import { mailpitMessageIsRecent } from '../e2e/helpers/inbox';

describe('Mailpit inbox timestamp filtering', () => {
  const requestStartedAt = new Date('2026-08-11T01:52:37.500Z');

  it('accepts the matching recipient message across a small clock boundary', () => {
    expect(mailpitMessageIsRecent('2026-08-11T01:52:37.149Z', requestStartedAt)).toBe(true);
  });

  it('rejects an older message outside the bounded tolerance', () => {
    expect(mailpitMessageIsRecent('2026-08-11T01:52:31.000Z', requestStartedAt)).toBe(false);
  });
});
