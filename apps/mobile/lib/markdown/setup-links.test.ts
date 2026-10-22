import { describe, expect, test } from 'bun:test';
import {
  assistantSegments,
  holdStreamingLink,
  parseSetupLinkHref,
  splitSetupLinks,
  type SetupLinkSegment,
} from './setup-links';

const CONNECT = 'https://kortix.com/connect/ksl_abc-DEF_123';
const SECRET = 'https://kortix.com/secret-intake/ksl_zzz';
type Card = Extract<SetupLinkSegment, { type: 'setup' }>;
const card = (over: Partial<Card> = {}): Card => ({
  type: 'setup',
  kind: 'connector',
  token: 'ksl_abc-DEF_123',
  href: CONNECT,
  label: '',
  ...over,
});

describe('parseSetupLinkHref', () => {
  test('reads the kind and token of an agent-minted link', () => {
    expect(parseSetupLinkHref(CONNECT)).toEqual({ kind: 'connector', token: 'ksl_abc-DEF_123' });
    expect(parseSetupLinkHref(SECRET)).toEqual({ kind: 'secret', token: 'ksl_zzz' });
  });

  test('ignores every other link', () => {
    expect(parseSetupLinkHref('https://kortix.com/connect/not-a-token')).toBeNull();
    expect(parseSetupLinkHref('https://kortix.com/docs/connect/ksl_abc')).toBeNull();
    expect(parseSetupLinkHref('kortix://connect/ksl_abc')).toBeNull();
    expect(parseSetupLinkHref(undefined)).toBeNull();
  });
});

describe('splitSetupLinks', () => {
  test('text without a setup link is one markdown segment', () => {
    expect(splitSetupLinks('Hello [docs](https://kortix.com/docs).')).toEqual([
      { type: 'markdown', text: 'Hello [docs](https://kortix.com/docs).' },
    ]);
  });

  test('a markdown link, a bare URL, an autolink and inline code all become a card', () => {
    for (const written of [`[Connect GitHub](${CONNECT})`, CONNECT, `<${CONNECT}>`, `\`${CONNECT}\``]) {
      const [before, link, after] = splitSetupLinks(`Here you go:\n\n${written}\n\nTell me when done.`);
      expect(before).toEqual({ type: 'markdown', text: 'Here you go:' });
      expect(link).toMatchObject({ type: 'setup', kind: 'connector', token: 'ksl_abc-DEF_123', href: CONNECT });
      expect(after).toEqual({ type: 'markdown', text: 'Tell me when done.' });
    }
  });

  test('the link text is the label unless it is the URL', () => {
    expect(splitSetupLinks(`[Connect GitHub](${CONNECT})`)).toEqual([card({ label: 'GitHub' })]);
    expect(splitSetupLinks(`[${CONNECT}](${CONNECT})`)).toEqual([card()]);
    expect(splitSetupLinks(CONNECT)).toEqual([card()]);
  });

  test('a short label beside the link names the card and is dropped', () => {
    expect(splitSetupLinks(`- **GitHub**: [Connect](${CONNECT})`)).toEqual([card({ label: 'GitHub' })]);
  });

  test('outside a list or table the text beside the link stays', () => {
    expect(splitSetupLinks(`Connect here: ${CONNECT}.`)).toEqual([
      { type: 'markdown', text: 'Connect here:' },
      card(),
    ]);
    expect(splitSetupLinks(`## [Connect GitHub](${CONNECT})`)).toEqual([card({ label: 'GitHub' })]);
  });

  test('a table of app and link rows becomes a stack of cards, without its header', () => {
    const table = [
      'Connect these:',
      '',
      '| App | Link |',
      '| --- | --- |',
      `| GitHub | [Connect](${CONNECT}) |`,
      `| Slack | [Connect](${CONNECT}) |`,
    ].join('\n');
    expect(splitSetupLinks(table)).toEqual([
      { type: 'markdown', text: 'Connect these:' },
      card({ label: 'GitHub' }),
      card({ label: 'Slack' }),
    ]);
  });

  test('a table row that carries more than a label keeps its table', () => {
    const row = `| GitHub | [Connect](${CONNECT}) | Needed to read the repository and open pull requests |`;
    expect(splitSetupLinks(row)).toEqual([{ type: 'markdown', text: row }]);
  });

  test('a link inside a sentence splits the sentence around the card', () => {
    const sentence = `Please open [the GitHub link](${CONNECT}) and then tell me which repository to read.`;
    expect(splitSetupLinks(sentence)).toEqual([
      { type: 'markdown', text: 'Please open' },
      card({ label: 'the GitHub link' }),
      { type: 'markdown', text: 'and then tell me which repository to read.' },
    ]);
  });

  test('a link inside a code fence stays code', () => {
    const fenced = `\`\`\`\n${CONNECT}\n\`\`\``;
    expect(splitSetupLinks(fenced)).toEqual([{ type: 'markdown', text: fenced }]);
  });

  test('a secret link is a secret card', () => {
    expect(splitSetupLinks(`[Add your API key](${SECRET})`)).toEqual([
      { type: 'setup', kind: 'secret', token: 'ksl_zzz', href: SECRET, label: 'Add your API key' },
    ]);
  });
});

