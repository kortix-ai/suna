import { escapeMrkdwn } from './util';

// Agent-authored text arrives in GitHub-flavored Markdown more often than the
// skill prompt can prevent, and Slack renders that syntax literally (** stays
// **, [label](url) stays brackets). Normalize at the relay choke point so the
// prompt is guidance, not the only line of defense. Text that is already valid
// mrkdwn passes through unchanged.

const CODE_SLOT = '\uE000';

function stashCode(input: string, slots: string[]): string {
  return input
    .replace(/```[\s\S]*?```/g, (m) => `${CODE_SLOT}${slots.push(m) - 1}${CODE_SLOT}`)
    .replace(/`[^`\n]+`/g, (m) => `${CODE_SLOT}${slots.push(m) - 1}${CODE_SLOT}`);
}

function restoreCode(input: string, slots: string[]): string {
  return input.replace(new RegExp(`${CODE_SLOT}(\\d+)${CODE_SLOT}`, 'g'), (_, i) => slots[Number(i)] ?? '');
}

export function markdownToMrkdwn(input: string): string {
  if (!input) return input;
  const slots: string[] = [];
  let text = stashCode(input, slots);
  // Links/images before bold so `**x**` inside a label converts in place.
  text = text.replace(/!?\[([^\]]+)\]\(<?(https?:\/\/[^)\s>]+)>?(?:\s+"[^"]*")?\)/g, '<$2|$1>');
  text = text.replace(/\*\*(.+?)\*\*/g, '*$1*');
  text = text.replace(/(^|[^_\w])__(?!_)(.+?)__(?!_)/g, '$1*$2*');
  text = text.replace(/~~(.+?)~~/g, '~$1~');
  text = text.replace(/^#{1,6}[^\S\n]+(.+?)[^\S\n]*#*[^\S\n]*$/gm, '*$1*');
  // Bold ran first, so a surviving `* ` / `- ` / `+ ` at line start is a list marker.
  text = text.replace(/^([ \t]*)[-*+][^\S\n]+/gm, '$1• ');
  return restoreCode(text, slots);
}

// Plan-task `details`/`output` render via chat.update as rich_text, which does
// NOT parse mrkdwn — a `<url|label>` link (the syntax the skill instructs) or
// `*bold*` posted as a plain text element shows up literally. Tokenize the
// mrkdwn into real rich_text elements instead.
export type RichTextElement =
  | { type: 'text'; text: string; style?: { bold?: boolean; code?: boolean } }
  | { type: 'link'; url: string; text?: string }
  | { type: 'channel'; channel_id: string };

// The inputs are step details and outputs, capped at 500 characters before
// they are rendered, which bounds the `[^>]*` scans.
const MRKDWN_TOKEN = /<(https?:\/\/[^|>\s]+)(?:\|([^>]*))?>|<#([CG][A-Z0-9]+)(?:\|[^>]*)?>|\*([^*\n]+)\*|`([^`\n]+)`/g;

export function mrkdwnToRichTextElements(input: string): RichTextElement[] {
  const elements: RichTextElement[] = [];
  let last = 0;
  for (const m of input.matchAll(MRKDWN_TOKEN)) {
    const idx = m.index ?? 0;
    if (idx > last) elements.push({ type: 'text', text: input.slice(last, idx) });
    const [, url, label, channel, bold, code] = m;
    if (url) elements.push({ type: 'link', url, ...(label ? { text: label } : {}) });
    // A channel element renders `#name` by each viewer's access and notifies no one.
    else if (channel) elements.push({ type: 'channel', channel_id: channel });
    else if (bold !== undefined) elements.push({ type: 'text', text: bold, style: { bold: true } });
    else if (code !== undefined) elements.push({ type: 'text', text: code, style: { code: true } });
    last = idx + m[0].length;
  }
  if (last < input.length) elements.push({ type: 'text', text: input.slice(last) });
  if (elements.length === 0) elements.push({ type: 'text', text: input });
  return elements;
}

const UNLABELLED_MENTION = /<@([UW][A-Z0-9]+)>/g;

/** The user ids of `<@U…>` mentions that carry no label, each once. */
export function unlabelledMentionIds(...texts: Array<string | undefined>): string[] {
  const ids = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(UNLABELLED_MENTION)) ids.add(m[1]!);
  }
  return [...ids];
}

/** `<!here>` and its kin as text: a broadcast in a plan step would notify the channel. */
function specialMentionText(target: string, label: string): string {
  const name = target.slice(1).split('^')[0] ?? '';
  if (name === 'here' || name === 'channel' || name === 'everyone') return `@${name}`;
  if (label) return label;
  return name === 'subteam' ? '@group' : `@${name}`;
}

/**
 * Slack mention markup as text that notifies no one. `<@U…|Sam>` and `<@U…>`
 * become `@Sam`: the label, else the name in `names`, else the id. Broadcasts
 * become `@here`, `@channel`, `@everyone`; a user group its label; a date its
 * fallback. Channel references, links and any other markup stay as written.
 *
 * One pass: each scan stays inside `[i, close]`, and the next starts after it.
 */
export function slackMentionsAsText(text: string, names: ReadonlyMap<string, string>): string {
  let out = '';
  let i = 0;
  for (;;) {
    const first = text.indexOf('<', i);
    const close = first < 0 ? -1 : text.indexOf('>', first + 1);
    if (close < 0) break;
    const open = text.lastIndexOf('<', close);
    const inner = text.slice(open + 1, close);
    const bar = inner.indexOf('|');
    const target = bar < 0 ? inner : inner.slice(0, bar);
    const label = bar < 0 ? '' : inner.slice(bar + 1);
    let shown: string | null = null;
    if (target.startsWith('@')) {
      const id = target.slice(1);
      const name = names.get(id);
      // A label is already mrkdwn text; a looked-up name is a person's raw display name.
      shown = `@${label || (name ? escapeMrkdwn(name) : id)}`;
    } else if (target.startsWith('!')) {
      shown = specialMentionText(target, label);
    }
    out += text.slice(i, open) + (shown ?? text.slice(open, close + 1));
    i = close + 1;
  }
  return out + text.slice(i);
}
