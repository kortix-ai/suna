/**
 * Kortix's chat replies as Discord messages: a command reply (core/commands.ts
 * `CommandReply`) and an agent question (core/questions.ts `QuestionMessage`)
 * become `content` and message components. Pure: no network, no database.
 *
 * Discord's limits: 2000 characters of content; at most 5 action rows of at
 * most 5 buttons, or 1 select menu, each; a label 80 characters, a select
 * option's 100; a `custom_id` or option value 100 characters.
 */
import type { RuntimeQuestion } from '@kortix/api-contract/transcript';
import { CHANNELS } from '@kortix/shared/channel-descriptors';
import type { CommandReply } from '../core/commands';
import { type CommandPress, pressData } from '../core/command-press';
import type { QuestionFooter, QuestionMessage, QuestionTapReply } from '../core/questions';

export const DISCORD_MESSAGE_CHARS = CHANNELS.discord.messageChars;

/** Component types and button styles (discord.com/developers/docs/components). */
const ROW = 1;
const BUTTON = 2;
const STRING_SELECT = 3;
const STYLE = { primary: 1, secondary: 2, success: 3, link: 5 } as const;

export interface DiscordButton {
  type: typeof BUTTON;
  style: number;
  label: string;
  custom_id?: string;
  url?: string;
}

export interface DiscordSelect {
  type: typeof STRING_SELECT;
  custom_id: string;
  placeholder?: string;
  options: Array<{ label: string; value: string; default?: boolean }>;
}

export interface DiscordRow {
  type: typeof ROW;
  components: Array<DiscordButton | DiscordSelect>;
}

export interface DiscordMessageBody {
  content: string;
  components: DiscordRow[];
}

/** The `custom_id` of a command reply's select menu: a pick's token is the chosen option's value. */
export const COMMAND_SELECT_ID = 'kc-select';

/** At most `max` UTF-16 units, never half an emoji. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`;
}

const button = (label: string, customId: string, style: number = STYLE.secondary): DiscordButton => ({
  type: BUTTON,
  style,
  label: clip(label, 80),
  custom_id: customId,
});

/** Buttons in rows of at most 5. */
function rowsOf(buttons: DiscordButton[]): DiscordRow[] {
  const rows: DiscordRow[] = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push({ type: ROW, components: buttons.slice(i, i + 5) });
  return rows;
}

/**
 * A command reply: its text, a select menu for a list's options (a pick's
 * token is the option's value), then a row for the page turns and one for the
 * actions, and a panel's https link as a link button. Any other link is the
 * last text line.
 */
export function discordCommandMessage(reply: CommandReply): DiscordMessageBody {
  const lines: string[] = [];
  const rows: DiscordRow[] = [];
  switch (reply.kind) {
    case 'notice':
      lines.push(reply.text);
      break;
    case 'panel':
      lines.push(`**${reply.title}**`, ...reply.rows.map((r) => `${r.label}: ${r.value}`));
      break;
    case 'choices': {
      lines.push(`**${reply.title}**${reply.pages > 1 ? ` (page ${reply.page + 1} of ${reply.pages})` : ''}`, reply.usage);
      if (reply.options.length) {
        rows.push({
          type: ROW,
          components: [
            {
              type: STRING_SELECT,
              custom_id: COMMAND_SELECT_ID,
              placeholder: 'Pick one',
              // A select holds 25 options; a page holds fewer.
              options: reply.options.slice(0, 25).map((o) => ({
                label: clip(o.label, 100),
                value: pressData(o.press),
                ...(o.current ? { default: true } : {}),
              })),
            },
          ],
        });
      }
      const turn = [
        ...(reply.back ? [button('‹ Back', pressData(reply.back))] : []),
        ...(reply.more ? [button('More ›', pressData(reply.more))] : []),
      ];
      if (turn.length) rows.push({ type: ROW, components: turn });
      break;
    }
    case 'help':
      lines.push(reply.intro, ...reply.commands.map((c) => `\`${c.usage}\` — ${c.description}`), reply.footer);
      break;
  }
  const actions = (reply.actions ?? []).map((a) => button(a.label, pressData(a.press as CommandPress)));
  rows.push(...rowsOf(actions));
  const url = 'url' in reply ? reply.url : undefined;
  if (url && reply.kind === 'panel' && url.startsWith('https://')) {
    rows.push({ type: ROW, components: [{ type: BUTTON, style: STYLE.link, label: 'Open in Kortix', url }] });
  } else if (url) lines.push(url);
  const text = reply.note ? `${lines.join('\n')}\n\n${reply.note}` : lines.join('\n');
  return { content: clip(text, DISCORD_MESSAGE_CHARS), components: rows.slice(0, 5) };
}

