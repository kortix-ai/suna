import { describe, expect, test } from 'bun:test';
import { mentionTokens, mentionsMember } from './mentions';

const session = { ids: ['3f2a1b9c-1111-4222-8333-444455556666'], names: ['builder', 'Fix CI'] };
const person = { ids: ['7c1d2e3f-aaaa-4bbb-8ccc-dddddddddddd'], names: [] };

describe('mentions', () => {
  test('an 8+ char id prefix, the agent, the session name slug and @all name a member', () => {
    expect(mentionsMember(mentionTokens('@3f2a1b9c did you stop dev?'), session)).toBe(true);
    expect(mentionsMember(mentionTokens('ping @builder'), session)).toBe(true);
    expect(mentionsMember(mentionTokens('ping @fix-ci'), session)).toBe(true);
    expect(mentionsMember(mentionTokens('@all deploy is red'), session)).toBe(true);
    expect(mentionsMember(mentionTokens('@7c1d2e3f can I drop it?'), person)).toBe(true);
  });

  test('a person is named by email or display name', () => {
    const ada = { ids: ['7c1d2e3f-aaaa-4bbb-8ccc-dddddddddddd'], names: ['ada@example.test', 'Ada Lovelace'] };
    expect(mentionsMember(mentionTokens('@ada@example.test may I drop it?'), ada)).toBe(true);
    expect(mentionsMember(mentionTokens('thanks @ada-lovelace.'), ada)).toBe(true);
    expect(mentionsMember(mentionTokens('@bob@example.test'), ada)).toBe(false);
  });

  test('a short id prefix, another agent and an email address do not', () => {
    expect(mentionsMember(mentionTokens('@3f2a who?'), session)).toBe(false);
    expect(mentionsMember(mentionTokens('@reviewer look'), session)).toBe(false);
    expect(mentionsMember(mentionTokens('mail ops@builder.dev'), session)).toBe(false);
  });
});
