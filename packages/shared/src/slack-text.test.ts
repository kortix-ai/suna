import { describe, expect, test } from 'bun:test';
import { readSlackFollowUpHeader, slackFollowUpHeader, slackPlainText } from './slack-text';

describe('slackPlainText', () => {
  test('renders mentions, channels, broadcasts, links and escapes; leaves other markup', () => {
    expect(
      slackPlainText(
        '<@U0BOT|Kortix> see <#C0OPS|ops> <!channel> <https://example.test|docs> <mailto:a@example.test> a &lt;b&gt; &amp; <foo>',
      ),
    ).toBe('@Kortix see #ops @channel docs mailto:a@example.test a <b> & <foo>');
  });

  test('an unlabelled mention keeps its id', () => {
    expect(slackPlainText('ask <@U0TEST2>')).toBe('ask @U0TEST2');
  });

  test('a user group and a date show their label', () => {
    expect(slackPlainText('<!subteam^S0TEAM|@oncall> by <!date^1700000000^{date}|Nov 14>')).toBe('@oncall by Nov 14');
    expect(slackPlainText('<!here>')).toBe('@here');
  });

  test('a stray > or an unclosed < is text', () => {
    expect(slackPlainText('a > b <@U0X')).toBe('a > b <@U0X');
    expect(slackPlainText('<<@U0X|Sam>')).toBe('<@Sam');
  });
});

// Every viewer of a session parses its channel messages, and anyone in the
// channel writes them.
describe('no Slack text can freeze the tab that renders it', () => {
  const within = (label: string, run: () => unknown) =>
    test(label, () => {
      const started = performance.now();
      run();
      expect(performance.now() - started).toBeLessThan(100);
    });

  within('120k > and no <', () => slackPlainText('>'.repeat(120_000)));
  within('120k text-then-> pairs and no <', () => slackPlainText('a>'.repeat(120_000)));
  within('one < before 120k >', () => slackPlainText(`<${'>'.repeat(120_000)}`));
  within('80k < openers and no >', () => slackPlainText('<@U0'.repeat(80_000)));
  within('60k nested < openers before one >', () => slackPlainText(`${'<'.repeat(60_000)}@U0>`));
  within('60k complete mentions', () => slackPlainText('<@U0X|Sam> '.repeat(60_000)));
});

// The API wrote one follow-up header and the web read another (2026-09-30 to
// 2026-10-02): #8522 changed the renderer, the parser kept the old pattern,
// and every Slack follow-up in a session showed the raw prompt. Both sides now
// call this pair.
describe('the Slack follow-up header', () => {
  test('reads back what it writes, labelled or bare', () => {
    const labelled = slackFollowUpHeader('Sam Rivera (U0TEST1)', '#general (C0TEST1)', '1789650000.000100');
    expect(labelled).toBe('New message from Sam Rivera (U0TEST1) in Slack channel #general (C0TEST1), thread 1789650000.000100:');
    expect(readSlackFollowUpHeader(labelled)).toEqual({
      user: 'Sam Rivera (U0TEST1)',
      channel: '#general (C0TEST1)',
      threadTs: '1789650000.000100',
    });
    expect(readSlackFollowUpHeader(slackFollowUpHeader('U0TEST1', 'C0TEST1', '1.2'))).toEqual({
      user: 'U0TEST1',
      channel: 'C0TEST1',
      threadTs: '1.2',
    });
  });

  test('a display name holding the separators stays the sender', () => {
    const header = slackFollowUpHeader('a in Slack channel b, thread c', 'Direct message (D0TEST1)', '1.2');
    expect(readSlackFollowUpHeader(header)).toEqual({
      user: 'a in Slack channel b, thread c',
      channel: 'Direct message (D0TEST1)',
      threadTs: '1.2',
    });
  });

  test('any other line is not a header', () => {
    expect(readSlackFollowUpHeader('New message from U0TEST1 in the same Slack thread:')).toBeNull();
    expect(readSlackFollowUpHeader('hello')).toBeNull();
  });
});
