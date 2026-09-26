import { describe, expect, test } from 'bun:test';
import { parseChannelMessage } from './channel-message';

/**
 * The scaffolds below are copied from the API renderers that produce them:
 * apps/api/src/channels/slack/session.ts, teams/session.ts,
 * telegram-webhook.ts. If one of those changes shape, the matching case here
 * is what tells you the session view will fall back to the raw prompt.
 */

const TURN_INSTRUCTIONS = [
  'How to work:',
  '- First, load the `kortix-teams` skill via the `skill` tool for the canonical reference on posting in Teams (step/send semantics, Adaptive Cards, tone).',
  '- Deliver the final answer with `teams send` (text, or an Adaptive Card via --card-file). One `teams send` per turn — it finalizes the live message.',
].join('\n');

const TEAMS_FIRST = [
  "You're answering a message on Microsoft Teams as a teammate.",
  '',
  'Tenant:        36009a52-46d2-44bc-ba56-57a87e485e0a',
  'Conversation:  a:1FQyR2jW1pEUK_1d5ElylXF7Su1cgPbKpna',
  'User:          Ivan Bagaric',
  '',
  'Message:',
  'List the files in this repo and summarize the README',
  '',
  TURN_INSTRUCTIONS,
].join('\n');

const TEAMS_FOLLOW_UP = [
  'New message from Ivan Bagaric in the same Teams conversation:',
  '',
  'Now count the lines in the README',
  '',
  TURN_INSTRUCTIONS,
].join('\n');

const TEAMS_WITH_ATTACHMENT = [
  "You're answering a message on Microsoft Teams as a teammate.",
  '',
  'Tenant:        36009a52-46d2-44bc-ba56-57a87e485e0a',
  'Conversation:  19:abc@thread.tacv2',
  'User:          Marko',
  '',
  'Message:',
  'Summarize this',
  '',
  'Attached files (download with `teams download --url <url> --out <path>`):',
  '- report.pdf — https://kortixssotest-my.sharepoint.com/personal/x/report.pdf',
  '',
  TURN_INSTRUCTIONS,
].join('\n');

const SLACK_FIRST = [
  "You're answering a message on Slack as a teammate.",
  '',
  'Workspace:  T0AB12CD',
  'Channel:    C0DEV',
  'User:       U0IVAN',
  'Thread ts:  1789650000.000100',
  '',
  'Message:',
  '<@U0BOT> what changed in the last deploy?',
  '',
  'The user also attached files:',
  '  • deploy.log (text/plain, text, 12.0 KB)',
  '    Download: https://files.slack.com/files-pri/T0/deploy.log',
  '',
  'Use `slack download --url "<url>" --out <path>` to download each file.',
  '',
  'How to work:',
  '- Post progress with `slack step`.',
].join('\n');

const SLACK_REVIVED = [
  'NOTE: This Slack thread had an earlier conversation, but that session',
  'has ended — you do NOT have its history. Open your reply by briefly',
  'saying you are picking the thread back up without the earlier context.',
  '',
  "You're answering a message on Slack as a teammate.",
  '',
  'Workspace:  T0AB12CD',
  'Channel:    C0DEV',
  'User:       U0IVAN',
  '',
  'Message:',
  'still there?',
  '',
  'How to work:',
  '- Post progress with `slack step`.',
].join('\n');

const SLACK_FOLLOW_UP = [
  'New message from U0IVAN in the same Slack thread:',
  '',
  'and the one before that',
  '',
  'How to work:',
  '- Post progress with `slack step`.',
].join('\n');

const TELEGRAM = [
  'You received a message on Telegram.',
  '',
  'Chat:        -100123 (supergroup)',
  'From:        @ivan',
  'Message id:  42',
  '',
  'Message:',
  'ping from telegram',
  '',
  'To reply, run:',
  '  telegram send --chat -100123 --reply-to 42 --text "..."',
].join('\n');

describe('parseChannelMessage — Microsoft Teams', () => {
  test('first message: platform, sender, conversation, and the bare message text', () => {
    expect(parseChannelMessage(TEAMS_FIRST)).toEqual({
      platform: 'Teams',
      context: 'a:1FQyR2jW1pEUK_1d5ElylXF7Su1cgPbKpna',
      userName: 'Ivan Bagaric',
      messageText: 'List the files in this repo and summarize the README',
      followUp: false,
    });
  });

  test('follow-up in the same conversation keeps the sender and drops the instructions', () => {
    expect(parseChannelMessage(TEAMS_FOLLOW_UP)).toEqual({
      platform: 'Teams',
      context: '',
      userName: 'Ivan Bagaric',
      messageText: 'Now count the lines in the README',
      followUp: true,
    });
  });

  test('an attachment list is not part of the message text', () => {
    expect(parseChannelMessage(TEAMS_WITH_ATTACHMENT)?.messageText).toBe('Summarize this');
  });
});

