import { describe, expect, test } from 'bun:test';
import { addressesOnlyPeople } from './space-posts';

const ADA = '00000000-0000-4000-8000-00000000000a';
const BEN = '00000000-0000-4000-8000-00000000000b';
const people = [
  { userId: ADA, displayName: 'Ada Test', email: 'ada@example.test' },
  { userId: BEN, displayName: 'Ben Test', email: 'ben@example.test' },
];

describe('a message that @mentions only people is for them, not for the agent', () => {
  test('people by email, by name slug, or by email local part: only people', () => {
    expect(addressesOnlyPeople('@ben@example.test how are you', people, ADA)).toBe(true);
    expect(addressesOnlyPeople('@ben-test can you check this?', people, ADA)).toBe(true);
    expect(addressesOnlyPeople('@ben and @ada@example.test, lunch?', people, '00000000-0000-4000-8000-0000000000ff')).toBe(true);
  });

  test('no mention, @all/@here, the author, an agent or an unknown name: the agent answers', () => {
    expect(addressesOnlyPeople('how are you', people, ADA)).toBe(false);
    expect(addressesOnlyPeople('@here standup in 5', people, ADA)).toBe(false);
    expect(addressesOnlyPeople('@ada note to self', people, ADA)).toBe(false);
    expect(addressesOnlyPeople('@ben @kortix summarize this for Ben', people, ADA)).toBe(false);
    expect(addressesOnlyPeople('@researcher find flights', people, ADA)).toBe(false);
  });
});
