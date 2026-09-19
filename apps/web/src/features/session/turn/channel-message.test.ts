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