describe('parseChannelMessage — Slack', () => {
  test('first message: the message stops before the attached-files block and the instructions', () => {
    expect(parseChannelMessage(SLACK_FIRST)).toEqual({
      platform: 'Slack',
      context: 'C0DEV',
      userName: 'U0IVAN',
      messageText: '<@U0BOT> what changed in the last deploy?',
      followUp: false,
    });
  });

  test('a revived thread (NOTE prefix) still parses', () => {
    expect(parseChannelMessage(SLACK_REVIVED)).toMatchObject({
      platform: 'Slack',
      userName: 'U0IVAN',
      messageText: 'still there?',
    });
  });

  test('follow-up in the same thread', () => {
    expect(parseChannelMessage(SLACK_FOLLOW_UP)).toEqual({
      platform: 'Slack',
      context: '',
      userName: 'U0IVAN',
      messageText: 'and the one before that',
      followUp: true,
    });
  });
});

describe('parseChannelMessage — Telegram', () => {
  test('message stops before the reply instructions', () => {
    expect(parseChannelMessage(TELEGRAM)).toEqual({
      platform: 'Telegram',
      context: '-100123 (supergroup)',
      userName: '@ivan',
      messageText: 'ping from telegram',
      followUp: false,
    });
  });
});

describe('parseChannelMessage — channel mentions', () => {
  test('the <at> markup Teams wraps around the bot name is not part of the message', () => {
    const md = TEAMS_FIRST.replace(
      'List the files in this repo and summarize the README',
      '<at>Kortix Dev</at>summarize the README in two sentences',
    );
    expect(parseChannelMessage(md)?.messageText).toBe('summarize the README in two sentences');
  });
});

describe('parseChannelMessage — legacy header and non-channel text', () => {
  test('the pre-2026 bracket header is still understood', () => {
    const legacy = '[Slack · #general · message from ivan]\nhello there\n\n── Slack instructions\nreply with slack send';
    expect(parseChannelMessage(legacy)).toEqual({
      platform: 'Slack',
      context: '#general',
      userName: 'ivan',
      messageText: 'hello there',
      followUp: false,
    });
  });

  test('an ordinary chat prompt is not a channel message', () => {
    expect(parseChannelMessage('List the files in this repo')).toBeUndefined();
    expect(parseChannelMessage('')).toBeUndefined();
    expect(parseChannelMessage('You received a package on the porch.')).toBeUndefined();
  });

  test('a message whose body mentions a platform is not mistaken for a scaffold', () => {
    expect(parseChannelMessage('Tell me about the Slack integration\n\nMessage:\nnot a scaffold')).toBeUndefined();
  });
});