describe('streaming', () => {
  const pending = card({ token: null, href: null });

  test('a setup link whose URL is still arriving is a pending card', () => {
    expect(splitSetupLinks('[Connect GitHub](https://kortix.com/connect/ksl_ab', true)).toEqual([
      { ...pending, label: 'GitHub' },
    ]);
    expect(splitSetupLinks('[Connect GitHub](https://kortix.com/connect/ks', true)).toEqual([
      { ...pending, label: 'GitHub' },
    ]);
    expect(splitSetupLinks('[https://kortix.com/connect/ksl_ab', true)).toEqual([pending]);
  });

  test('a bare setup URL at the end of the stream is pending: its token may be cut', () => {
    const open = { type: 'markdown' as const, text: 'Open' };
    expect(splitSetupLinks(`Open ${CONNECT}`, true)).toEqual([open, pending]);
    expect(splitSetupLinks(`Open ${CONNECT}\n`, true)).toEqual([open, card()]);
    expect(splitSetupLinks(`Open ${CONNECT}`)).toEqual([open, card()]);
  });

  test('the pending card and the finished card are the same segment', () => {
    const live = splitSetupLinks(`Here:\n\n[Connect GitHub](${CONNECT.slice(0, -4)}`, true);
    const done = splitSetupLinks(`Here:\n\n[Connect GitHub](${CONNECT})`, true);
    expect(live.map((s) => s.type)).toEqual(done.map((s) => s.type));
  });

  test('any other link that is still arriving shows its label, never the raw URL', () => {
    expect(holdStreamingLink('See [the docs](https://kortix.com/do')).toBe('See [the docs](#)');
    expect(holdStreamingLink('See [the docs](https://kortix.com/docs)')).toBe(
      'See [the docs](https://kortix.com/docs)',
    );
    expect(holdStreamingLink('arr[0')).toBe('arr[0');
  });

  test('a settled message is never rewritten', () => {
    expect(splitSetupLinks('See [the docs](https://kortix.com/do')).toEqual([
      { type: 'markdown', text: 'See [the docs](https://kortix.com/do' },
    ]);
  });
});

describe('assistantSegments', () => {
  test('a bare URL in prose becomes a tappable link, as on web', () => {
    expect(assistantSegments('Repo created: https://github.com/acme/demo')).toEqual([
      { type: 'markdown', text: 'Repo created: [https://github.com/acme/demo](https://github.com/acme/demo)' },
    ]);
  });

  test('a URL that is already a link, or is code, is left as written', () => {
    const written = 'See [the repo](https://github.com/acme/demo) and `https://github.com/acme/demo`';
    expect(assistantSegments(written)).toEqual([{ type: 'markdown', text: written }]);
  });

  test('a bare setup URL is still its card, and the prose around it is linked', () => {
    expect(assistantSegments(`Docs at https://kortix.com/docs\n\n${CONNECT}`)).toEqual([
      { type: 'markdown', text: 'Docs at [https://kortix.com/docs](https://kortix.com/docs)' },
      card(),
    ]);
  });
});
