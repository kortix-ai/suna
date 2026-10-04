import { describe, expect, test } from 'bun:test';
import { mentionsUser } from '../services/channels/slack/util';

// The predicate both mention gates route on. It decides "was I the one
// addressed", so it has two ways to be wrong and they cost opposite things:
// a false NO makes the bot ignore a real mention (silence, #6590's shape), and
// a false YES lets one project answer for another (the 2026-08-20 wrong-bot
// reply this predicate was extracted for).
describe('mentionsUser', () => {
  test('the plain render', () => {
    expect(mentionsUser('<@U0TESTKRTX1> hey man', 'U0TESTKRTX1')).toBe(true);
  });

  test('the <@ID|label> render Slack still emits', () => {
    expect(mentionsUser('<@U0TESTKRTX1|kortix> hey', 'U0TESTKRTX1')).toBe(true);
  });

  test('a different bot in the same message is not us', () => {
    expect(mentionsUser('<@U0TESTKRTX1> hey man', 'U0TESTOTHR1')).toBe(false);
  });

  test('mentioned among others', () => {
    expect(mentionsUser('cc <@UAAA> and <@UBBB>', 'UBBB')).toBe(true);
  });

  // A prefix must not match a longer id, or every project whose bot id starts
  // with another's would answer for it.
  test('a prefix of a longer id is not a match', () => {
    expect(mentionsUser('<@U0TESTKRTX1> hi', 'U0TESTKRTX')).toBe(false);
  });

  test('the bare id without Slack’s wrapper is not a mention', () => {
    expect(mentionsUser('talk to U0TESTKRTX1 about it', 'U0TESTKRTX1')).toBe(false);
  });

  test('an empty or malformed id never matches', () => {
    expect(mentionsUser('<@U0TESTKRTX1> hi', '')).toBe(false);
    // Regex metacharacters must not be able to widen the pattern into a wildcard.
    expect(mentionsUser('<@U0TESTKRTX1> hi', '.*')).toBe(false);
    expect(mentionsUser('<@U0TESTKRTX1> hi', 'U0TESTKRTX1|X')).toBe(false);
  });
});