// ── Linear-time parsing ──────────────────────────────────────────────────────
//
// Two regexes here were quadratic in the prompt: the pre-2026 header and the
// Teams `<at>` markup strip. Channel text comes from anyone who can post in the
// channel, and every viewer of the session parses it. The regex version of
// the parser is kept here ONLY as a parity oracle.
const legacyParse = (() => {
  const TAIL = [/^How to work:/m, /^Attached files \(download with/m, /^The user also attached files:/m, /^To reply, run:/m,
    /^Agent CLIs are installed in/m, /^── (?:Slack|Teams|Telegram) instructions/m, /^Chat ID:/m];
  const strip = (v: string) => v.replace(/<at[^>]*>.*?<\/at>/gi, ' ').replace(/&nbsp;/gi, ' ').replace(/[ \t]+/g, ' ').trim();
  const cut = (text: string) => {
    let end = text.length;
    for (const marker of TAIL) {
      const m = marker.exec(text);
      if (m && m.index < end) end = m.index;
    }
    return strip(text.slice(0, end));
  };
  const field = (block: string, label: string) => new RegExp(`^${label}:\\s*(.*)$`, 'm').exec(block)?.[1]?.trim() ?? '';
  const body = (block: string) => {
    const m = /^Message:\r?\n/m.exec(block);
    return m ? cut(block.slice(m.index + m[0].length)) : null;
  };
  const opens = (text: string, i: number) => {
    const before = text.slice(0, i).trim();
    return before === '' || before.startsWith('NOTE:');
  };
  const FIRST = [
    { platform: 'Teams', header: /^You're answering a message on Microsoft Teams as a teammate\.$/m, context: 'Conversation', user: 'User' },
    { platform: 'Slack', header: /^You're answering a message on Slack as a teammate\.$/m, context: 'Channel', user: 'User' },
    { platform: 'Telegram', header: /^You received a message on Telegram\.$/m, context: 'Chat', user: 'From' },
  ];
  const FOLLOW = [
    { platform: 'Teams', header: /^New message from (.+?) in the same Teams conversation:$/m },
    { platform: 'Slack', header: /^New message from (.+?) in the same Slack thread:$/m },
  ];
  return (rawText: string) => {
    const text = (rawText ?? '').trim();
    if (!text) return undefined;
    const legacy = /^\[(\w+)\s*·\s*([^·]+?)\s*·\s*message from\s+([^\]]+)\]\s*/.exec(text);
    if (legacy) {
      const platform = legacy[1] === 'Teams' ? 'Teams' : legacy[1] === 'Telegram' ? 'Telegram' : 'Slack';
      return { platform, context: legacy[2]!.trim(), userName: legacy[3]!.trim(), messageText: cut(text.slice(legacy[0].length)), followUp: false };
    }
    for (const shape of FIRST) {
      const m = shape.header.exec(text);
      if (!m || !opens(text, m.index)) continue;
      const block = text.slice(m.index + m[0].length);
      const b = body(block);
      if (b === null) continue;
      return { platform: shape.platform, context: field(block, shape.context), userName: field(block, shape.user) || 'unknown', messageText: b, followUp: false };
    }
    for (const shape of FOLLOW) {
      const m = shape.header.exec(text);
      if (!m || !opens(text, m.index)) continue;
      return { platform: shape.platform, context: '', userName: m[1]!.trim(), messageText: cut(text.slice(m.index + m[0].length)), followUp: true };
    }
    return undefined;
  };
})();

/** Deterministic PRNG (mulberry32), so a failing case reproduces. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('parseChannelMessage returns exactly what the regex version returned', () => {
  test('on 3000 random channel-shaped prompts', () => {
    const tokens = ['[Slack · #general · message from a]', '[Teams', '[Telegram·', '[', ']', 'Slack', '·', ' · ', ' ', '\t',
      'message from', ' message from ', 'x', '\n', '\r', '<at>', '</at>', '<AT id="1">', '</At>', '<attachment>', '<at', '>',
      '&nbsp;', "You're answering a message on Slack as a teammate.", '\nUser: b\n', '\nMessage:\n', 'How to work:',
      'New message from c in the same Slack thread:', 'NOTE: revived\n'];
    const next = random(47);
    let parsed = 0;
    for (let i = 0; i < 3000; i++) {
      let text = next() < 0.5 ? '[Slack · #general · message from a]' : '';
      const length = Math.floor(next() * 16);
      for (let j = 0; j < length; j++) text += tokens[Math.floor(next() * tokens.length)];
      const expected = legacyParse(text);
      expect(parseChannelMessage(text)).toEqual(expected as never);
      if (expected) parsed++;
    }
    expect(parsed).toBeGreaterThan(600);
  });

  test('on 3000 random pre-2026 headers', () => {
    const next = random(53);
    const pick = (options: readonly string[]) => options[Math.floor(next() * options.length)]!;
    const some = (options: readonly string[], max: number) =>
      Array.from({ length: Math.floor(next() * (max + 1)) }, () => pick(options)).join('');
    let parsed = 0;
    for (let i = 0; i < 3000; i++) {
      // Mostly well-formed, with each part sometimes empty, doubled, or missing.
      const text =
        `[${pick(['Slack', 'Teams', 'Telegram', 'x1', ''])}${some([' ', '\t'], 2)}${pick(['·', '·', '·', ''])}` +
        `${some(['a', 'a', ' ', '\t', '#g', '·'], 3)}${pick(['·', '·', '·', ''])}${some([' ', '\n'], 2)}message from` +
        `${pick([' ', ' ', '\t', '', 'x'])}${some(['b', 'b', ' ', '\t', '\n', '·', ']'], 3)}${pick([']', ']', '] ', ']\n', ''])}` +
        `${some(['hi', ' ', '<at>x</at>', '\n'], 3)}`;
      const expected = legacyParse(text);
      expect(parseChannelMessage(text)).toEqual(expected as never);
      if (expected) parsed++;
    }
    expect(parsed).toBeGreaterThan(200);
  });
});

describe('no channel message can freeze the tab that parses it', () => {
  const within = (label: string, run: () => unknown) =>
    test(label, () => {
      const started = performance.now();
      run();
      expect(performance.now() - started).toBeLessThan(100);
    });

  // Each took ~1.4 s at 60k characters with Bun, and quadrupled per doubling.
  within('a legacy header whose context holds 240k spaces', () => parseChannelMessage(`[Slack·a${' '.repeat(240_000)}x`));
  within('a legacy header whose sender holds 240k spaces', () =>
    parseChannelMessage(`[Slack·a·message from${' '.repeat(240_000)}x`));
  // 0.4 s at 60k characters.
  within('60k <at openers that never close', () => parseChannelMessage(`[Slack · c · message from a] ${'<at>'.repeat(60_000)}`));
  within('80k <at openers and no >', () => parseChannelMessage(`[Slack · c · message from a] ${'<at'.repeat(80_000)}`));
  within('60k <at> openers, each on its own line', () =>
    parseChannelMessage(`[Slack · c · message from a] ${'<at>\n'.repeat(48_000)}</at>`));
});
