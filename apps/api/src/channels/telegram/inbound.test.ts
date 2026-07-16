import { describe, expect, test } from 'bun:test';
import {
  TELEGRAM_GROUP_WELCOME_PRIVACY_TEXT,
  TELEGRAM_GROUP_WELCOME_TEXT,
  type TelegramMessage,
  botJustAddedToGroup,
  describeAttachments,
  messageAttachments,
  parseTelegramCommand,
  renderTelegramAgentPrompt,
  renderTelegramFollowUpPrompt,
  renderTelegramStatus,
  shouldRespondInChat,
  stripBotMention,
  telegramGroupWelcomeText,
} from './inbound';

const BOT = 'KortixBot';
const BOT_ID = '1234567890';

function msg(over: Partial<TelegramMessage> & { chatType?: string } = {}): TelegramMessage {
  const { chatType, ...rest } = over;
  return {
    message_id: 42,
    chat: { id: -100123, type: chatType ?? 'private' },
    from: { id: 777, username: 'ivan' },
    text: 'hello there',
    ...rest,
  };
}

describe('parseTelegramCommand', () => {
  test('parses the known commands, case-insensitive, with args', () => {
    expect(parseTelegramCommand('/new', BOT)).toEqual({ command: 'new', args: '' });
    expect(parseTelegramCommand('/HELP', BOT)).toEqual({ command: 'help', args: '' });
    expect(parseTelegramCommand('/start deep link', BOT)).toEqual({
      command: 'start',
      args: 'deep link',
    });
  });

  test('group-addressed form: ours parses, another bot’s is ignored', () => {
    expect(parseTelegramCommand(`/new@${BOT}`, BOT)).toEqual({ command: 'new', args: '' });
    expect(parseTelegramCommand('/new@kortixbot', BOT)).toEqual({ command: 'new', args: '' }); // case-insensitive
    expect(parseTelegramCommand('/new@SomeOtherBot', BOT)).toBeNull();
  });

  test('parses the control commands and normalizes aliases', () => {
    expect(parseTelegramCommand('/status', BOT)).toEqual({ command: 'status', args: '' });
    expect(parseTelegramCommand('/agent', BOT)).toEqual({ command: 'agent', args: '' });
    expect(parseTelegramCommand('/model gpt', BOT)).toEqual({ command: 'model', args: 'gpt' });
    expect(parseTelegramCommand('/whoami', BOT)).toEqual({ command: 'status', args: '' });
    expect(parseTelegramCommand('/settings', BOT)).toEqual({ command: 'status', args: '' });
    expect(parseTelegramCommand('/config', BOT)).toEqual({ command: 'status', args: '' });
  });

  test('unknown commands and plain text flow through as messages', () => {
    expect(parseTelegramCommand('/frobnicate', BOT)).toBeNull();
    expect(parseTelegramCommand('just text', BOT)).toBeNull();
    expect(parseTelegramCommand(undefined, BOT)).toBeNull();
  });
});

describe('shouldRespondInChat', () => {
  test('private chats always respond', () => {
    expect(shouldRespondInChat(msg(), BOT, BOT_ID)).toBe(true);
  });

  test('groups: silent unless mentioned, replied-to, or commanded', () => {
    const plain = msg({ chatType: 'group', text: 'morning everyone' });
    expect(shouldRespondInChat(plain, BOT, BOT_ID)).toBe(false);

    const mention = msg({ chatType: 'group', text: `@${BOT} summarize this thread` });
    expect(shouldRespondInChat(mention, BOT, BOT_ID)).toBe(true);

    const mentionCased = msg({ chatType: 'supergroup', text: '@kortixbot ping' });
    expect(shouldRespondInChat(mentionCased, BOT, BOT_ID)).toBe(true);

    const replyToBot = msg({
      chatType: 'group',
      text: 'yes do that',
      reply_to_message: { from: { id: Number(BOT_ID), is_bot: true } },
    });
    expect(shouldRespondInChat(replyToBot, BOT, BOT_ID)).toBe(true);

    const replyToHuman = msg({
      chatType: 'group',
      text: 'yes do that',
      reply_to_message: { from: { id: 555 } },
    });
    expect(shouldRespondInChat(replyToHuman, BOT, BOT_ID)).toBe(false);

    const command = msg({ chatType: 'group', text: '/new' });
    expect(shouldRespondInChat(command, BOT, BOT_ID)).toBe(true);
  });

  test('channel posts and unknown chat types are ignored', () => {
    expect(shouldRespondInChat(msg({ chatType: 'channel' }), BOT, BOT_ID)).toBe(false);
  });
});

