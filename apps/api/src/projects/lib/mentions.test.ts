import { describe, expect, test } from 'bun:test';
import { mentionTokens } from './mentions';

describe('mentionTokens', () => {
  test('an id prefix, an agent, a name slug, @all and an email are lowercased tokens', () => {
    expect([...mentionTokens('@3F2A1B9C ping @Builder and @fix-ci, @all: mail @ada@example.test.')])
      .toEqual(['3f2a1b9c', 'builder', 'fix-ci', 'all', 'ada@example.test']);
  });

  test('an email address in the text is not a mention', () => {
    expect(mentionTokens('mail ops@builder.dev').size).toBe(0);
  });
});
