import { describe, expect, test } from 'bun:test';
import { parseChannelSendCommand, splitShellWords } from './channel-send';

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