describe('stripBotMention', () => {
  test('removes the bot mention wherever it appears', () => {
    expect(stripBotMention(`@${BOT} do the thing`, BOT)).toBe('do the thing');
    expect(stripBotMention(`do the thing @${BOT} please`, BOT)).toBe('do the thing please');
  });

  test('does not mangle other mentions or bare text', () => {
    expect(stripBotMention('ask @SomeoneElse about it', BOT)).toBe('ask @SomeoneElse about it');
    expect(stripBotMention('plain request', null)).toBe('plain request');
  });
});

describe('prompt rendering', () => {
  test('agent prompt carries chat context and the cleaned message', () => {
    const p = renderTelegramAgentPrompt(
      msg({ text: `@${BOT} check the deploy`, chat: { id: -9, type: 'group', title: 'Ops' } }),
      BOT,
    );
    expect(p).toContain('-9 (group — Ops)');
    expect(p).toContain('@ivan');
    expect(p).toContain('check the deploy');
    expect(p).not.toContain(`@${BOT}`);
    // The turn contract: progress via `telegram step`, answer via `telegram send`.
    expect(p).toContain('telegram step');
    expect(p).toContain('telegram send');
    expect(p).toContain('no token');
  });

  test('follow-up prompt names the sender and keeps instructions', () => {
    const p = renderTelegramFollowUpPrompt(msg({ text: 'and also the logs' }), BOT);
    expect(p).toContain('New message from @ivan');
    expect(p).toContain('and also the logs');
  });

  test('non-text payloads degrade gracefully', () => {
    const p = renderTelegramAgentPrompt(msg({ text: undefined, caption: undefined }), BOT);
    expect(p).toContain('(non-text payload)');
  });
});

describe('attachments', () => {
  test('photos collapse to the largest rendition; every kind surfaces', () => {
    const files = messageAttachments(
      msg({
        document: { file_id: 'DOC1', file_name: 'report.pdf', file_size: 2048 },
        photo: [
          { file_id: 'P-small', file_size: 100 },
          { file_id: 'P-large', file_size: 90000 },
        ],
        voice: { file_id: 'V1', file_size: 5000 },
      }),
    );
    expect(files.map((f) => f.file.file_id)).toEqual(['DOC1', 'P-large', 'V1']);
  });

  test('describeAttachments names files, sizes, ids, and the download hint', () => {
    const d = describeAttachments(
      msg({ document: { file_id: 'DOC1', file_name: 'report.pdf', file_size: 2 * 1024 * 1024 } }),
    );
    expect(d).toContain('document "report.pdf" (2.0 MB) — file_id: DOC1');
    expect(d).toContain('telegram download --file-id');
  });

  test('a caption-only file message flows into the prompt with its attachment block', () => {
    const p = renderTelegramAgentPrompt(
      msg({
        text: undefined,
        caption: 'please summarize',
        document: { file_id: 'DOC9', file_name: 'notes.txt' },
      }),
      BOT,
    );
    expect(p).toContain('please summarize');
    expect(p).toContain('file_id: DOC9');
  });

  test('no attachments → no attachment block', () => {
    expect(describeAttachments(msg())).toBe('');
    expect(renderTelegramAgentPrompt(msg(), BOT)).not.toContain('Attached files');
  });
});

