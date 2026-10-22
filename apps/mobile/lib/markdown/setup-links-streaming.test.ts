import { beforeAll, describe, expect, mock, test } from 'bun:test';
import * as sharedUtils from '@kortix/shared/utils';

/**
 * `autoLinkGrowing` must return exactly `autoLinkUrls(text)` for every text,
 * and link each streamed character about once instead of once per tick.
 * The oracle is the real `autoLinkUrls` from `@kortix/shared/utils`; the module
 * under test sees a counting wrapper of the same function.
 */
const realAutoLink = sharedUtils.autoLinkUrls;
let linkedChars = 0;
mock.module('@kortix/shared', () => ({
  ...sharedUtils,
  autoLinkUrls: (text: string) => {
    linkedChars += text.length;
    return realAutoLink(text);
  },
}));

let autoLinkGrowing: typeof import('./setup-links').autoLinkGrowing;
let assistantSegments: typeof import('./setup-links').assistantSegments;
let splitSetupLinks: typeof import('./setup-links').splitSetupLinks;

beforeAll(async () => {
  ({ autoLinkGrowing, assistantSegments, splitSetupLinks } = await import('./setup-links'));
});

/** Documents with every construct `autoLinkUrls` protects, split across lines and blocks. */
const CORPUS: Record<string, string> = {
  plain: 'See https://kortix.com/docs and www.example.com, mail me at dev@kortix.com.\n\nNext para github.com/kortix/suna\n',
  fences:
    'Run this:\n\n```bash\ncurl https://api.example.com/v1 # not linked\n```\n\nThen visit https://example.com.\n\n````md\n```\nhttps://inner.example.com\n```\n````\nafter https://after.example.com\n',
  unclosedFence: 'Intro https://a.example.com\n\n```ts\nconst url = "https://in-code.example.com";\nmore code\n',
  inlineCode: 'Use `https://code.example.com` or `npm i` then https://real.example.com\n`unclosed https://x.example.com\nnext line https://y.example.com\n',
  displayMath: 'Math:\n\n$$\nf(x) = https://not.example.com\n$$\n\nand $$inline https://z.example.com$$ text\n\n$$\nunclosed https://m.example.com\n',
  inlineMath: 'Cost $5 and $x + y$ with https://cost.example.com and \\$ escaped $a$ https://b.example.com\n',
  links:
    '[Kortix](https://kortix.com) and [multi\nline label](https://multi.example.com) and [label\n\nwith blank](https://blank.example.com)\n[open label https://open.example.com\n\nlater https://later.example.com\n',
  openDestination: 'Here [docs](https://docs.example.com/very/long/path\n\nand https://next.example.com\n',
  multilineDestination: 'A [label](first\nhttps://inside.example.com) after https://after.example.com\n',
  references: '[ref]: https://ref.example.com\n  [ref2]: https://ref2.example.com\n\nText [a][ref] https://text.example.com\n',
  angle: '<https://angle.example.com> and <mailto:dev@kortix.com> and <https://broken\n> https://after.example.com\n',
  lists: '- item https://one.example.com\n- item [two](https://two.example.com)\n  - nested www.three.com\n\n1. first dev@kortix.com\n2. second\n',
  tables: '| Name | Link |\n|---|---|\n| a | https://a.example.com |\n| b | [b](https://b.example.com) |\n\nafter table https://c.example.com\n',
  images: '![alt](https://img.example.com/a.png)\n\n![one](https://i.example.com/1.png) ![two](https://i.example.com/2.png)\n\ntext https://t.example.com\n',
  localhost: 'App at http://localhost:3000/app and http://127.0.0.1:8080\n\n```\ncurl http://localhost:5173\n```\n',
  setupLinks:
    'Connect here:\n\n- Gmail: https://kortix.com/connect/ksl_abcdef123\n- [Slack](https://kortix.com/connect/ksl_slack456)\n\nThen https://after.example.com\n',
  crlf: 'Line one https://crlf.example.com\r\n\r\n```\r\nhttps://code.example.com\r\n```\r\nend https://end.example.com\r\n',
  htmlBlock:
    '<div align="center">\n  <img src="https://img.example.com/a.png">\n  https://inside.example.com\n</div>\n\nafter https://after.example.com\n',
  referenceAfterUse: 'See [the docs][docs] and https://x.example.com\n\nMore text\n\n[docs]: https://docs.example.com\n',
  brackets: 'a ] b [ c ]( d ) e [f](g h [ i https://x.example.com\n\n] https://y.example.com ) [z](https://z.example.com)\n',
};

