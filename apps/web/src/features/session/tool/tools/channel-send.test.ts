import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { channelSendText, parseChannelSendCommand, splitShellWords } from './channel-send';

/**
 * The commands below are the shapes the sandbox CLIs document and the agent
 * actually wrote on dev (2026-09-18): `teams send 'Anything else I can help
 * with?'` rendered as a shell call with `{"ok":true,"delivered":"stream"}`
 * under it, while Teams showed the sentence. The session view should show the
 * sentence too.
 */

describe('splitShellWords', () => {
  test('single quotes are literal, double quotes honour escapes, $\'…\' decodes', () => {
    expect(splitShellWords(`teams send 'it''s' "a \\"quoted\\" word" $'line1\\nline2'`)).toEqual([
      'teams',
      'send',
      'its',
      'a "quoted" word',
      'line1\nline2',
    ]);
  });

  test('an unterminated quote is refused', () => {
    expect(splitShellWords(`teams send "oops`)).toBeNull();
  });
});

describe('parseChannelSendCommand', () => {
  test('teams send with a positional message', () => {
    expect(parseChannelSendCommand(`teams send 'Anything else I can help with?'`)).toEqual({
      platform: 'Teams',
      text: 'Anything else I can help with?',
      file: null,
      channel: null,
    });
  });

  test('slack send with --text and a --channel target', () => {
    expect(parseChannelSendCommand(`slack send --channel C0DEV --thread 1789.1 --text "Deploy is green"`)).toEqual({
      platform: 'Slack',
      text: 'Deploy is green',
      file: null,
      channel: 'C0DEV',
    });
  });

  test('telegram send with --chat/--reply-to noise and --text=inline', () => {
    expect(parseChannelSendCommand(`telegram send --chat -100123 --reply-to 42 --text="ping back"`)).toEqual({
      platform: 'Telegram',
      text: 'ping back',
      file: null,
      channel: null,
    });
  });

  test('a file send keeps the basename and the caption', () => {
    expect(parseChannelSendCommand(`teams send --file /workspace/out/report.pdf --text "Here is the report"`)).toEqual({
      platform: 'Teams',
      text: 'Here is the report',
      file: 'report.pdf',
      channel: null,
    });
    expect(parseChannelSendCommand(`slack send --file ./chart.png`)?.file).toBe('chart.png');
  });

  test('a full path to the CLI and a leading env assignment are still a send', () => {
    expect(parseChannelSendCommand(`KORTIX_DEBUG=1 /usr/local/bin/teams send "hi"`)?.text).toBe('hi');
  });

  test('multi-line text via $\'…\' keeps its line breaks', () => {
    expect(parseChannelSendCommand(`teams send $'Done.\\n\\n- one\\n- two'`)?.text).toBe('Done.\n\n- one\n- two');
  });

  // A reply that mentioned someone or linked something rendered as a raw
  // `slack send …` command (2026-10-02): the operator check read the quoted
  // text, and every Slack mention is `<@U…|Name>`. Only an operator the shell
  // would act on composes a command.
  test('Slack markup inside quotes is the message, not a shell operator', () => {
    expect(
      parseChannelSendCommand(
        `slack send --channel C0DEV --thread 1.1 --text "Thanks <@U0TEST1|Sam> & see <https://example.test|docs> (deploy 42); done"`,
      ),
    ).toEqual({
      platform: 'Slack',
      text: 'Thanks <@U0TEST1|Sam> & see <https://example.test|docs> (deploy 42); done',
      file: null,
      channel: 'C0DEV',
    });
    expect(parseChannelSendCommand(`slack send --text 'a <b> | c && d'`)?.text).toBe('a <b> | c && d');
    expect(parseChannelSendCommand(`slack send --text $'a <b>\\n(c)'`)?.text).toBe('a <b>\n(c)');
  });

  test('an operator outside quotes, or a substitution inside double quotes, is still a composed command', () => {
    expect(parseChannelSendCommand(`teams send "hi" > /tmp/out`)).toBeNull();
    expect(parseChannelSendCommand(`teams send "a"|cat`)).toBeNull();
    expect(parseChannelSendCommand(`teams send hi;rm -f x`)).toBeNull();
    expect(parseChannelSendCommand(`teams send "$(cat body.md)"`)).toBeNull();
    expect(parseChannelSendCommand('teams send "`cat body.md`"')).toBeNull();
    expect(parseChannelSendCommand(`teams send (hi)`)).toBeNull();
  });

  test('not a send: other subcommands, other CLIs, composed commands, --text-file bodies', () => {
    expect(parseChannelSendCommand(`teams step "Reading the README"`)).toBeNull();
    expect(parseChannelSendCommand(`git send-email`)).toBeNull();
    expect(parseChannelSendCommand(`teams send "hi" && echo done`)).toBeNull();
    expect(parseChannelSendCommand(`cat body.md | teams send`)).toBeNull();
    expect(parseChannelSendCommand(`teams send --text-file /tmp/answer.md`)).toBeNull();
    expect(parseChannelSendCommand(`teams send`)).toBeNull();
    expect(parseChannelSendCommand(`teams send "a"\nteams send "b"`)).toBeNull();
  });
});

// Every Slack follow-up reply showed `Slack · C0…` under the agent's answer
// (2026-10-02): the card printed the `--channel` id it was given. It now names
// the conversation from the project's bindings and renders Slack markup.
describe('ChannelSendCard', () => {
  const card = readFileSync(join(import.meta.dir, 'channel-send-card.tsx'), 'utf8');

  test("names the Slack conversation from the project's bindings, the id only as a fallback", () => {
    expect(card).toContain('useChannelBindings(');
    expect(card).toContain('slackConversationName(');
    expect(card).toContain("useParams<{ id?: string }>()");
  });

  test('the card and its collapsed row show one text: the reply as Slack shows it', () => {
    const bash = readFileSync(join(import.meta.dir, 'bash-tool.tsx'), 'utf8');
    expect(card).toContain('channelSendText(send)');
    expect(bash).toContain('const sendText = send ? channelSendText(send) : null;');
    expect(bash).toContain('sendText ?? send.file');
  });
});

describe('channelSendText', () => {
  test('a Slack reply reads as Slack shows it; another platform keeps its text', () => {
    expect(
      channelSendText({ platform: 'Slack', text: 'ship it <@U0TEST1|Sam> &amp; <#C0TEST1|ops>', file: null, channel: 'C0TEST1' }),
    ).toBe('ship it @Sam & #ops');
    expect(channelSendText({ platform: 'Teams', text: 'a <b>c</b>', file: null, channel: null })).toBe('a <b>c</b>');
  });

  test('a bare file send has no text', () => {
    expect(channelSendText({ platform: 'Slack', text: null, file: 'report.pdf', channel: null })).toBeNull();
  });
});