/** A question message's last line; a tap's notice uses the same words. */
export function discordQuestionFooter(footer: QuestionFooter | QuestionTapReply): string {
  switch (footer.kind) {
    case 'ask':
      return footer.buttons
        ? 'Pick an option, or reply in this conversation with your own answer.'
        : `Reply in this conversation with your answer${footer.numbered ? ', each question by its number' : ''}.`;
    case 'step':
      return `${footer.many ? 'Pick each option you want, then Done' : 'Pick an option'}${footer.typed ? ', or type your own answer' : ''}.`;
    case 'already_answered':
      return 'This question was already answered.';
    case 'none_ticked':
      return 'Pick at least one option first.';
    case 'answered':
      return `Answered: ${footer.label}`;
    case 'answered_in_chat':
      return 'Answered in the conversation.';
    case 'new_conversation':
      return 'A new conversation started.';
    case 'earlier':
      return 'This question is from an earlier conversation. Send your answer as a message.';
  }
}

/**
 * Questions as message text: each question with its numbered options, then the
 * footer. `step`: one question of several, under "Question <at> of <count>".
 */
export function discordQuestionText(questions: RuntimeQuestion[], footer: string, step?: QuestionMessage['step']): string {
  const title = (q: RuntimeQuestion, i: number) =>
    step
      ? `**Question ${step.at} of ${step.count}${q.header ? ` · ${q.header}` : ''}**\n${q.question}`
      : `${questions.length > 1 ? `${i + 1}) ` : ''}${q.header ? `**${q.header}**: ` : ''}${q.question}`;
  const body = questions
    .map((q, i) =>
      [
        `${title(q, i)}${q.multiple ? ' (pick one or more)' : ''}`,
        ...q.options.map((o, j) => `${j + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`),
      ].join('\n'),
    )
    .join('\n\n');
  const tail = `\n\n${clip(footer, 190)}`;
  return `${clip(body, DISCORD_MESSAGE_CHARS - tail.length)}${tail}`;
}

/**
 * An agent question: one option a row (✓ and green when ticked), then one row
 * for ‹ Back, More › and Done: at most 4 options a page (`CHANNELS.discord.buttons.max`).
 */
export function discordQuestionMessage(m: QuestionMessage): DiscordMessageBody {
  const content = m.questions.length ? discordQuestionText(m.questions, discordQuestionFooter(m.footer), m.step) : discordQuestionFooter(m.footer);
  if (!m.buttons) return { content, components: [] };
  const options = m.buttons.map((b) =>
    ({ type: ROW, components: [button(`${b.ticked ? '✓ ' : ''}${b.label}`, b.data, b.ticked ? STYLE.success : STYLE.secondary)] }) as DiscordRow,
  );
  const last = [
    ...(m.back ? [button('‹ Back', m.back)] : []),
    ...(m.more ? [button('More ›', m.more)] : []),
    ...(m.done ? [button('Done ›', m.done, STYLE.primary)] : []),
  ];
  return { content, components: [...options, ...(last.length ? [{ type: ROW, components: last } as DiscordRow] : [])].slice(0, 5) };
}