/** Streams `text` in chunks of `step` characters and checks every prefix. */
function expectGrowingEqualsFull(text: string, step = 1) {
  for (let end = 0; end <= text.length; end += step) {
    const prefix = text.slice(0, end);
    expect(autoLinkGrowing(prefix)).toBe(realAutoLink(prefix));
  }
  expect(autoLinkGrowing(text)).toBe(realAutoLink(text));
}

describe('autoLinkGrowing equals autoLinkUrls on every streamed prefix', () => {
  for (const [name, text] of Object.entries(CORPUS)) {
    test(name, () => {
      expectGrowingEqualsFull(text);
      // Repeated: the document grows again on a warm cache.
      expectGrowingEqualsFull(text + text, 3);
    });
  }

  test('the whole corpus as one reply', () => {
    expectGrowingEqualsFull(Object.values(CORPUS).join('\n'), 2);
  });

  test('switching between texts never reuses a prefix that does not match', () => {
    const a = CORPUS.links;
    const b = CORPUS.fences;
    for (let end = 0; end <= Math.max(a.length, b.length); end += 5) {
      expect(autoLinkGrowing(a.slice(0, end))).toBe(realAutoLink(a.slice(0, end)));
      expect(autoLinkGrowing(b.slice(0, end))).toBe(realAutoLink(b.slice(0, end)));
    }
    // A text that shares a prefix and then diverges.
    expect(autoLinkGrowing('same start\nhttps://a.example.com\n')).toBe(realAutoLink('same start\nhttps://a.example.com\n'));
    expect(autoLinkGrowing('same start\n[x](https://b.example.com)\n')).toBe(
      realAutoLink('same start\n[x](https://b.example.com)\n'),
    );
  });

  test('random text from the protected-range alphabet', () => {
    const pieces = [
      '`', '```', '$', '$$', '[', ']', '(', ')', '](', '<', '>', '<https://', '<mailto:', '\\', '\n', '\n\n', ' ',
      'https://a.example.com', 'www.b.com', 'c.io/d', 'e@f.co', 'word', '[r]: ', '~~~', '|', '- ', '1. ', '\r\n',
    ];
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let doc = 0; doc < 300; doc += 1) {
      let text = '';
      const length = 5 + random(60);
      for (let i = 0; i < length; i += 1) text += pieces[random(pieces.length)];
      expectGrowingEqualsFull(text, 1 + random(6));
    }
  });
});

describe('assistantSegments', () => {
  const oracle = (text: string, streaming: boolean) =>
    splitSetupLinks(text, streaming).map((segment) =>
      segment.type === 'markdown' ? { ...segment, text: realAutoLink(segment.text) } : segment,
    );

  test('equals splitSetupLinks plus autoLinkUrls on every streamed prefix', () => {
    for (const text of Object.values(CORPUS)) {
      for (let end = 0; end <= text.length; end += 1) {
        const prefix = text.slice(0, end);
        expect(assistantSegments(prefix, true)).toEqual(oracle(prefix, true));
      }
      expect(assistantSegments(text, false)).toEqual(oracle(text, false));
    }
  });

  test('texts that stream side by side each keep their own saved prefix', () => {
    const a = CORPUS.plain.repeat(30);
    const b = CORPUS.lists.repeat(30);
    const c = CORPUS.tables.repeat(30);
    let ticks = 0;
    linkedChars = 0;
    for (let end = 20; end <= a.length; end += 20) {
      // One reply with several segments renders all of them every tick.
      for (const text of [a, b, c]) {
        const prefix = text.slice(0, end);
        expect(autoLinkGrowing(prefix)).toBe(realAutoLink(prefix));
      }
      ticks += 1;
    }
    const fullPassChars = (ticks * (a.length + b.length + c.length)) / 2;
    expect(linkedChars).toBeLessThan(fullPassChars / 10);
  });

  test('a long streamed reply links each character about once, not once per tick', () => {
    const reply = Object.values(CORPUS)
      .filter((text) => !text.includes('/connect/'))
      .join('\n')
      .repeat(8);
    // Close the corpus's deliberately open constructs, so the reply has safe cuts.
    const closed = `${reply}\n\`\`\`\n$$\n] )\n\n`;
    const step = 40;
    let ticks = 0;
    linkedChars = 0;
    for (let end = step; end <= closed.length; end += step) {
      assistantSegments(closed.slice(0, end), true);
      ticks += 1;
    }
    // A full pass per tick would link about ticks * length / 2 characters.
    const fullPassChars = (ticks * closed.length) / 2;
    expect(linkedChars).toBeLessThan(fullPassChars / 10);
  });
});