describe('renderTelegramStatus', () => {
  test('shows project, overrides, policy, and paired count', () => {
    const html = renderTelegramStatus({
      botUsername: 'KortixBot',
      projectName: 'Acme',
      agentName: 'reviewer',
      model: 'anthropic/claude-sonnet-5',
      conversationPolicy: 'project_open',
      pairedUserCount: 3,
      groupMentionsEnabled: true,
    });
    expect(html).toContain('Acme');
    expect(html).toContain('reviewer');
    expect(html).toContain('claude-sonnet-5'); // namespace stripped
    expect(html).toContain('open to everyone');
    expect(html).toContain('@KortixBot · 3 paired');
    expect(html).toContain('<b>Mentions:</b> visible in groups');
  });

  test('falls back to defaults when nothing is overridden', () => {
    const html = renderTelegramStatus({
      botUsername: null,
      projectName: 'P',
      agentName: null,
      model: null,
      conversationPolicy: null,
      pairedUserCount: 0,
      groupMentionsEnabled: null,
    });
    expect(html).toContain('<b>Agent:</b> default');
    expect(html).toContain('<b>Model:</b> project default');
    expect(html).not.toContain('paired');
    expect(html).not.toContain('Mentions'); // unknown → no line, no false warning
  });

  test('escapes HTML in project/agent names', () => {
    const html = renderTelegramStatus({
      botUsername: null,
      projectName: '<b>evil</b>',
      agentName: 'a & b',
      model: null,
      conversationPolicy: null,
      pairedUserCount: 0,
      groupMentionsEnabled: null,
    });
    expect(html).not.toContain('<b>evil</b>');
    expect(html).toContain('&lt;b&gt;evil&lt;/b&gt;');
    expect(html).toContain('a &amp; b');
  });

  test('privacy mode ON surfaces the warning with the BotFather fix', () => {
    const html = renderTelegramStatus({
      botUsername: 'KortixBot',
      projectName: 'Acme',
      agentName: null,
      model: null,
      conversationPolicy: null,
      pairedUserCount: 1,
      groupMentionsEnabled: false,
    });
    expect(html).toContain('<b>Mentions:</b> hidden in groups');
    expect(html).toContain('/setprivacy');
    expect(html).not.toContain('visible in groups');
  });
});

describe('telegramGroupWelcomeText', () => {
  test('privacy mode ON: no @mention promise, working paths + owner fix instead', () => {
    const text = telegramGroupWelcomeText(false);
    expect(text).toBe(TELEGRAM_GROUP_WELCOME_PRIVACY_TEXT);
    expect(text).not.toContain('@mention me or reply');
    expect(text).toContain('reply to one of my messages');
    expect(text).toContain('/setprivacy');
    expect(text).toContain('re-add');
  });

  test('privacy mode OFF (and unknown) promise mentions as before', () => {
    expect(telegramGroupWelcomeText(true)).toBe(TELEGRAM_GROUP_WELCOME_TEXT);
    expect(telegramGroupWelcomeText(null)).toBe(TELEGRAM_GROUP_WELCOME_TEXT);
    expect(TELEGRAM_GROUP_WELCOME_TEXT).toContain('@mention me');
  });
});

describe('botJustAddedToGroup', () => {
  const ev = (over: Record<string, unknown> = {}) => ({
    chat: { id: -100, type: 'supergroup' },
    new_chat_member: { status: 'member' },
    old_chat_member: { status: 'left' },
    ...over,
  });

  test('true when the bot enters a group from a non-present state', () => {
    expect(botJustAddedToGroup(ev())).toBe(true);
    expect(botJustAddedToGroup(ev({ new_chat_member: { status: 'administrator' } }))).toBe(true);
    expect(botJustAddedToGroup(ev({ old_chat_member: { status: 'kicked' } }))).toBe(true);
  });

  test('false for re-adds, promotions, leaves, and private chats', () => {
    expect(botJustAddedToGroup(ev({ old_chat_member: { status: 'member' } }))).toBe(false); // promotion
    expect(botJustAddedToGroup(ev({ new_chat_member: { status: 'left' } }))).toBe(false); // removed
    expect(botJustAddedToGroup(ev({ chat: { id: 1, type: 'private' } }))).toBe(false);
  });
});
