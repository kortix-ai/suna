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
  | { type: 'link'; url: string; text?: string };

const MRKDWN_TOKEN = /<(https?:\/\/[^|>\s]+)(?:\|([^>]*))?>|\*([^*\n]+)\*|`([^`\n]+)`/g;

export function mrkdwnToRichTextElements(input: string): RichTextElement[] {
  const elements: RichTextElement[] = [];
  let last = 0;
  for (const m of input.matchAll(MRKDWN_TOKEN)) {
    const idx = m.index ?? 0;
    if (idx > last) elements.push({ type: 'text', text: input.slice(last, idx) });
    const [, url, label, bold, code] = m;
    if (url) elements.push({ type: 'link', url, ...(label ? { text: label } : {}) });
    else if (bold !== undefined) elements.push({ type: 'text', text: bold, style: { bold: true } });
    else if (code !== undefined) elements.push({ type: 'text', text: code, style: { code: true } });
    last = idx + m[0].length;
  }
  if (last < input.length) elements.push({ type: 'text', text: input.slice(last) });
  if (elements.length === 0) elements.push({ type: 'text', text: input });
  return elements;
}
